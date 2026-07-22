/*
  Verifies Step-6 bidirectional, gated reviews against the LIVE Supabase DB.
  Run it AFTER applying 20260722120000_seva_reviews.sql (supabase db push).

  Unlike verify-step5 (which drove the real escrow/webhook path), this test SEEDS a settled
  booking directly with the service-role key — status='paid', payment_status='released', plus a
  booking_events 'paid' row timestamped now (so the 24h review reward applies). Step 5 already
  proved how a booking reaches 'settled'; here we isolate the review layer on top of it.

  What it checks (the Step-6 "Done when"):
    (a) customer submits a multi-dimensional review on the settled booking → row written with
        direction='customer_to_provider', reviewer_id=customer; provider rating/total_reviews
        update; the ₹10 within-24h reward is credited to the reviewer
    (b) reciprocity: before the provider reciprocates, neither the provider NOR a third party can
        see the customer's review; the customer always sees their own
    (c) provider submits (direction='provider_to_customer') → both reviews now revealed to the
        two parties AND a third party; the provider's own rating is UNCHANGED (provider→customer
        reviews don't move provider reputation)
    (d) a 2nd review from the same side is rejected; a non-party is rejected; a non-settled
        booking is rejected
    (e) reviews are immutable: direct INSERT / UPDATE / DELETE by a client are denied

  Usage (from repo root) — roles match the live-DB mapping (provider=test1, customer=test2):
    CUSTOMER_EMAIL=test2@gmail.com CUSTOMER_PASSWORD=test2@9271 \
    PROVIDER_EMAIL=test1@gmail.com PROVIDER_PASSWORD=test1@9271 \
    STRANGER_EMAIL=test3@gmail.com STRANGER_PASSWORD=test3@9271 \
    node scripts/verify-step6.mjs

  Needs THREE distinct email-confirmed users (customer + provider + stranger).
*/
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };

console.log('DB:', URL, '\n');
if (!SERVICE) { console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY not in .env.local (needed to seed + assert).'); process.exit(0); }

const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

async function authClient(prefix) {
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = process.env[`${prefix}_EMAIL`];
  const password = process.env[`${prefix}_PASSWORD`];
  if (!email) return { client, userId: null };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) { console.log(`${prefix} signIn error:`, error.message); return { client, userId: null }; }
  return { client, userId: data?.user?.id ?? null };
}

// ---- sessions ----
console.log('[sessions]');
const { client: customerClient, userId: customerId } = await authClient('CUSTOMER');
const { client: providerClient, userId: providerId } = await authClient('PROVIDER');
const { client: strangerClient, userId: strangerId } = await authClient('STRANGER');
console.log('  customer:', customerId ?? 'NONE', '| provider:', providerId ?? 'NONE', '| stranger:', strangerId ?? 'NONE', '\n');
const distinct = new Set([customerId, providerId, strangerId]);
if (!customerId || !providerId || !strangerId || distinct.size !== 3) {
  console.log('Cannot run: need THREE distinct sessions (set CUSTOMER_*, PROVIDER_*, STRANGER_*).');
  process.exit(0);
}

let providerRowId = null, bookingId = null, unsettledId = null, myReviewId = null;
const AMOUNT = 600;

// --- helpers for the notification + realtime assertions ---
const waitFor = async (pred, ms = 20000, step = 500) => {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, step)); }
  return pred();
};
async function notifsFor(userId) {
  const { data } = await service.from('notifications')
    .select('title, message, type, link').eq('user_id', userId).like('link', `/bookings/${bookingId}%`);
  return data ?? [];
}
const byTitle = (rows, t) => rows.filter((r) => r.title === t);
const noLeak = (msg) => !/\d/.test(msg || '');   // a rating (1-5) is a digit; content-free msgs have none

// ================= setup: a provider profile + one settled booking + one unsettled booking =================
console.log('[setup: provider profile + settled booking + unsettled booking]');
{
  const { data: prov, error: provErr } = await providerClient.from('service_providers').insert({
    user_id: providerId, business_name: 'Verify Step6 Provider', bio: 'reviews test',
    hourly_rate: 300, city: 'Mumbai', state: 'MH',
  }).select('id, category_id').maybeSingle();
  if (provErr || !prov) { no('create provider profile: ' + (provErr?.message ?? 'no row')); }
  else { providerRowId = prov.id; ok('provider profile created (' + providerRowId.slice(0, 8) + ')'); }

  const { data: cat } = await anon.from('service_categories').select('id').limit(1).maybeSingle();
  const categoryId = cat?.id ?? null;
  const baseRow = {
    customer_id: customerId, provider_id: providerRowId, category_id: categoryId,
    service_type: 'one-time', scheduled_date: '2026-09-20', scheduled_time: '11:00',
    duration_hours: 2, hourly_rate: 300, total_amount: AMOUNT, payment_method: 'upi',
  };

  if (providerRowId) {
    const { data: bk, error: bkErr } = await customerClient.from('bookings').insert(baseRow).select('id').maybeSingle();
    if (bkErr || !bk) { no('create booking: ' + (bkErr?.message ?? 'no row')); }
    else {
      bookingId = bk.id;
      // Seed the settled state directly (service role): money cleared + a 'paid' event now.
      await service.from('bookings').update({ status: 'paid', payment_status: 'released' }).eq('id', bookingId);
      const { error: evErr } = await service.from('booking_events').insert({
        booking_id: bookingId, from_status: 'confirmed', to_status: 'paid', actor_id: null, actor_role: 'system',
      });
      if (evErr) no('seed paid booking_event: ' + evErr.message);
      else ok('settled booking seeded (' + bookingId.slice(0, 8) + ', status=paid/released + paid event)');
    }

    // A second booking left unsettled (default status, payment_status='pending') for the gate test.
    const { data: bk2 } = await customerClient.from('bookings').insert(baseRow).select('id, status, payment_status').maybeSingle();
    if (bk2) { unsettledId = bk2.id; ok(`unsettled booking created (${unsettledId.slice(0, 8)}, status=${bk2.status}, payment=${bk2.payment_status})`); }
  }
}

if (!bookingId || !providerRowId) {
  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(1);
}

// ================= bookings realtime: the detail page updates live (no refresh) =================
console.log('\n[bookings realtime: provider receives its booking updates live]');
{
  const { data: { session } } = await providerClient.auth.getSession();
  providerClient.realtime.setAuth(session?.access_token ?? null);
  let got = false, subscribed = false;
  const ch = providerClient
    .channel(`booking-live:${bookingId}`)
    .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'bookings', filter: `id=eq.${bookingId}` },
        () => { got = true; })
    .subscribe((s) => { if (s === 'SUBSCRIBED') subscribed = true; });

  if (await waitFor(() => subscribed, 20000)) ok('provider subscribed to its booking row');
  else no('provider could not subscribe to the booking row');

  // A benign server-side UPDATE (settlement is likewise an UPDATE) should reach the provider live —
  // this is what makes the review form appear on the provider's page without a manual refresh.
  await service.from('bookings').update({ updated_at: new Date().toISOString() }).eq('id', bookingId);
  if (await waitFor(() => got, 20000)) ok('LIVE: provider received the booking update via realtime (no refresh)');
  else no('LIVE: provider did NOT receive the booking update within 20s (bookings not in realtime?)');
  await providerClient.removeChannel(ch);
}

// ================= (a) customer submits → row + direction + rating + reward =================
console.log('\n[a) customer submits a multi-dimensional review]');
{
  const { data: r, error } = await customerClient.rpc('submit_review', {
    p_booking_id: bookingId, p_rating: 5, p_comment: 'Excellent work, very tidy.',
    p_quality: 5, p_punctuality: 4, p_communication: 5, p_price_fairness: 4,
  });
  if (error) { no('customer submit_review failed: ' + error.message); }
  else {
    myReviewId = r?.id ?? null;
    if (r?.direction === 'customer_to_provider' && r?.reviewer_id === customerId && r?.rating === 5) {
      ok(`review written (dir=${r.direction}, reviewer=customer, overall=5, quality=${r.rating_quality}, punctuality=${r.rating_punctuality})`);
    } else {
      no('review row not as expected: ' + JSON.stringify(r));
    }
  }

  const { data: prov } = await service.from('service_providers').select('rating, total_reviews').eq('id', providerRowId).maybeSingle();
  if (Number(prov?.rating) === 5 && Number(prov?.total_reviews) === 1) ok(`provider rating updated (rating=${prov.rating}, total_reviews=${prov.total_reviews})`);
  else no(`provider rating not updated as expected: ${JSON.stringify(prov)} (expected rating=5, total_reviews=1)`);

  const { data: reward } = await service.from('wallet_transactions')
    .select('amount, type').eq('reference_id', bookingId).eq('user_id', customerId).eq('type', 'reward');
  if ((reward ?? []).length === 1 && Number(reward[0].amount) === 10) ok('within-24h review reward credited (₹10, type=reward) to the reviewer');
  else no('review reward not credited as expected: ' + JSON.stringify(reward));

  // First review → the counterpart (provider) is nudged, WITHOUT any rating/content leaking.
  const nudge = byTitle(await notifsFor(providerId), 'The other party left a review');
  if (nudge.length === 1 && noLeak(nudge[0].message) && nudge[0].link === `/bookings/${bookingId}`)
    ok('counterpart (provider) notified "The other party left a review" — content-free, links to booking');
  else no('first-review notification to provider not as expected: ' + JSON.stringify(nudge));
}

// ================= (b) reciprocity: customer's review is hidden until provider reciprocates =================
console.log('\n[b) reveal is hidden before reciprocation]');
{
  const asProvider = await providerClient.from('reviews').select('id, direction').eq('booking_id', bookingId);
  if ((asProvider.data ?? []).length === 0) ok('provider canNOT yet see the customer\'s review (hidden)');
  else no('provider WRONGLY sees a review before reciprocating: ' + JSON.stringify(asProvider.data));

  const asStranger = await strangerClient.from('reviews').select('id, direction').eq('booking_id', bookingId);
  if ((asStranger.data ?? []).length === 0) ok('third party canNOT see the review (hidden)');
  else no('third party WRONGLY sees a review: ' + JSON.stringify(asStranger.data));

  const asOwner = await customerClient.from('reviews').select('id, direction').eq('booking_id', bookingId);
  if ((asOwner.data ?? []).length === 1) ok('customer always sees their own review');
  else no('customer cannot see their own review: ' + JSON.stringify(asOwner.data));
}

// ================= (c) provider submits → LIVE reveal + both revealed + notifications; rating unchanged =================
console.log('\n[c) provider reciprocates → live reveal, both revealed, notified; provider rating unaffected]');
{
  // Subscribe as the CUSTOMER (who already reviewed and is "waiting") BEFORE the provider submits.
  // Once the provider's row is inserted, RLS reveals it to the customer, so the customer's realtime
  // stream should deliver it — that's the no-refresh fix, verified end to end.
  const { data: { session } } = await customerClient.auth.getSession();
  customerClient.realtime.setAuth(session?.access_token ?? null);
  let rtGot = false, subscribed = false;
  const rt = customerClient
    .channel(`reviews-live:${bookingId}`)
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'reviews', filter: `booking_id=eq.${bookingId}` },
        (payload) => { if (payload.new?.direction === 'provider_to_customer') rtGot = true; })
    .subscribe((status) => { if (status === 'SUBSCRIBED') subscribed = true; });

  if (await waitFor(() => subscribed, 20000)) ok('customer subscribed to the reviews stream');
  else no('customer could not subscribe to the reviews stream (realtime join failed)');

  const { data: r, error } = await providerClient.rpc('submit_review', {
    p_booking_id: bookingId, p_rating: 4, p_comment: 'Polite and punctual customer.',
    p_quality: 4, p_punctuality: 4, p_communication: 5, p_price_fairness: null,   // quality slot = "Respect"
  });
  if (error) no('provider submit_review failed: ' + error.message);
  else if (r?.direction === 'provider_to_customer' && r?.reviewer_id === providerId && r?.rating_quality === 4)
    ok(`provider review written (dir=${r.direction}, reviewer=provider, overall=4, respect=${r.rating_quality})`);
  else no('provider review row not as expected: ' + JSON.stringify(r));

  // Live delivery: the customer's stream should receive the provider's review with no refetch.
  if (await waitFor(() => rtGot, 20000)) ok('LIVE: customer received the provider review via realtime (no refresh)');
  else no('LIVE: customer did NOT receive the provider review via realtime within 20s');
  await customerClient.removeChannel(rt);

  // Provider→customer reviews must NOT move the provider's own rating.
  const { data: prov } = await service.from('service_providers').select('rating, total_reviews').eq('id', providerRowId).maybeSingle();
  if (Number(prov?.rating) === 5 && Number(prov?.total_reviews) === 1) ok('provider rating UNCHANGED by the provider→customer review (still 5, 1 review)');
  else no(`provider rating moved by a provider→customer review: ${JSON.stringify(prov)} (expected rating=5, total_reviews=1)`);

  const asProvider = await providerClient.from('reviews').select('id, direction').eq('booking_id', bookingId);
  if ((asProvider.data ?? []).length === 2) ok('both reviews now revealed to the provider');
  else no('provider does not see both reviews after reciprocating: ' + JSON.stringify(asProvider.data));

  const asStranger = await strangerClient.from('reviews').select('id, direction').eq('booking_id', bookingId);
  if ((asStranger.data ?? []).length === 2) ok('both reviews now revealed to a third party (public once both submit)');
  else no('third party does not see both revealed reviews: ' + JSON.stringify(asStranger.data));

  // Reveal notifications: counterpart (customer) → "You received a review"; reviewer (provider) →
  // "Reviews revealed". Both content-free (no rating/comment).
  const gotReview = byTitle(await notifsFor(customerId), 'You received a review');
  if (gotReview.length === 1 && noLeak(gotReview[0].message) && gotReview[0].link === `/bookings/${bookingId}`)
    ok('customer notified "You received a review" on reveal — content-free, links to booking');
  else no('reveal notification to customer not as expected: ' + JSON.stringify(gotReview));

  const provReveal = byTitle(await notifsFor(providerId), 'Reviews revealed');
  if (provReveal.length === 1 && noLeak(provReveal[0].message))
    ok('provider (reviewer) notified "Reviews revealed" on reveal — content-free');
  else no('reveal notification to provider not as expected: ' + JSON.stringify(provReveal));
}

// ================= (d) rejections: 2nd same-side, non-party, non-settled =================
console.log('\n[d) submit_review rejects 2nd-same-side / non-party / non-settled]');
{
  const dup = await customerClient.rpc('submit_review', { p_booking_id: bookingId, p_rating: 3 });
  if (dup.error) ok('2nd review from the same side rejected: ' + dup.error.message);
  else no('2nd review from the same side was ALLOWED (should be rejected)');

  const outsider = await strangerClient.rpc('submit_review', { p_booking_id: bookingId, p_rating: 3 });
  if (outsider.error && /not a party/i.test(outsider.error.message)) ok('non-party rejected: ' + outsider.error.message);
  else if (outsider.error) ok('non-party rejected: ' + outsider.error.message);
  else no('non-party review was ALLOWED (should be rejected)');

  if (unsettledId) {
    const notSettled = await customerClient.rpc('submit_review', { p_booking_id: unsettledId, p_rating: 3 });
    if (notSettled.error && /completed, paid/i.test(notSettled.error.message)) ok('non-settled booking rejected: ' + notSettled.error.message);
    else if (notSettled.error) ok('non-settled booking rejected: ' + notSettled.error.message);
    else no('review on a non-settled booking was ALLOWED (should be rejected)');
  } else sk('no unsettled booking to test the settled-gate');
}

// ================= (e) immutability: direct insert / update / delete denied =================
console.log('\n[e) reviews are immutable — only submit_review writes]');
{
  // A privilege denial is code 42501 ("permission denied for table reviews"). Assert on that
  // specifically so a policy-recursion error (the bug we just fixed) can't masquerade as a pass.
  const denied = (e) => e && (e.code === '42501' || /permission denied/i.test(e.message));

  const ins = await customerClient.from('reviews').insert({
    booking_id: bookingId, customer_id: customerId, provider_id: providerRowId,
    reviewer_id: customerId, direction: 'customer_to_provider', rating: 1,
  }).select('id');
  if (denied(ins.error)) ok('direct INSERT denied by privilege: ' + ins.error.message);
  else no('direct INSERT not cleanly denied: ' + JSON.stringify(ins.error ?? ins.data));

  const upd = await customerClient.from('reviews').update({ rating: 1, comment: 'edited' }).eq('id', myReviewId).select('id');
  const { data: afterUpd } = await service.from('reviews').select('rating, comment').eq('id', myReviewId).maybeSingle();
  if (denied(upd.error) && Number(afterUpd?.rating) === 5 && afterUpd?.comment !== 'edited') ok('direct UPDATE denied by privilege + row unchanged: ' + upd.error.message);
  else no('direct UPDATE not cleanly denied: err=' + JSON.stringify(upd.error) + ' row=' + JSON.stringify(afterUpd));

  const del = await customerClient.from('reviews').delete().eq('id', myReviewId).select('id');
  const { data: afterDel } = await service.from('reviews').select('id').eq('id', myReviewId).maybeSingle();
  if (denied(del.error) && afterDel?.id) ok('direct DELETE denied by privilege + row present: ' + del.error.message);
  else no('direct DELETE not cleanly denied: err=' + JSON.stringify(del.error) + ' present=' + Boolean(afterDel?.id));
}

// ================= cleanup =================
console.log('\n[cleanup]');
{
  // Reverse each reviewer's within-24h reward, then remove the ledger rows.
  for (const uid of [customerId, providerId]) {
    const { data: rewards } = await service.from('wallet_transactions')
      .select('amount').eq('reference_id', bookingId).eq('user_id', uid).eq('type', 'reward');
    const total = (rewards ?? []).reduce((s, r) => s + Number(r.amount), 0);
    if (total > 0) {
      const { data: prof } = await service.from('profiles').select('wallet_balance').eq('id', uid).maybeSingle();
      await service.from('profiles').update({ wallet_balance: Math.max(0, Number(prof?.wallet_balance ?? 0) - total) }).eq('id', uid);
    }
  }
  await service.from('wallet_transactions').delete().eq('reference_id', bookingId);
  await service.from('notifications').delete().like('link', `/bookings/${bookingId}%`);
  await service.from('bookings').delete().in('id', [bookingId, unsettledId].filter(Boolean)); // cascades reviews + events
  await service.from('service_providers').delete().eq('id', providerRowId);
  console.log('  cleaned up bookings, reviews, events, reward ledger, notifications, and provider profile.');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
