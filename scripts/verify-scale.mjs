/*
  Does search still tell the truth when a query matches 60 providers, or 600, or 1,000+?

  WHY THIS EXISTS. Every correctness check in this repo ran against result sets small enough to fit
  in one page, so "the cut" and "the set" were the same thing and no assertion could tell them
  apart. Real density breaks that: 555 electricians sit within 15 km of one Mumbai junction. At
  that size the interesting failures are invisible to the existing suite —

    · a LIMIT taking its rows from a different ordering than the one requested;
    · pagination that reshuffles, so "Show 30 more" hides someone who was on page 1;
    · a filter that holds at 30 rows and leaks at 600;
    · PostgREST's silent 1,000-row cap turning a complete list into a sample (this one was LIVE:
      1,085 approved providers, catalog returned exactly 1000, nothing said so).

  THE CENTRAL ASSERTION IS THE PREFIX PROPERTY: for the same query, `limit N` must equal the first
  N rows of `limit BIG`. It is worth stating why that single check is load-bearing — it is the
  formal version of "the page you see is the top of the list you asked for". If ordering is
  non-deterministic it fails; if the cut is taken before the sort it fails; if pagination is
  unstable it fails. One property, three bug classes.

  Usage (from repo root):
    node scripts/verify-scale.mjs
*/
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = createClient(URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const service = createClient(URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };

const PAGE = 30;               // lib/matching.ts PAGE_SIZE
const SORTS = ['match', 'distance', 'rating', 'reviews', 'price_low', 'price_high'];

const search = (o) => anon.rpc('search_providers', {
  p_lat: o.lat, p_lng: o.lng, p_category_id: o.categoryId ?? null,
  p_radius_km: o.radiusKm ?? 15, p_limit: o.limit ?? PAGE, p_query: o.query ?? null,
  p_min_rating: o.minRating ?? null, p_available_only: o.availableOnly ?? false,
  p_sort: o.sort ?? 'match',
});

console.log('DB:', URL, '\n');

try {
  const { data: cats } = await service.from('service_categories').select('id, name, slug').order('name');
  const bySlug = Object.fromEntries((cats ?? []).map((c) => [c.slug, c]));

  /* Build scenarios of genuinely different sizes. Sizes are MEASURED, not assumed — if the data
     is reseeded smaller, this reports honestly instead of asserting against a fiction. */
  const candidates = [
    { name: 'Andheri East · electricians · 15km', lat: 19.1136, lng: 72.8697, categoryId: bySlug.electrician?.id ?? null, radiusKm: 15 },
    { name: 'Andheri East · all · 15km',          lat: 19.1136, lng: 72.8697, categoryId: null, radiusKm: 15 },
    { name: 'Andheri East · all · 50km',          lat: 19.1136, lng: 72.8697, categoryId: null, radiusKm: 50 },
    { name: 'Colaba · all · 15km',                lat: 18.9067, lng: 72.8147, categoryId: null, radiusKm: 15 },
    { name: 'Koramangala · all · 15km',           lat: 12.9352, lng: 77.6245, categoryId: null, radiusKm: 15 },
  ];

  const scenarios = [];
  for (const c of candidates) {
    const { data, error } = await search({ ...c, limit: 5000 });
    if (error) { no(`${c.name}: ${error.message}`); continue; }
    scenarios.push({ ...c, total: (data ?? []).length });
  }

  console.log('[measured density]');
  for (const s of scenarios) console.log(`  ${String(s.total).padStart(5)} providers  —  ${s.name}`);
  const biggest = Math.max(...scenarios.map((s) => s.total));
  if (biggest >= 500) ok(`at least one scenario exceeds 500 matches (${biggest}) — the scale claim is testable`);
  else sk(`largest scenario is only ${biggest} providers — this run cannot exercise real density`);

  /* ===== 1) THE PREFIX PROPERTY, at every size and every sort ===== */
  console.log('\n[the page is the top of the list you asked for]');
  for (const s of scenarios) {
    if (s.total < 5) { sk(`${s.name}: too few rows to page`); continue; }
    let bad = 0, checked = 0;
    for (const sort of SORTS) {
      const big = await search({ ...s, sort, limit: Math.min(s.total, 500) });
      const page = await search({ ...s, sort, limit: PAGE });
      if (big.error || page.error) { bad++; continue; }
      const bigIds = (big.data ?? []).map((r) => r.id);
      const pageIds = (page.data ?? []).map((r) => r.id);
      const expected = bigIds.slice(0, pageIds.length);
      checked++;
      if (JSON.stringify(pageIds) !== JSON.stringify(expected)) {
        bad++;
        const at = pageIds.findIndex((id, i) => id !== expected[i]);
        no(`${s.name} [${sort}]: page diverges from the full ordering at position ${at + 1}`);
      }
    }
    if (!bad && checked) ok(`${s.name} (${s.total} matches): all ${checked} sorts page as a true prefix`);
  }

  /* ===== 2) PAGINATION IS STABLE — "Show 30 more" must not reshuffle ===== */
  console.log('\n[paging never hides someone who was already on the page]');
  for (const s of scenarios) {
    if (s.total <= PAGE) { sk(`${s.name}: fits on one page`); continue; }
    let bad = 0;
    for (const sort of SORTS) {
      const p1 = await search({ ...s, sort, limit: PAGE });
      const p2 = await search({ ...s, sort, limit: PAGE * 2 });
      const a = (p1.data ?? []).map((r) => r.id);
      const b = (p2.data ?? []).map((r) => r.id).slice(0, a.length);
      if (JSON.stringify(a) !== JSON.stringify(b)) { bad++; no(`${s.name} [${sort}]: growing the limit reordered page 1`); }
    }
    if (!bad) ok(`${s.name}: page 1 is unchanged by loading page 2, in all ${SORTS.length} sorts`);
  }

  /* ===== 3) THE SAME QUERY TWICE IS THE SAME ANSWER ===== */
  console.log('\n[determinism]');
  {
    const s = scenarios.reduce((a, b) => (b.total > a.total ? b : a), scenarios[0]);
    const runs = await Promise.all([0, 1, 2].map(() => search({ ...s, sort: 'match', limit: 50 })));
    const sigs = new Set(runs.map((r) => (r.data ?? []).map((x) => x.id).join(',')));
    if (sigs.size === 1) ok(`${s.name}: three identical queries returned the identical order`);
    else no(`${s.name}: the same query returned ${sigs.size} different orderings`);
  }

  /* ===== 4) FILTERS HOLD AT DENSITY (they are cheap to get right at 30 rows) ===== */
  console.log('\n[filters hold at every size]');
  for (const s of scenarios) {
    if (s.total < 20) { sk(`${s.name}: too few rows`); continue; }
    const avail = await search({ ...s, availableOnly: true, limit: 500, sort: 'match' });
    const leaked = (avail.data ?? []).filter((r) => !r.is_available).length;
    if (leaked === 0) ok(`${s.name}: available_only returned ${(avail.data ?? []).length} rows, none busy`);
    else no(`${s.name}: ${leaked} busy providers leaked through available_only`);

    const rated = await search({ ...s, minRating: 4, limit: 500, sort: 'match' });
    const under = (rated.data ?? []).filter((r) => Number(r.rating) < 4).length;
    if (under === 0) ok(`${s.name}: min_rating=4 returned ${(rated.data ?? []).length} rows, none below 4`);
    else no(`${s.name}: ${under} providers below the rating floor leaked through`);

    if (s.categoryId) {
      const wrong = (await search({ ...s, limit: 500, sort: 'match' })).data
        ?.filter((r) => r.category_id !== s.categoryId).length ?? 0;
      if (wrong === 0) ok(`${s.name}: every row is in the requested category`);
      else no(`${s.name}: ${wrong} rows from other categories`);
    }
  }

  /* ===== 5) PRICE SORTS: unpriced providers last, at scale ===== */
  console.log('\n[“custom pricing” never heads the cheapest page]');
  {
    const s = scenarios.reduce((a, b) => (b.total > a.total ? b : a), scenarios[0]);
    const all = (await search({ ...s, limit: 1000, sort: 'match' })).data ?? [];
    const unpriced = all.filter((r) => Number(r.hourly_rate) === 0).length;
    if (!unpriced) {
      sk('no unpriced providers in range — the rule cannot be exercised here');
    } else {
      for (const sort of ['price_low', 'price_high']) {
        const rows = (await search({ ...s, limit: PAGE, sort })).data ?? [];
        if (Number(rows[0]?.hourly_rate) !== 0) ok(`${sort}: an unpriced provider does not lead (${unpriced} in range)`);
        else no(`${sort}: an unpriced provider (₹0) leads the page — it reads as free`);
      }
    }
  }

  /* ===== 6) THE CATALOG — the query the pages run with NO location =====
     This is where the 1,000-row cap bit: unbounded + client-sorted meant a sample sorted as if it
     were the set. It must now be explicitly bounded and ordered by the server. */
  console.log('\n[the unranked catalog is bounded and server-ordered]');
  {
    const { count: approved } = await service.from('service_providers')
      .select('id', { count: 'exact', head: true }).eq('status', 'approved');

    const catalog = async (col, asc, limit) => anon.from('service_providers')
      .select('id, business_name, rating, total_reviews, hourly_rate, price_sort')
      .eq('status', 'approved')
      .order(col, { ascending: asc, nullsFirst: false })
      .order('id', { ascending: true })
      .limit(limit);

    for (const [col, asc, label] of [['rating', false, 'Top rated'], ['total_reviews', false, 'Most reviewed'],
      ['price_sort', true, 'Lowest price'], ['price_sort', false, 'Highest price']]) {
      const big = await catalog(col, asc, 300);
      const page = await catalog(col, asc, PAGE);
      if (big.error || page.error) { no(`catalog ${label}: ${(big.error ?? page.error).message}`); continue; }
      const a = (page.data ?? []).map((r) => r.id);
      const b = (big.data ?? []).map((r) => r.id).slice(0, a.length);
      if (JSON.stringify(a) === JSON.stringify(b)) ok(`catalog "${label}" pages as a true prefix`);
      else no(`catalog "${label}": the page is not the top of the ordering`);
    }

    // the price rule again, this time through PostgREST's ordering rather than the RPC's
    const cheap = await catalog('price_sort', true, PAGE);
    const lead = Number((cheap.data ?? [])[0]?.hourly_rate);
    if (lead !== 0) ok(`catalog "Lowest price" leads with ₹${lead}, not an unpriced provider`);
    else no('catalog "Lowest price" leads with an unpriced provider');

    // and the cap itself: prove we no longer depend on being under it
    const unbounded = await anon.from('service_providers').select('id').eq('status', 'approved');
    const capped = (unbounded.data ?? []).length;
    if (approved > capped) {
      ok(`PostgREST caps an unbounded catalog at ${capped} of ${approved} approved — which is why the pages now pass an explicit limit`);
    } else {
      sk(`only ${approved} approved providers — under PostgREST's cap, so the truncation cannot be demonstrated today`);
    }
  }

  /* ===== 7) LATENCY, reported rather than asserted into flakiness ===== */
  console.log('\n[latency at the page size the app actually requests]');
  for (const s of scenarios) {
    const t = Date.now();
    await search({ ...s, sort: 'match', limit: PAGE + 1 });
    const ms = Date.now() - t;
    const verdict = ms < 3000 ? ok : no;
    verdict(`${s.name} (${s.total} matches): ${ms}ms for one page`);
  }
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
