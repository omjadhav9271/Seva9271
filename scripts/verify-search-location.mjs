/*
  Verifies the post-Step-11 search & location work against the LIVE Supabase DB.
  Run AFTER applying 20260822120000_seva_search_sort.sql and
  20260823120000_seva_booking_service_location.sql (supabase db push).

  Three properties, each of which has a specific way of going quietly wrong:

    (A) THE SORT RUNS IN THE QUERY. p_sort must re-order the RESULT SET, not the page. The failure
        mode is invisible by inspection: a client-side "Top rated" over a match-ranked cut shows
        the best rated OF THE ROWS THAT CAME BACK, which looks like a working control while the
        best-rated provider in range sits at rank 61, unreachable. So the assertion is not "the
        order changed" but "the top row by rating is the best-rated provider IN RANGE".

    (B) WIDENING HAS SOMETHING TO WIDEN INTO. The ladder itself lives in the client
        (lib/matching.ts), but its premise is a claim about the data: that there are origins where
        a near radius returns nothing and a wider one returns people. If that were false the
        feature would be untestable theatre. Also asserts the other end — that a point in empty
        country returns nothing even at the outermost radius, so "no providers serve your area yet"
        is a real state and not a message nobody can reach.

    (C) 🔴 THE ADDRESS REVEAL. The customer's precise service address must be unreadable by the
        provider until they accept the booking, and unreadable by anyone else ever. Checked at the
        level that matters — the column grant AND the RPC — because a UI that merely declines to
        render it is not a control.

  Usage (from repo root) — credentials come from .env.local (see .env.example):
    node scripts/verify-search-location.mjs
*/
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { cred } from './lib/creds.mjs';

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
const denied = (e) => e && (e.code === '42501' || /permission denied/i.test(e.message));

// The client's ladder, mirrored here so the two cannot silently disagree about what is being
// tested. If lib/matching.ts changes these, this file should change with it.
const RADIUS_STEPS_KM = [15, 50, 150];
const MIN_RESULTS = 3;

const ORIGIN = { lat: 19.0760, lng: 72.8777 };   // Mumbai centre

console.log('DB:', URL, '\n');
if (!SERVICE) { console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY not in .env.local.'); process.exit(0); }

const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

async function authClient(prefix) {
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = cred(`${prefix}_EMAIL`);
  const password = cred(`${prefix}_PASSWORD`);
  if (!email) return { client, userId: null };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) { console.log(`${prefix} signIn error:`, error.message); return { client, userId: null }; }
  return { client, userId: data?.user?.id ?? null };
}

const search = (client, opts = {}) => client.rpc('search_providers', {
  p_lat: opts.lat ?? ORIGIN.lat,
  p_lng: opts.lng ?? ORIGIN.lng,
  p_category_id: null,
  p_radius_km: opts.radiusKm ?? RADIUS_STEPS_KM[0],
  p_limit: opts.limit ?? 30,
  p_query: opts.query ?? null,
  p_min_rating: null,
  p_available_only: opts.availableOnly ?? false,
  p_sort: opts.sort ?? 'match',
});

let seededBookingId = null;
// A provider we temporarily un-price, so the "custom pricing sorts last" rule can be exercised.
// Tracked at module scope so the finally block restores it even if an assertion throws.
let unpricedFixture = null;   // { id, hourly_rate }

/* The ground-truth query pulls every provider in range in one response. That is a few hundred
   rows of JSON over a residential link to Supabase, and it intermittently dies with
   `TypeError: fetch failed` — an undici socket error, not a database one. Observed once in two
   runs. A flaky ground truth is worse than no ground truth: it produces a red line that says the
   migration is missing when it is not, and the next person spends an hour on the wrong thing.
   So: retry twice before believing it. */
async function rpcWithRetry(args, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const res = await service.rpc('search_providers', args);
    if (!res.error) return res;
    last = res;
    if (!/fetch failed|network|socket|ETIMEDOUT/i.test(res.error.message)) break;
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return last;
}

try {
  /* ===== (A) the sort is a QUERY parameter ===== */
  console.log('[the sort runs in the query, not over the page]');
  {
    const WIDE = 25;   // a radius with plenty inside it, so "in range" is a large set
    const { data: everything, error: allErr } = await rpcWithRetry({
      p_lat: ORIGIN.lat, p_lng: ORIGIN.lng, p_category_id: null, p_radius_km: WIDE, p_limit: 1000,
      p_query: null, p_min_rating: null, p_available_only: false, p_sort: 'match',
    });

    if (allErr) {
      no('search_providers with p_sort failed — is 20260822120000 applied? ' + allErr.message);
    } else if ((everything ?? []).length < 5) {
      sk(`only ${(everything ?? []).length} providers within ${WIDE} km — too few to prove an ordering`);
    } else {
      const inRange = everything;
      const CUT = 10;   // a limit far smaller than the result set: this is what makes it a CUT

      // rating: the top row must be the best-rated provider in range — not merely the best-rated
      // of the ten that a match-ranked query would have returned.
      const { data: byRating } = await search(service, { radiusKm: WIDE, limit: CUT, sort: 'rating' });
      const bestInRange = Math.max(...inRange.map((p) => Number(p.rating)));
      const bestOnPage = Number(byRating?.[0]?.rating ?? -1);
      const naive = Math.max(...inRange.slice(0, CUT).map((p) => Number(p.rating)));
      if (bestOnPage === bestInRange) {
        ok(`p_sort=rating tops out at the best rating IN RANGE (${bestInRange})`);
        if (bestInRange > naive) ok(`…higher than sorting the top ${CUT} would have reached (${naive})`);
        else sk(`the best-rated provider already sat in the top ${CUT}, so this data cannot prove the difference`);
      } else {
        no(`p_sort=rating returned ${bestOnPage} first, but ${bestInRange} is in range — the sort is over a page`);
      }

      // rating: monotonically non-increasing down the page.
      const ratings = (byRating ?? []).map((p) => Number(p.rating));
      if (ratings.every((r, i) => i === 0 || ratings[i - 1] >= r)) ok('p_sort=rating is ordered high→low');
      else no('p_sort=rating is not monotonic: ' + ratings.join(', '));

      // distance: the top row must be the nearest provider in range.
      const { data: byDistance } = await search(service, { radiusKm: WIDE, limit: CUT, sort: 'distance' });
      const nearestInRange = Math.min(...inRange.map((p) => Number(p.distance_km)));
      const nearestOnPage = Number(byDistance?.[0]?.distance_km ?? -1);
      if (Math.abs(nearestOnPage - nearestInRange) < 0.001) ok(`p_sort=distance starts at the nearest in range (${nearestInRange} km)`);
      else no(`p_sort=distance started at ${nearestOnPage} km, but ${nearestInRange} km is in range`);

      const dists = (byDistance ?? []).map((p) => Number(p.distance_km));
      if (dists.every((d, i) => i === 0 || dists[i - 1] <= d)) ok('p_sort=distance is ordered near→far');
      else no('p_sort=distance is not monotonic: ' + dists.join(', '));

      // match: unchanged by this work. If the default ordering moved, every ranking assertion
      // written before today is measuring a different function.
      const { data: byMatch } = await search(service, { radiusKm: WIDE, limit: CUT, sort: 'match' });
      const scores = (byMatch ?? []).map((p) => Number(p.match_score));
      if (scores.every((s, i) => i === 0 || scores[i - 1] >= s)) ok('p_sort=match still returns the blended ranking, high→low');
      else no('p_sort=match is not ordered by match_score: ' + scores.join(', '));

      // reviews: same property, third axis.
      const { data: byReviews } = await search(service, { radiusKm: WIDE, limit: CUT, sort: 'reviews' });
      const mostInRange = Math.max(...inRange.map((p) => Number(p.total_reviews)));
      if (Number(byReviews?.[0]?.total_reviews ?? -1) === mostInRange) {
        ok(`p_sort=reviews tops out at the most-reviewed in range (${mostInRange})`);
      } else {
        no(`p_sort=reviews led with ${byReviews?.[0]?.total_reviews}, but ${mostInRange} is in range`);
      }

      /* PRICE — and the trap in it. hourly_rate is 0 for providers who quote per job; the card
         calls that "Custom pricing", not free. A naive ascending sort opens the cheapest page with
         every unpriced provider, which is useless AND a lie about what they cost. Both directions
         must push them to the end. */
      const priced = inRange.filter((p) => Number(p.hourly_rate) > 0);
      const unpriced = inRange.length - priced.length;
      const { data: byLow } = await search(service, { radiusKm: WIDE, limit: CUT, sort: 'price_low' });
      const { data: byHigh } = await search(service, { radiusKm: WIDE, limit: CUT, sort: 'price_high' });

      if (!priced.length) {
        sk('no provider in range has an hourly rate — price ordering cannot be checked');
      } else {
        const cheapest = Math.min(...priced.map((p) => Number(p.hourly_rate)));
        const dearest = Math.max(...priced.map((p) => Number(p.hourly_rate)));
        if (Number(byLow?.[0]?.hourly_rate) === cheapest) ok(`p_sort=price_low starts at the cheapest in range (₹${cheapest})`);
        else no(`p_sort=price_low started at ₹${byLow?.[0]?.hourly_rate}, but ₹${cheapest} is in range`);
        if (Number(byHigh?.[0]?.hourly_rate) === dearest) ok(`p_sort=price_high starts at the dearest in range (₹${dearest})`);
        else no(`p_sort=price_high started at ₹${byHigh?.[0]?.hourly_rate}, but ₹${dearest} is in range`);

        /* The unpriced case has to be MANUFACTURED, because the seeded data has none — and an
           untested trap-closure is a coin flip. hourly_rate 0 is a real product state (the cards
           render "Custom pricing" / "Contact for pricing" for it), so this is not an artificial
           input; the fixture data simply never produced one. One provider is un-priced for the
           length of this check and restored in the finally block below. */
        if (unpriced > 0) {
          const leadsWithUnpriced = (rows) => Number(rows?.[0]?.hourly_rate ?? -1) === 0;
          if (!leadsWithUnpriced(byLow) && !leadsWithUnpriced(byHigh)) {
            ok(`${unpriced} unpriced ("custom pricing") providers sort LAST in both directions, not first`);
          } else {
            no('an unpriced provider (hourly_rate 0) led a price sort — it reads as "free"');
          }
        } else {
          const victim = priced.find((p) => Number(p.hourly_rate) === dearest) ?? priced[0];
          const { data: before } = await service.from('service_providers')
            .select('id, hourly_rate').eq('id', victim.id).maybeSingle();
          if (!before) {
            sk('could not stage an unpriced provider — the "custom pricing sorts last" rule is UNTESTED');
          } else {
            unpricedFixture = { id: before.id, hourly_rate: before.hourly_rate };
            const { error: stageErr } = await service.from('service_providers')
              .update({ hourly_rate: 0 }).eq('id', before.id);
            if (stageErr) {
              unpricedFixture = null;
              sk('could not stage an unpriced provider (' + stageErr.message + ') — rule UNTESTED');
            } else {
              const { data: lowNow } = await search(service, { radiusKm: WIDE, limit: CUT, sort: 'price_low' });
              const { data: highNow } = await search(service, { radiusKm: WIDE, limit: CUT, sort: 'price_high' });
              const leads = (rows) => Number(rows?.[0]?.hourly_rate ?? -1) === 0;
              if (!leads(lowNow) && !leads(highNow)) {
                ok(`a "custom pricing" provider (₹0) leads NEITHER price sort — it is unpriced, not free`);
              } else {
                no(`an unpriced provider led ${leads(lowNow) ? 'price_low' : 'price_high'} — the page would read it as free`);
              }
              // …and it must still be reachable, just not first: unpriced is not excluded.
              const { data: allNow } = await search(service, { radiusKm: WIDE, limit: 500, sort: 'price_low' });
              if ((allNow ?? []).some((p) => p.id === before.id)) ok('…and is still in the results, just at the end');
              else no('the unpriced provider vanished from a price sort entirely');
            }
          }
        }

        const lows = (byLow ?? []).map((p) => Number(p.hourly_rate)).filter((v) => v > 0);
        if (lows.every((v, i) => i === 0 || lows[i - 1] <= v)) ok('p_sort=price_low is ordered cheap→dear');
        else no('p_sort=price_low is not monotonic: ' + lows.join(', '));
      }

      // and the sorts really are different questions
      const ids = (rows) => (rows ?? []).map((p) => p.id).join(',');
      const orderings = new Set([byMatch, byDistance, byRating, byReviews, byLow, byHigh].map(ids));
      if (orderings.size >= 4) {
        ok(`the six sorts produce ${orderings.size} distinct orderings — they are genuinely different questions`);
      } else {
        sk(`only ${orderings.size} distinct orderings on this data — the sorts cannot all be told apart here`);
      }

      // an unknown value must fall back rather than error: a sort control is not a security gate
      const { data: nonsense, error: nonsenseErr } = await search(service, { radiusKm: WIDE, limit: CUT, sort: 'sideways' });
      if (nonsenseErr) no('an unrecognised p_sort raised instead of falling back: ' + nonsenseErr.message);
      else if (ids(nonsense) === ids(byMatch)) ok('an unrecognised p_sort falls back to the default ranking');
      else no('an unrecognised p_sort returned something other than the default ranking');
    }
  }

  /* ===== (B) widening has somewhere to widen into, and an honest end ===== */
  console.log('\n[widening: the near radius can be empty and the wide one not]');
  {
    // Real places at the sparse edge of our coverage. We do not care WHICH one demonstrates the
    // property, only that the property is demonstrable — so try them and report the first that is.
    const CANDIDATES = [
      { name: 'Karjat', lat: 18.9107, lng: 73.3233 },
      { name: 'Alibaug', lat: 18.6414, lng: 72.8722 },
      { name: 'Lonavala', lat: 18.7546, lng: 73.4062 },
      { name: 'Palghar', lat: 19.6967, lng: 72.7699 },
      { name: 'Nashik', lat: 19.9975, lng: 73.7898 },
    ];
    let shown = false;
    for (const c of CANDIDATES) {
      const counts = [];
      for (const radiusKm of RADIUS_STEPS_KM) {
        const { data } = await search(service, { lat: c.lat, lng: c.lng, radiusKm, limit: 60 });
        counts.push((data ?? []).length);
      }
      const [near, wide, widest] = counts;
      if (near < MIN_RESULTS && wide >= MIN_RESULTS) {
        ok(`${c.name}: ${near} within ${RADIUS_STEPS_KM[0]} km but ${wide} within ${RADIUS_STEPS_KM[1]} km ` +
           `— the old fixed radius showed a BLANK page here`);
        shown = true;
        break;
      }
      if (near < MIN_RESULTS && widest >= MIN_RESULTS) {
        ok(`${c.name}: ${near} within ${RADIUS_STEPS_KM[0]} km, ${widest} within ${RADIUS_STEPS_KM[2]} km — widening reaches them`);
        shown = true;
        break;
      }
    }
    if (!shown) sk('no candidate origin is currently sparse-then-populated — widening cannot be demonstrated on this data');

    // The other end: past the cap there must be nothing, so the honest empty state is reachable
    // and we are not one radius bump away from offering a provider 400 km away.
    const REMOTE = { name: 'rural Madhya Pradesh', lat: 23.6, lng: 78.9 };
    const { data: nothing } = await search(service, { lat: REMOTE.lat, lng: REMOTE.lng, radiusKm: RADIUS_STEPS_KM[2], limit: 60 });
    if ((nothing ?? []).length === 0) {
      ok(`${REMOTE.name}: still empty at the ${RADIUS_STEPS_KM[2]} km cap — the "we're expanding" state is real`);
    } else {
      no(`${REMOTE.name} returned ${(nothing ?? []).length} providers within ${RADIUS_STEPS_KM[2]} km — the cap is too wide`);
    }

    // Widening must not relax the filters it was given. A wider search finds more people; it must
    // never smuggle in someone the customer excluded.
    const { data: availableWide } = await search(service, { radiusKm: RADIUS_STEPS_KM[2], limit: 200, availableOnly: true });
    const leaked = (availableWide ?? []).filter((p) => !p.is_available).length;
    if (leaked === 0) ok(`available_only holds at the widest radius (${(availableWide ?? []).length} rows, none busy)`);
    else no(`${leaked} unavailable providers came back from a widened available-only search`);
  }

  /* ===== (C) the address reveal ===== */
  console.log('\n[the customer address is per-booking and revealed by status]');
  {
    const { client: customer, userId: customerId } = await authClient('CUSTOMER');
    const { client: provider, userId: providerUserId } = await authClient('PROVIDER');
    const { client: outsider, userId: outsiderId } = await authClient('OUTSIDER');

    const { data: sp } = await service.from('service_providers')
      .select('id, user_id').eq('user_id', providerUserId).limit(1).maybeSingle();
    const { data: cat } = await service.from('service_categories').select('id').limit(1).maybeSingle();

    if (!customerId || !providerUserId || !sp) {
      sk('need the CUSTOMER and PROVIDER accounts (and a provider row) to test the reveal');
    } else {
      const ADDRESS = 'Flat 7B, Sunrise Apartments, Turner Road, Bandra West';
      const PINCODE = '400050';
      const PIN = { lat: 19.0596, lng: 72.8295 };

      const { data: bk, error: bkErr } = await service.from('bookings').insert({
        customer_id: customerId, provider_id: sp.id, category_id: cat?.id ?? null,
        service_type: 'one-time', scheduled_date: '2026-09-14', scheduled_time: '11:00',
        duration_hours: 2, hourly_rate: 300, total_amount: 600, payment_method: 'upi',
        status: 'requested', payment_status: 'pending',
        address: ADDRESS, service_pincode: PINCODE, service_lat: PIN.lat, service_lng: PIN.lng,
        notes: 'verify-search-location fixture',
      }).select('id').maybeSingle();

      if (bkErr || !bk) {
        no('could not seed a booking: ' + (bkErr?.message ?? 'no row'));
      } else {
        seededBookingId = bk.id;

        // --- the column grant, which is the actual control ---
        const col = await provider.from('bookings').select('id, address').eq('id', bk.id);
        if (denied(col.error)) ok('provider: selecting bookings.address is denied at the column level');
        else no('provider: bookings.address was selectable! ' + JSON.stringify(col.error ?? col.data));

        const star = await provider.from('bookings').select('*').eq('id', bk.id);
        if (denied(star.error)) ok("provider: select('*') on bookings fails closed");
        else no("provider: select('*') on bookings was ALLOWED — the address is reachable via *");

        // the customer's own address is equally ungranted: everyone reads through the RPC
        const custCol = await customer.from('bookings').select('id, address').eq('id', bk.id);
        if (denied(custCol.error)) ok('customer: the column is ungranted for them too (one read path, not two)');
        else no('customer: bookings.address was selectable directly');

        // and the rest of the row still works, or every booking page is broken
        const rest = await customer.from('bookings')
          .select('id, status, scheduled_date, total_amount, notes').eq('id', bk.id).maybeSingle();
        if (!rest.error && rest.data?.id === bk.id) ok('the non-address columns are still readable (the lockdown is not table-wide)');
        else no('the booking row itself became unreadable: ' + (rest.error?.message ?? 'no row'));

        // --- the RPC, before acceptance ---
        const loc = async (client) => {
          const { data, error } = await client.rpc('booking_service_location', { p_booking_id: bk.id });
          return { row: Array.isArray(data) ? data[0] : data, error };
        };

        const pre = await loc(provider);
        if (pre.error) {
          no('provider: booking_service_location errored: ' + pre.error.message);
        } else if (!pre.row) {
          no('provider: got no row at all — they should see the pincode');
        } else if (pre.row.revealed === false && pre.row.address === null && pre.row.lat === null) {
          ok(`provider, booking 'requested': revealed=false, address withheld, pincode ${pre.row.pincode} shown`);
        } else {
          no(`provider read the address BEFORE accepting: ${JSON.stringify(pre.row)}`);
        }

        const custPre = await loc(customer);
        if (custPre.row?.revealed === true && custPre.row.address === ADDRESS) {
          ok('customer: reads their own address at any status');
        } else {
          no('customer could not read their own address: ' + JSON.stringify(custPre.row ?? custPre.error));
        }

        if (!outsiderId) {
          sk('OUTSIDER not configured — "a signed-in stranger sees nothing" is UNTESTED');
        } else {
          const out = await loc(outsider);
          if (!out.error && !out.row) ok('a signed-in outsider gets NO row — not even whether the booking exists');
          else no('an outsider got: ' + JSON.stringify(out.row ?? out.error));
        }

        const anonCall = await anon.rpc('booking_service_location', { p_booking_id: bk.id });
        if (anonCall.error) ok('anon cannot execute booking_service_location (' + anonCall.error.message.slice(0, 60) + ')');
        else no('ANON executed booking_service_location and got: ' + JSON.stringify(anonCall.data));

        // --- and after acceptance ---
        await service.from('bookings').update({ status: 'accepted' }).eq('id', bk.id);
        const post = await loc(provider);
        if (post.row?.revealed === true && post.row.address === ADDRESS && post.row.pincode === PINCODE) {
          ok("provider, booking 'accepted': the full address unlocks");
        } else {
          no('provider still cannot read the address after accepting: ' + JSON.stringify(post.row ?? post.error));
        }
        if (post.row?.lat === PIN.lat && post.row?.lng === PIN.lng) ok('…including the optional map pin, for the Maps fallback');
        else sk('map pin not returned post-reveal (it is optional)');

        // a cancelled booking closes again — the provider has no further business with the address
        await service.from('bookings').update({ status: 'cancelled' }).eq('id', bk.id);
        const cancelled = await loc(provider);
        if (cancelled.row?.revealed === false && cancelled.row.address === null) {
          ok("provider, booking 'cancelled': the address is withheld again");
        } else {
          no('a cancelled booking still exposes the address: ' + JSON.stringify(cancelled.row));
        }

        /* --- the CUSTOMER's own INSERT, which nothing else here exercises ---
           Every other booking in this file is created with the SERVICE ROLE, and the service role
           bypasses column privileges entirely. So a broken INSERT grant on the three new columns
           would leave this whole file green while booking creation was dead for every real
           customer — the columns are written by the browser, through `authenticated`, or not at
           all. Cheap to check, catastrophic to miss. */
        {
          const { data: own, error: ownErr } = await customer.from('bookings').insert({
            customer_id: customerId, provider_id: sp.id, category_id: cat?.id ?? null,
            service_type: 'one-time', scheduled_date: '2026-09-15', scheduled_time: '10:00',
            duration_hours: 2, hourly_rate: 300, total_amount: 600, payment_method: 'upi',
            address: '12 Hill Road, Bandra West', service_pincode: '400050',
            service_lat: 19.0596, service_lng: 72.8295,
            notes: 'verify-search-location customer-insert fixture',
          }).select('id').maybeSingle();

          if (ownErr || !own) {
            no('a CUSTOMER cannot insert a booking carrying its service location: ' + (ownErr?.message ?? 'no row'));
          } else {
            ok('a customer can insert a booking with address + pincode + pin (the INSERT grant is right)');
            const { data: back } = await customer.rpc('booking_service_location', { p_booking_id: own.id });
            const row = Array.isArray(back) ? back[0] : back;
            if (row?.address === '12 Hill Road, Bandra West' && row?.pincode === '400050'
                && Number(row?.lat) === 19.0596) {
              ok('…and every field round-trips back through the RPC');
            } else {
              no('the customer-written location did not round-trip: ' + JSON.stringify(row));
            }
            await service.from('bookings').delete().eq('id', own.id);
          }
        }

        // --- writing it after the fact ---
        await service.from('bookings').update({ status: 'accepted' }).eq('id', bk.id);
        const hijack = await outsider.rpc('set_booking_service_location', {
          p_booking_id: bk.id, p_address: 'Somewhere else entirely', p_pincode: '110001', p_lat: null, p_lng: null,
        });
        if (hijack.error) ok('an outsider cannot rewrite the address on a booking that is not theirs');
        else no('AN OUTSIDER REWROTE the service address');

        const fix = await customer.rpc('set_booking_service_location', {
          p_booking_id: bk.id, p_address: ADDRESS + ', near the temple', p_pincode: null, p_lat: null, p_lng: null,
        });
        if (!fix.error) ok('the customer can correct their own address while the job is live');
        else no('the customer could not correct their own address: ' + fix.error.message);

        const after = await loc(customer);
        if (after.row?.pincode === PINCODE) ok('…and a null argument leaves the other fields alone');
        else no('correcting the address wiped the pincode: ' + JSON.stringify(after.row));
      }
    }
  }
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
} finally {
  if (seededBookingId) {
    const { error } = await service.from('bookings').delete().eq('id', seededBookingId);
    console.log(error ? `\n  (cleanup failed: ${error.message})` : '\n  (cleanup: fixture booking removed)');
  }
  /* Restoring this matters more than the booking cleanup: leaving a real provider at ₹0 would show
     "Custom pricing" on their live card. Loud on failure, and the restored value is read back
     rather than assumed. */
  if (unpricedFixture) {
    const { error } = await service.from('service_providers')
      .update({ hourly_rate: unpricedFixture.hourly_rate }).eq('id', unpricedFixture.id);
    const { data: back } = await service.from('service_providers')
      .select('hourly_rate').eq('id', unpricedFixture.id).maybeSingle();
    if (error || Number(back?.hourly_rate) !== Number(unpricedFixture.hourly_rate)) {
      console.log(`\n  🔴 COULD NOT RESTORE provider ${unpricedFixture.id} to ₹${unpricedFixture.hourly_rate} ` +
        `— it is currently ₹${back?.hourly_rate}. Fix this by hand.`);
    } else {
      console.log(`  (cleanup: provider ${unpricedFixture.id.slice(0, 8)} restored to ₹${unpricedFixture.hourly_rate})`);
    }
  }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
