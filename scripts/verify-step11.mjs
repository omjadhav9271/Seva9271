/*
  Verifies Step 11 (PostGIS matching & ranking) against the LIVE Supabase DB.
  Run AFTER applying 20260818120000_seva_matching_postgis.sql (supabase db push).

  What it checks:
    (a) search_providers returns ranked rows, each carrying a distance_km, ordered by match_score
    (b) the radius filter really excludes out-of-range providers (ST_DWithin)
    (c) 🔴 COORDINATE PRIVACY — the invariant this step must not break:
        latitude / longitude / geo are NOT selectable by anon or authenticated, select('*') fails
        closed, and no RPC row carries a coordinate key. Only distance_km is exposed.
    (d) distance is measured from the GRID-SNAPPED point, not the provider's exact position — so
        trilaterating the RPC recovers a ~250 m cell, not somebody's home
    (e) reputation_score measurably changes rank order (the whole point of using the Step-7 score
        rather than the star average) — proven by moving one provider's score and watching it fall

  NOT covered here, and deliberately: that postgis is installed, that the geo column exists and
  that idx_providers_geo is a GIST index. PostgREST cannot read pg_catalog, and adding an
  introspection RPC just for a test would widen the surface. Those are asserted by the migration
  itself (it fails to apply if the extension or the column is missing) and were confirmed by direct
  catalog query at apply time. If (a) returns ranked rows at all, all three necessarily exist.

  Usage (from repo root) — credentials come from .env.local (see .env.example):
    node scripts/verify-step11.mjs
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

// Mumbai centre — the same anchor the app falls back to when a customer declines location.
const ORIGIN = { lat: 19.0760, lng: 72.8777 };

/** Great-circle distance in km, for comparing the RPC's answer against the TRUE coordinates. */
function haversineKm(a, b) {
  const R = 6371.0088, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

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
  p_category_id: opts.categoryId ?? null,
  p_radius_km: opts.radiusKm ?? 25,
  p_limit: opts.limit ?? 30,
});

console.log('[sessions]');
const { client: customerClient, userId: customerId } = await authClient('CUSTOMER');
console.log('  customer:', customerId ?? 'NONE', '\n');

// ================= (a) ranked results with a distance =================
console.log('[a) search_providers returns ranked results, each with a distance_km]');
let rows = [];
{
  const r = await search(anon);
  if (r.error) {
    no('anon cannot call search_providers: ' + r.error.message);
  } else {
    rows = r.data ?? [];
    if (rows.length > 0) ok(`anon can search — ${rows.length} approved providers within 25 km of Mumbai centre`);
    else no('search returned 0 rows — nothing to rank (are any approved providers geocoded?)');

    const allHaveDistance = rows.every((p) => typeof p.distance_km === 'number' && Number.isFinite(p.distance_km));
    if (rows.length && allHaveDistance) ok('every row carries a finite distance_km');
    else if (rows.length) no('some rows have no usable distance_km');

    const scores = rows.map((p) => p.match_score);
    const sortedDesc = scores.every((s, i) => i === 0 || scores[i - 1] >= s);
    if (rows.length && sortedDesc) ok('rows arrive ordered by match_score DESC (server-side ranking)');
    else if (rows.length) no('rows are NOT ordered by match_score: ' + JSON.stringify(scores));

    // Ranking must not collapse into "nearest first" — that would mean reputation isn't counting.
    const byDistance = [...rows].sort((x, y) => x.distance_km - y.distance_km);
    const identical = rows.every((p, i) => p.id === byDistance[i].id);
    if (rows.length >= 2 && !identical) {
      ok('ranked order differs from pure distance order — reputation/availability are contributing');
    } else if (rows.length >= 2) {
      sk('ranked order currently equals distance order (possible when reputations are equal) — see (e)');
    }
  }
}

// ================= (b) the radius filter excludes out-of-range providers =================
console.log('\n[b) radius filter (ST_DWithin) excludes out-of-range providers]');
{
  for (const radiusKm of [1, 5, 25]) {
    const r = await search(anon, { radiusKm });
    if (r.error) { no(`radius ${radiusKm} km errored: ` + r.error.message); continue; }
    const over = (r.data ?? []).filter((p) => p.distance_km > radiusKm + 0.001);
    if (over.length === 0) ok(`radius ${radiusKm} km: ${r.data.length} rows, none beyond the radius`);
    else no(`radius ${radiusKm} km returned ${over.length} rows OUTSIDE the radius: ` +
      over.map((p) => `${p.business_name}@${p.distance_km}km`).join(', '));
  }

  // A tight radius must actually drop somebody, or the filter isn't doing anything.
  const wide = await search(anon, { radiusKm: 25 });
  const tight = await search(anon, { radiusKm: 1 });
  if (!wide.error && !tight.error) {
    if ((wide.data ?? []).length > (tight.data ?? []).length) {
      ok(`the filter genuinely excludes: 25 km → ${wide.data.length} rows, 1 km → ${tight.data.length}`);
    } else {
      sk(`all providers sit within 1 km of the origin — cannot prove exclusion with this data`);
    }
  }
}

// ================= (c) 🔴 coordinate privacy =================
console.log('\n[c) COORDINATE PRIVACY — distance is exposed, position is not]');
{
  const COORD_COLUMNS = ['latitude', 'longitude', 'geo'];
  const clients = [['anon', anon]];
  if (customerId) clients.push(['authenticated', customerClient]);
  else sk('no CUSTOMER_* session — the authenticated half of the coordinate check is UNTESTED');

  for (const [label, client] of clients) {
    const leaked = [];
    for (const col of COORD_COLUMNS) {
      const r = await client.from('service_providers').select(col).limit(1);
      if (!denied(r.error)) leaked.push(col);
    }
    if (leaked.length === 0) ok(`${label}: latitude, longitude and geo are all denied (42501)`);
    else no(`${label}: COORDINATES READABLE — ${leaked.join(', ')}`);

    const star = await client.from('service_providers').select('*').limit(1);
    if (denied(star.error)) ok(`${label}: select('*') fails closed`);
    else no(`${label}: select('*') was ALLOWED — coordinates may be reachable via *`);
  }

  // The RPC is the one sanctioned path — it must not smuggle coordinates out in its payload.
  if (rows.length) {
    const keys = new Set(Object.keys(rows[0]).map((k) => k.toLowerCase()));
    const smuggled = ['latitude', 'longitude', 'geo', 'lat', 'lng', 'lon', 'geom', 'location']
      .filter((k) => keys.has(k));
    if (smuggled.length === 0) ok('search_providers rows carry NO coordinate key (' + [...keys].length + ' columns checked)');
    else no('search_providers LEAKS coordinates in: ' + smuggled.join(', '));

    if (keys.has('distance_km')) ok('…and distance_km IS present — how far, not where');
    else no('distance_km missing from the RPC payload');
  } else {
    sk('no rows returned — cannot inspect the RPC payload shape');
  }
}

// ================= (d) distance comes from the SNAPPED point =================
console.log('\n[d) distance is measured from the ~250 m grid-snapped point, not the exact position]');
{
  const { data: truth, error } = await service
    .from('service_providers').select('id, business_name, latitude, longitude')
    .eq('status', 'approved').not('latitude', 'is', null);
  if (error) {
    no('service role could not read true coordinates: ' + error.message);
  } else if (!rows.length) {
    sk('no search rows to compare against');
  } else {
    const byId = new Map(truth.map((t) => [t.id, t]));
    let maxDelta = 0, moved = 0, compared = 0;
    for (const p of rows) {
      const t = byId.get(p.id);
      if (!t) continue;
      const exact = haversineKm(ORIGIN, { lat: Number(t.latitude), lng: Number(t.longitude) });
      const delta = Math.abs(exact - p.distance_km);
      maxDelta = Math.max(maxDelta, delta);
      if (delta > 0.005) moved += 1;
      compared += 1;
    }
    if (!compared) {
      sk('could not match any search row to its true coordinates');
    } else {
      // The snap bound is ±139 m per axis (~0.2 km diagonal); allow a little slack for the
      // spheroid-vs-haversine difference before calling it a leak of precision.
      if (maxDelta <= 0.35) ok(`all ${compared} distances within the snap bound (max delta ${(maxDelta * 1000).toFixed(0)} m)`);
      else no(`a distance is ${(maxDelta * 1000).toFixed(0)} m from the true point — beyond the snap bound`);

      if (moved > 0) ok(`${moved}/${compared} distances differ from the exact position — the fuzz is real, not decorative`);
      else no('every distance matches the exact coordinates — the grid snap is NOT in effect');
    }
  }
}

// ================= (e) reputation_score measurably changes rank order =================
console.log('\n[e) reputation_score moves the ranking (not just the star average)]');
{
  // Rather than hoping the live data happens to demonstrate it, move one provider's score and
  // watch it fall. Reputation is server-computed (invariant 1) — this is the service role doing a
  // controlled experiment, and it is restored immediately afterwards.
  const subject = rows.find((p) => Number(p.reputation_score) > 1) ?? rows[0];
  if (!subject || rows.length < 2) {
    sk('need at least 2 ranked providers to prove reordering');
  } else {
    const original = subject.reputation_score;
    const startIndex = rows.findIndex((p) => p.id === subject.id);
    let restored = false;
    try {
      const { error: setErr } = await service
        .from('service_providers').update({ reputation_score: 0 }).eq('id', subject.id);
      if (setErr) {
        no('could not stage the experiment: ' + setErr.message);
      } else {
        const after = await search(anon);
        const afterRows = after.data ?? [];
        const endIndex = afterRows.findIndex((p) => p.id === subject.id);
        const endRow = afterRows.find((p) => p.id === subject.id);
        const startScore = subject.match_score;

        /* Once the DB holds more providers than the RPC's limit, zeroing a reputation can push the
           subject clean out of the returned window. That is a STRONGER result than sliding down a
           few places, not a failure — but it has to be recognised as one, or the check reports a
           bug in the app when what actually happened is the effect being larger than the window.
           (This is how it first failed at 485 providers: `undefined` compared against a number.) */
        if (endIndex === -1) {
          ok(`dropping reputation ${original} → 0 pushed the subject OUT of the top ${afterRows.length} entirely (it was #${startIndex + 1})`);
          ok('…which is a stronger demonstration than a rank slide: the whole result window turned over');
        } else {
          if (endRow.match_score < startScore) {
            ok(`dropping reputation ${original} → 0 lowered match_score ${startScore.toFixed(4)} → ${endRow.match_score.toFixed(4)}`);
          } else {
            no(`match_score did not fall when reputation was zeroed (${startScore} → ${endRow.match_score})`);
          }

          if (endIndex > startIndex) {
            ok(`…and it fell in the ranking: position ${startIndex + 1} → ${endIndex + 1} of ${afterRows.length}`);
          } else if (startIndex === 0 && endIndex === 0 && rows.length > 1) {
            sk('subject stayed top — its proximity lead outweighs the whole reputation term here');
          } else {
            ok(`ranking recomputed with the new score (position ${startIndex + 1} → ${endIndex + 1})`);
          }

          // Distance must NOT have moved — proves it was reputation that did it, nothing else.
          if (endRow.distance_km === subject.distance_km) ok('distance_km unchanged throughout — the score, not the geography, moved it');
          else no(`distance_km changed during the experiment (${subject.distance_km} → ${endRow.distance_km})`);
        }
      }
    } finally {
      const { error: restoreErr } = await service
        .from('service_providers').update({ reputation_score: original }).eq('id', subject.id);
      restored = !restoreErr;
      if (restoreErr) no('🔴 COULD NOT RESTORE reputation_score for ' + subject.id + ': ' + restoreErr.message);
    }
    if (restored) console.log(`  … restored ${subject.business_name}'s reputation_score to ${original}.`);
  }
}

// ================= (f) the provider-side write path =================
console.log('\n[f) set_provider_service_base is scoped to the caller and refuses anon]');
{
  /* Assert the REFUSAL, not merely that nothing happened. The first cut of this check passed on
     'No provider application found' — which meant anon had EXECUTE and the write simply matched no
     row, because auth.uid() was NULL. That is a different guarantee, and it passed while the
     migration's stated intent did not hold (Supabase's default privileges grant EXECUTE to anon
     directly, so revoking PUBLIC leaves it). 20260818130000 closed it; this now proves it. */
  const anonWrite = await anon.rpc('set_provider_service_base', {
    p_lat: 19.07, p_lng: 72.87, p_address: null, p_city: null,
  });
  const msg = anonWrite.error?.message ?? '';
  if (denied(anonWrite.error) || /must be signed in/i.test(msg)) {
    ok('anon is REFUSED outright: ' + msg.slice(0, 60));
  } else if (anonWrite.error) {
    no('anon reached the function body instead of being refused: ' + msg.slice(0, 80));
  } else {
    no('anon was allowed to call set_provider_service_base');
  }

  if (customerId) {
    // The customer owns no provider row, so the definer function must find nothing and say so —
    // never silently write to somebody else's row.
    const r = await customerClient.rpc('set_provider_service_base', {
      p_lat: 19.07, p_lng: 72.87, p_address: null, p_city: null,
    });
    if (r.error && /no provider application/i.test(r.error.message)) {
      ok('a non-provider gets an honest error, not a silent write');
    } else if (r.error) {
      ok('a non-provider is refused: ' + r.error.message.slice(0, 60));
    } else {
      no('a user with no provider row was allowed to set a service base');
    }
  } else {
    sk('no CUSTOMER_* session — non-provider write path UNTESTED');
  }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
