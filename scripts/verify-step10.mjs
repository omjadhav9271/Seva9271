/*
  Verifies Step-10 (structured bargaining v1) against the LIVE Supabase DB.
  Run AFTER `supabase db push` of 20260804120000_seva_bargaining.sql.

  Account mapping:
    PROVIDER_EMAIL = test1 → owns the negotiable provider row
    CUSTOMER_EMAIL = test2 → makes the offers
    STRANGER_EMAIL = test3 → a third party (admin), used for isolation checks

  What it checks:
    (a) 🔴 THE FLOOR IS INVISIBLE — anon, the customer, and every RPC return path. The provider
        reads their own floor only through my_provider_profile.
    (b) AUTO-ACCEPT at or above the threshold, with the price locked server-side.
    (c) BELOW THE FLOOR is declined in language that leaks nothing, and ENDS the negotiation.
    (d) THE MIDDLE goes to the provider, who can counter; the customer accepts; price locks.
    (e) TURN-TAKING, ROUND CAP, EXPIRY.
    (f) ANTI-PROBING — a customer cannot binary-search the floor across fresh bookings.
    (g) A booking under negotiation is UNPAYABLE (price_agreed stays NULL).
    (h) A FAILED HAGGLE MOVES NEITHER REPUTATION — otherwise providers turn bargaining off.

  Usage — credentials come from .env.local (see .env.example):
    node scripts/verify-step10.mjs
*/
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { cred } from './lib/creds.mjs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };
const errMsg = (e) => (e && (e.message || JSON.stringify(e))) || '';
const denied = (e) => e && (e.code === '42501' || /permission denied|row-level security|not authorized/i.test(errMsg(e)));

console.log('DB:', URL, '\n');
if (!SERVICE) { console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY not in .env.local.'); process.exit(0); }
const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

async function authClient(prefix) {
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = cred(`${prefix}_EMAIL`), password = cred(`${prefix}_PASSWORD`);
  if (!email) return { client, userId: null };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) { console.log(`${prefix} signIn error:`, error.message); return { client, userId: null }; }
  return { client, userId: data?.user?.id ?? null };
}

console.log('[sessions]');
const { client: providerClient, userId: providerUser } = await authClient('PROVIDER');
const { client: customer, userId: customerId } = await authClient('CUSTOMER');
const { client: stranger, userId: strangerId } = await authClient('STRANGER');
// OPTIONAL fourth session: a signed-in NON-ADMIN who is not a party to the booking. STRANGER_* is
// the admin, who may legitimately read offers for dispute handling, so it can never prove the
// isolation in (e) below. Without this account that case is untested — not merely unasserted.
// Unset is fine: authClient returns userId null and (e) degrades to the old skip.
const { client: outsider, userId: outsiderId } = await authClient('OUTSIDER');
console.log('  provider:', providerUser ?? 'NONE', '| customer:', customerId ?? 'NONE', '| stranger:', strangerId ?? 'NONE',
  '| outsider:', outsiderId ?? 'not configured', '\n');
if (!providerUser || !customerId || !strangerId) { console.log('Cannot run: need three sessions.'); process.exit(0); }

// ---------------------------------------------------------------- preflight + fixture
const LIST = 600, FLOOR = 400, THRESHOLD = 550;
let providerId = null, original = null, repBefore = null;
{
  const { error } = await service.from('offers').select('id').limit(1);
  if (error) { console.log('Cannot run: offers table missing (' + error.message + '). Did you db push?'); process.exit(1); }
  const { data: sp } = await service.from('service_providers')
    .select('id, pricing_mode, list_price, floor_price, auto_accept_threshold, max_counter_rounds, reputation_score, status')
    .eq('user_id', providerUser).maybeSingle();
  if (!sp) { console.log('Cannot run: the provider account owns no provider row.'); process.exit(1); }
  if (sp.status !== 'approved') { console.log('Cannot run: provider is not approved.'); process.exit(1); }
  providerId = sp.id;
  original = { pricing_mode: sp.pricing_mode, list_price: sp.list_price, floor_price: sp.floor_price,
               auto_accept_threshold: sp.auto_accept_threshold, max_counter_rounds: sp.max_counter_rounds };
  repBefore = Number(sp.reputation_score);
  await service.from('service_providers').update({
    pricing_mode: 'negotiable', list_price: LIST, floor_price: FLOOR,
    auto_accept_threshold: THRESHOLD, max_counter_rounds: 3,
  }).eq('id', providerId);
  console.log(`  fixture: list ₹${LIST}, hidden floor ₹${FLOOR}, auto-accept ≥ ₹${THRESHOLD}\n`);
}

// 🔴 Never bound a window with this machine's clock. `created_at` is stamped by the DB, and the
// two clocks differ (measured: the DB runs ~1.4s ahead of this laptop). A local lower bound on a
// DB-stamped column therefore reaches ~1.4s further into the past than intended — which silently
// pulled the PREVIOUS phase's notification into phase (c) and failed the dead-lowball assertion
// against correct product behaviour. Every anchor below is a DB-stamped value instead: the offer
// row's own created_at. Notifications raised by a negotiation are written in the same transaction
// as its offer, so they share that timestamp exactly and `gte` catches them inclusively.
let runAnchor = null;   // DB time of the first offer this run created; set in offer()
const bookingIds = [];
const offerOf = (d) => (Array.isArray(d) ? d[0] : d) ?? null;
const bookingOf = async (id) => (await service.from('bookings')
  .select('id, status, price_agreed, total_amount').eq('id', id).maybeSingle()).data;
const offersOf = async (bkId) => (await service.from('offers')
  .select('round, actor_role, amount, status').eq('booking_id', bkId).order('round')).data ?? [];

// start a negotiation and remember the booking for cleanup
async function offer(amount) {
  const res = await customer.rpc('start_negotiation', {
    p_provider_id: providerId, p_amount: amount, p_service_type: 'one-time',
    p_scheduled_date: '2026-10-01', p_scheduled_time: '11:00', p_duration_hours: 2,
    p_notes: 'step10 verify', p_address: 'Andheri',
  });
  const o = offerOf(res.data);
  if (o?.booking_id) bookingIds.push(o.booking_id);
  if (o?.created_at && !runAnchor) runAnchor = o.created_at;
  return { res, o };
}
// keep the 3-per-day anti-probe cap from firing during the functional cases
async function clearNegotiations() {
  const { data } = await service.from('bookings').select('id')
    .eq('customer_id', customerId).eq('provider_id', providerId)
    .in('status', ['negotiating', 'expired']);
  for (const b of data ?? []) {
    await service.from('booking_events').delete().eq('booking_id', b.id);
    await service.from('bookings').delete().eq('id', b.id);
  }
}

try {
  // ================= (a) the floor is invisible =================
  console.log('[a) 🔴 the hidden floor cannot be read by anyone but its owner]');
  {
    const anonRead = await anon.from('service_providers').select('id, floor_price').eq('id', providerId);
    if (denied(anonRead.error)) ok('anon cannot select floor_price: ' + errMsg(anonRead.error));
    else no('ANON READ THE FLOOR: ' + JSON.stringify(anonRead.error ?? anonRead.data));

    const custRead = await customer.from('service_providers').select('id, floor_price').eq('id', providerId);
    if (denied(custRead.error)) ok('a signed-in customer cannot select floor_price');
    else no('CUSTOMER READ THE FLOOR: ' + JSON.stringify(custRead.error ?? custRead.data));

    const publicBits = await customer.from('service_providers')
      .select('id, pricing_mode, list_price, auto_accept_threshold, max_counter_rounds').eq('id', providerId).maybeSingle();
    if (!publicBits.error && Number(publicBits.data?.list_price) === LIST)
      ok('...but the list price and the rules of the game ARE public');
    else no('public pricing columns not readable: ' + errMsg(publicBits.error));

    const own = await providerClient.from('my_provider_profile')
      .select('floor_price, pricing_mode').maybeSingle();
    if (!own.error && Number(own.data?.floor_price) === FLOOR)
      ok('the provider reads their OWN floor through my_provider_profile');
    else no('provider cannot read own floor: ' + errMsg(own.error));

    const setFloor = await providerClient.from('service_providers')
      .update({ floor_price: FLOOR }).eq('id', providerId).select('id');
    if (!setFloor.error) ok('the provider can SET their own floor (update grant)');
    else no('provider cannot set own floor: ' + errMsg(setFloor.error));

    // a customer must not be able to write pricing on someone else's row
    const hijack = await customer.from('service_providers')
      .update({ floor_price: 1 }).eq('id', providerId).select('id');
    if (hijack.error || (hijack.data ?? []).length === 0) ok('a customer cannot write another provider\'s pricing');
    else no('customer rewrote the provider\'s floor');
  }

  // ================= (b) auto-accept =================
  console.log('\n[b) an offer at or above the threshold is accepted immediately]');
  {
    await clearNegotiations();
    const { res, o } = await offer(THRESHOLD);
    if (res.error) no('start_negotiation failed: ' + errMsg(res.error));
    else {
      const b = await bookingOf(o.booking_id);
      if (o.status === 'accepted' && b.status === 'accepted') ok(`₹${THRESHOLD} ≥ threshold → auto-accepted`);
      else no(`not auto-accepted: offer=${o.status}, booking=${b.status}`);
      if (Number(b.price_agreed) === THRESHOLD)
        ok(`the agreed price locked SERVER-SIDE into price_agreed (₹${b.price_agreed})`);
      else no(`price_agreed wrong: ${b.price_agreed}`);
    }
  }

  // ================= (c) below the floor =================
  console.log('\n[c) below the hidden floor: declined, uniform, and the negotiation ends]');
  {
    await clearNegotiations();
    const { res, o } = await offer(FLOOR - 100);
    if (res.error) { no('below-floor offer errored: ' + errMsg(res.error)); }
    else {
      const b = await bookingOf(o.booking_id);
      if (o.status === 'declined' && b.status === 'expired') ok('below-floor offer declined and the negotiation ENDED');
      else no(`below-floor handling wrong: offer=${o.status}, booking=${b.status}`);

      // Assert on the DECLINE notification specifically. Reading "the newest one" used to pass
      // vacuously off the generic 'Booking status is now "expired"' the event trigger emitted in
      // the same transaction — same created_at, so which one won was a coin toss.
      const { data: notes } = await service.from('notifications').select('title, message')
        .eq('user_id', customerId).gte('created_at', o.created_at);
      const decline = (notes ?? []).find((n) => n.title === 'Offer not accepted');
      if (decline) ok(`the customer is told, in uniform copy: "${decline.message}"`);
      else no('no decline notification reached the customer: ' + JSON.stringify(notes));

      // NOTHING the customer receives may hint at the distance to the floor.
      const leaky = (notes ?? []).filter((n) =>
        /\b400\b|minimum|floor|too low|below|higher|increase/i.test(n.title + ' ' + n.message));
      if (leaky.length === 0) ok('...and nothing else the customer receives hints at the floor');
      else no('copy leaks the floor: ' + JSON.stringify(leaky));

      // HARD-2/3: the generic status notifier and the "new booking request" trigger must both
      // stand aside — a dead lowball should not reach the provider at all. Anchored to the offer's
      // own DB timestamp: with a local one this read the auto-accept notification from phase (b).
      const { data: provNotes } = await service.from('notifications').select('title, message')
        .eq('user_id', providerUser).gte('created_at', o.created_at);
      if ((provNotes ?? []).length === 0) ok('a below-floor probe never even reaches the provider');
      else no('the provider was notified about a dead lowball: ' + JSON.stringify(provNotes));
    }
  }

  // ================= (d) the middle: counter, then accept =================
  console.log('\n[d) between floor and threshold: the provider decides]');
  let midBooking = null;
  {
    await clearNegotiations();
    const { res, o } = await offer(450);
    if (res.error) no('mid offer failed: ' + errMsg(res.error));
    else {
      midBooking = o.booking_id;
      const b = await bookingOf(midBooking);
      if (o.status === 'pending' && b.status === 'negotiating') ok('₹450 sits pending with the provider');
      else no(`mid offer wrong: offer=${o.status}, booking=${b.status}`);
      if (b.price_agreed === null) ok('price_agreed stays NULL while negotiating — the booking is unpayable');
      else no('price_agreed was set during negotiation: ' + b.price_agreed);

      // the customer cannot answer their own offer
      const selfAnswer = await customer.rpc('respond_offer', { p_booking_id: midBooking, p_action: 'accept', p_amount: null });
      if (selfAnswer.error) ok('the customer cannot respond to their own offer: ' + errMsg(selfAnswer.error));
      else no('customer answered their own offer');

      // a non-party cannot respond at all
      const outsider = await stranger.rpc('respond_offer', { p_booking_id: midBooking, p_action: 'accept', p_amount: null });
      if (outsider.error) ok('a non-party cannot respond to the negotiation');
      else no('a stranger responded to the negotiation');

      // provider counters
      const counter = await providerClient.rpc('respond_offer', { p_booking_id: midBooking, p_action: 'counter', p_amount: 520 });
      if (counter.error) no('provider counter failed: ' + errMsg(counter.error));
      else {
        const rounds = await offersOf(midBooking);
        if (rounds.length === 2 && rounds[1].actor_role === 'provider' && Number(rounds[1].amount) === 520)
          ok('the provider countered at ₹520 (round 2)');
        else no('counter not recorded: ' + JSON.stringify(rounds));
      }

      // customer accepts → price locks
      const accept = await customer.rpc('respond_offer', { p_booking_id: midBooking, p_action: 'accept', p_amount: null });
      if (accept.error) no('customer accept failed: ' + errMsg(accept.error));
      else {
        const after = await bookingOf(midBooking);
        if (after.status === 'accepted' && Number(after.price_agreed) === 520)
          ok('the customer accepted → booking accepted with price_agreed ₹520');
        else no('accept did not lock the price: ' + JSON.stringify(after));
      }
    }
  }

  // ================= (e) offers are visible only to the parties =================
  console.log('\n[e) the round history is private to the parties]');
  if (midBooking) {
    const asCust = await customer.from('offers').select('id').eq('booking_id', midBooking);
    const asOutsider = await stranger.from('offers').select('id').eq('booking_id', midBooking);
    const asAnon = await anon.from('offers').select('id').eq('booking_id', midBooking);
    if ((asCust.data ?? []).length === 2) ok('a party sees the full round history');
    else no('party could not read offers: ' + JSON.stringify(asCust.error ?? asCust.data));
    // test3 is the admin, who is allowed to see everything for dispute handling
    if ((asAnon.data ?? []).length === 0) ok('anon sees no offers');
    else no('ANON read the offers');
    // The case that actually matters: a signed-in stranger who is NOT an admin. Anon is covered
    // above and the parties are covered too, so without this an RLS change that exposed offers to
    // every authenticated user would pass this file clean.
    if (outsiderId) {
      const asNonAdmin = await outsider.from('offers').select('id').eq('booking_id', midBooking);
      if ((asNonAdmin.data ?? []).length === 0) ok('a signed-in NON-ADMIN outsider sees no offers');
      else no(`🔴 a signed-in non-party read ${(asNonAdmin.data ?? []).length} offer(s) — the round history is not private`);
    } else {
      sk('no OUTSIDER_* account configured — the signed-in non-admin stranger case is UNTESTED');
    }
    if ((asOutsider.data ?? []).length > 0) sk('STRANGER_EMAIL is the admin — admin offer access is intentional');
    else ok('a non-party non-admin sees no offers');
  }

  // ================= (f) round cap =================
  console.log('\n[f) rounds are capped]');
  {
    await clearNegotiations();
    const { o } = await offer(450);
    if (!o) no('could not start a negotiation for the round-cap test');
    else {
      await providerClient.rpc('respond_offer', { p_booking_id: o.booking_id, p_action: 'counter', p_amount: 520 });   // r2
      await customer.rpc('respond_offer', { p_booking_id: o.booking_id, p_action: 'counter', p_amount: 470 });         // r3
      const over = await providerClient.rpc('respond_offer', { p_booking_id: o.booking_id, p_action: 'counter', p_amount: 500 });
      if (over.error && /counters left/i.test(errMsg(over.error))) ok('a 4th counter is refused: ' + errMsg(over.error));
      else no('round cap not enforced: ' + JSON.stringify(over.error ?? over.data));

      // exhausting the counters stops the branching, not the deal — the standing offer must
      // still be acceptable (and the refusal must not have rolled the negotiation into limbo)
      const mid = await bookingOf(o.booking_id);
      if (mid.status === 'negotiating') ok('...and the negotiation is still open to accept or decline');
      else no('a refused counter left the booking at ' + mid.status);
      const acc = await providerClient.rpc('respond_offer', { p_booking_id: o.booking_id, p_action: 'accept', p_amount: null });
      const closed = await bookingOf(o.booking_id);
      if (!acc.error && closed.status === 'accepted' && Number(closed.price_agreed) === 470)
        ok('the standing offer can still be accepted after the counters run out (₹470)');
      else no('could not accept the standing offer: ' + (errMsg(acc.error) || JSON.stringify(closed)));
    }
  }

  // ================= (g) expiry sweep =================
  console.log('\n[g) an abandoned negotiation expires]');
  {
    await clearNegotiations();
    const { o } = await offer(450);
    if (!o) no('could not start a negotiation for the expiry test');
    else {
      await service.from('offers').update({ expires_at: new Date(Date.now() - 3600e3).toISOString() }).eq('id', o.id);
      const swept = await service.rpc('expire_stale_offers');
      if (swept.error) no('expire_stale_offers failed: ' + errMsg(swept.error));
      const rounds = await offersOf(o.booking_id);
      const b = await bookingOf(o.booking_id);
      if (rounds[0].status === 'expired' && b.status === 'expired') ok('the stale offer and its booking are closed by the sweep');
      else no(`sweep left offer=${rounds[0].status}, booking=${b.status}`);

      // HARD-4: the sweep used to close the booking silently — no event, no notification.
      const { data: evs } = await service.from('booking_events')
        .select('to_status, actor_role, meta').eq('booking_id', o.booking_id).eq('to_status', 'expired');
      if ((evs ?? []).length === 1 && evs[0].actor_role === 'system')
        ok('...and logs a system booking_event, so the audit trail has no hole');
      else no('sweep left no/duplicate audit event: ' + JSON.stringify(evs));

      const { data: swNotes } = await service.from('notifications')
        .select('user_id, title').gte('created_at', o.created_at).eq('title', 'Offer expired');
      const told = new Set((swNotes ?? []).map((n) => n.user_id));
      if (told.has(customerId) && told.has(providerUser))
        ok('...and both parties are told the offer lapsed');
      else no('the sweep did not notify both parties: ' + JSON.stringify(swNotes));
    }
  }

  // ================= (h) anti-probing =================
  console.log('\n[h) a customer cannot binary-search the floor]');
  {
    await clearNegotiations();
    for (let i = 0; i < 3; i++) await offer(FLOOR - 50 - i);   // three probes, each ends the negotiation
    const fourth = await offer(FLOOR - 10);
    if (fourth.res.error && /too many offers/i.test(errMsg(fourth.res.error)))
      ok('the 4th offer to the same provider in 24h is refused: ' + errMsg(fourth.res.error));
    else no('probing was not rate-limited: ' + JSON.stringify(fourth.res.error ?? 'allowed'));

    // 🔴 HARD-1: the cap counts the customer's own ('negotiating','expired') bookings, so if they
    // can DELETE those rows the cap resets and the binary search is free again. It used to be:
    // "delete_own_booking" survived from the initial schema, and offers cascade with the booking.
    const { data: mine } = await service.from('bookings').select('id')
      .eq('customer_id', customerId).eq('provider_id', providerId).in('status', ['negotiating', 'expired']);
    const ids = (mine ?? []).map((b) => b.id);
    const del = await customer.from('bookings').delete().in('id', ids).select('id');
    const { count: left } = await service.from('bookings').select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId).eq('provider_id', providerId).in('status', ['negotiating', 'expired']);
    if ((del.data ?? []).length === 0 && left === ids.length)
      ok(`a customer cannot delete their own bookings to wipe the trail (${ids.length} still on record)`);
    else no(`🔴 the customer deleted ${(del.data ?? []).length} of their own bookings — the probe cap resets`);

    const afterDelete = await offer(FLOOR - 10);
    if (afterDelete.res.error && /too many offers/i.test(errMsg(afterDelete.res.error)))
      ok('...so the cap still holds after the attempt');
    else no('🔴 the cap was reset — floor_price can be binary-searched for free');
  }

  // ================= (i) fixed-price providers are not negotiable =================
  console.log('\n[i) a fixed-price provider cannot be haggled with]');
  {
    await clearNegotiations();
    await service.from('service_providers').update({ pricing_mode: 'fixed' }).eq('id', providerId);
    const res = await customer.rpc('start_negotiation', { p_provider_id: providerId, p_amount: 500,
      p_service_type: 'one-time', p_scheduled_date: '2026-10-01', p_scheduled_time: '11:00',
      p_duration_hours: 2, p_notes: null, p_address: null });
    if (res.error && /fixed pricing/i.test(errMsg(res.error))) ok('start_negotiation refuses a fixed-price provider');
    else no('fixed-price provider was negotiable: ' + JSON.stringify(res.error ?? res.data));
    await service.from('service_providers').update({ pricing_mode: 'negotiable' }).eq('id', providerId);
  }

  // ============ (i2) a manual decline is indistinguishable from the automatic one ============
  console.log('\n[i2) a provider\'s decline reads exactly like the below-floor auto-decline]');
  {
    await clearNegotiations();
    const { o } = await offer(450);                       // above the floor → really reaches them
    if (!o) no('could not start a negotiation for the decline test');
    else {
      const dec = await providerClient.rpc('respond_offer',
        { p_booking_id: o.booking_id, p_action: 'decline', p_amount: null });
      if (dec.error) no('provider decline failed: ' + errMsg(dec.error));
      const { data: notes } = await service.from('notifications').select('title, message')
        .eq('user_id', customerId).gte('created_at', o.created_at);
      const manual = (notes ?? []).find((n) => n.title === 'Offer not accepted');
      // If an above-floor decline were worded differently from a below-floor one, the customer
      // would learn which side of the floor their number fell on — the whole game, in one word.
      if (manual && manual.message === 'Your offer wasn\'t accepted. You can book at the listed price any time.')
        ok('an above-floor decline is worded identically to a below-floor one');
      else no('the two declines are distinguishable: ' + JSON.stringify(notes));
    }
  }

  // ================= (j) reputation is untouched by a failed haggle =================
  console.log('\n[j) 🔴 haggling must not dent either reputation]');
  {
    await clearNegotiations();
    const before = Number(await service.rpc('compute_reputation', { p_subject_type: 'provider', p_subject_id: providerId })
      .then((r) => r.data));
    await offer(FLOOR - 50);   // declined → expired
    const { o } = await offer(450);
    if (o) {
      await service.from('offers').update({ expires_at: new Date(Date.now() - 3600e3).toISOString() }).eq('id', o.id);
      await service.rpc('expire_stale_offers');
    }
    const after = Number(await service.rpc('compute_reputation', { p_subject_type: 'provider', p_subject_id: providerId })
      .then((r) => r.data));
    if (before === after) ok(`two failed negotiations left the provider's score untouched (${before} → ${after})`);
    else no(`🔴 a failed haggle moved the score (${before} → ${after}) — providers will switch bargaining off`);

    // This provider has real cancelled bookings in its history, so the rate is not zero — what
    // matters is that the failed negotiations did not CHANGE it.
    const { data: snaps } = await service.from('reputation_snapshots')
      .select('breakdown, computed_at').eq('subject_type', 'provider').eq('subject_id', providerId)
      .order('computed_at', { ascending: false }).limit(2);
    const [after2, before2] = snaps ?? [];
    if (before2 && after2 &&
        Number(after2.breakdown.cancellation) === Number(before2.breakdown.cancellation) &&
        Number(after2.breakdown.completion) === Number(before2.breakdown.completion))
      ok(`...and the ops inputs are untouched (cancellation ${after2.breakdown.cancellation}, completion ${after2.breakdown.completion})`);
    else no('failed negotiations changed the ops inputs: ' + JSON.stringify([before2?.breakdown, after2?.breakdown]));
  }
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
}

// ================= cleanup =================
console.log('\n[cleanup]');
{
  await clearNegotiations();
  for (const id of bookingIds) {
    await service.from('notifications').delete().like('link', `/bookings/${id}%`);
    await service.from('booking_events').delete().eq('booking_id', id);
    await service.from('bookings').delete().eq('id', id);
  }
  // Bounded by DB time, not this machine's. These are DELETEs: a local lower bound that reaches
  // into the past does not just over-read, it removes rows this run never created. Everything the
  // run produces here (decline notices, reputation snapshots) is written after its first offer.
  if (runAnchor) {
    await service.from('notifications').delete().eq('user_id', customerId)
      .like('link', `/providers/${providerId}%`).gte('created_at', runAnchor);
    await service.from('reputation_snapshots').delete()
      .eq('subject_type', 'provider').eq('subject_id', providerId).gte('computed_at', runAnchor);
  }
  if (original) await service.from('service_providers').update(original).eq('id', providerId);
  if (repBefore != null) await service.from('service_providers').update({ reputation_score: repBefore }).eq('id', providerId);
  console.log('  negotiations removed; the provider\'s original pricing and score restored.');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
