/*
  Scale + realism seed for matching and ranking.

  ── WHY THIS WAS REWRITTEN (2026-08-11) ─────────────────────────────────────────────────────────
  The previous version wrote `rating`, `total_reviews` and `reputation_score` straight onto
  service_providers. Measured on the live DB afterwards:

      484 providers claiming 76,367 reviews between them
      8    actual rows in the `reviews` table
      3    distinct reputation_score values across 485 providers  (sd 0.078)

  Two things had happened, and both matter.

  1. `nightly-reputation` (pg_cron, 02:00) runs recompute_all_reputation(), which derives every
     score from REAL reviews and bookings. With no reviews to read it returned the Bayesian prior
     for everyone, flattening the seeded spread overnight. You cannot fake reputation_score — the
     engine owns it (invariant 1) and will overwrite you. That is the system working correctly.

  2. With the reputation term constant, match_score collapsed to
     `0.45 × proximity + 0.10 × availability + a constant`, so "Best match" and "Nearest" returned
     the SAME top-10 SET, merely reshuffled. The ranking code was right; the data made it
     untestable — and made the product look broken, which is how this was noticed.

     Worse, `rating` (fake, 48 distinct values on one page) and `reputation_score` (real, 2 values)
     disagreed, so a 4.96★ provider legitimately sat below a 3.4★ one with no explanation available
     to anyone.

  ── WHAT THIS VERSION DOES INSTEAD ──────────────────────────────────────────────────────────────
  It seeds the INPUTS and lets the server compute the outputs, which is the only kind of test data
  that survives contact with the real system:

    · each provider gets a hidden `quality` — the truth the reviews are noisy samples of;
    · real customers, real bookings, real `reviews` rows dated across the decay window;
    · `rating` / `total_reviews` then come from the update_provider_rating trigger;
    · `reputation_score` comes from recompute_all_reputation().

  Nothing here writes a reputation figure directly. Re-running the nightly job changes nothing,
  because the numbers were already the engine's own.

  The review model is deliberately heavy-tailed: most providers have a handful of reviews, a few
  have hundreds, and some have none at all ("New on Seva"). A uniform 0-320 spread — the old
  version — is not what a marketplace looks like, and it hides the Bayesian shrinkage that is the
  whole point of the Step-7 engine.

  ── USAGE (from repo root) ──────────────────────────────────────────────────────────────────────
    node scripts/seed-scale-providers.mjs --purge
    node scripts/seed-scale-providers.mjs                          # 480 spread over 7 regions
    node scripts/seed-scale-providers.mjs --count 300 --customers 40

    # density for scale testing — N providers in ONE category around ONE city, on top of the spread
    # THIS RUN CREATES. It is not additive to data already in the DB: seeding aborts if any
    # @sevascale.test user exists, so changing the dense city means --purge then reseed, which
    # destroys and rebuilds every seeded booking and review. The spread comes back identical
    # (--seed is deterministic); only the dense cohort moves.
    node scripts/seed-scale-providers.mjs --purge
    node scripts/seed-scale-providers.mjs --count 480 \
         --dense-category electrician --dense-city "Bengaluru" --dense-count 600

    --no-reviews    providers only (fast; leaves every score at the prior — for load tests only)
    --seed N        deterministic re-run

  Every seeded account lives at @sevascale.test and --purge deletes all of them; the auth.users
  cascade takes their providers, bookings and reviews with them. Real test accounts are untouched.
*/
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const EMAIL_DOMAIN = 'sevascale.test';          // non-routable; the purge key
const PROVIDER_PREFIX = 'seva-scale-';
const CUSTOMER_PREFIX = 'seva-cust-';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PURGE = argv.includes('--purge');
const NO_REVIEWS = argv.includes('--no-reviews');
const COUNT = Number(arg('--count', 480));
const CUSTOMERS = Number(arg('--customers', 40));
const SEED = Number(arg('--seed', 20260811));
const DENSE_CATEGORY = arg('--dense-category', null);
const DENSE_CITY = arg('--dense-city', null);
const DENSE_COUNT = Number(arg('--dense-count', 0));

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

/* ── deterministic RNG ─────────────────────────────────────────────────────── */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + rnd() * (hi - lo);
const intBetween = (lo, hi) => Math.floor(between(lo, hi + 1));
/** Box-Muller — review ratings are a noisy read on a provider's true quality, not a uniform draw. */
function gaussian(mean, sd) {
  const u = Math.max(rnd(), 1e-9), v = Math.max(rnd(), 1e-9);
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/* ── real localities ───────────────────────────────────────────────────────────
   Coordinates marked (osm) were resolved from OpenStreetMap; the rest are placed at
   plausible points within the named locality. Good to a few hundred metres, which is the
   resolution the ~250 m grid snap gives anyway. */
/* `pin` is the pincode a provider in that locality would state about THEMSELVES. It is a label on
   seeded rows, never a source of geography: resolve_pincode() builds every anchor from the
   providers' own coordinates (the `lat`/`lng` here), so a mislabelled pincode groups a provider
   slightly oddly and nothing more. It cannot invent a place, which is the whole reason the anchors
   are supply-derived rather than read from a pincode table — see 20260826120000. */
const REGIONS = [
  { city: 'Kalyan', state: 'Maharashtra', weight: 3, localities: [
    { name: 'Khadakpada',            lat: 19.25074, lng: 73.13399, pin: '421301' },   // osm
    { name: 'Birla College Road',    lat: 19.24817, lng: 73.14711, pin: '421301' },   // osm
    { name: 'Kala Talao',            lat: 19.24603, lng: 73.13144, pin: '421301' },   // osm
    { name: 'Kalyan Station',        lat: 19.23522, lng: 73.13449, pin: '421301' },   // osm
    { name: 'Kalyan West',           lat: 19.24035, lng: 73.12528, pin: '421301' },   // osm
    { name: 'Don Bosco School Road', lat: 19.24400, lng: 73.12900, pin: '421301' },   // approx
    { name: 'Rita Memorial School',  lat: 19.25300, lng: 73.14200, pin: '421301' },   // approx
    { name: 'Prem Auto',             lat: 19.24650, lng: 73.13600, pin: '421301' },   // approx
    { name: 'Kolsewadi',             lat: 19.23900, lng: 73.14600, pin: '421306' },
    { name: 'Dombivli East',         lat: 19.20940, lng: 73.08700, pin: '421201' },
  ] },
  { city: 'Mumbai Suburban', state: 'Maharashtra', weight: 3, localities: [
    { name: 'Andheri East',  lat: 19.1136, lng: 72.8697, pin: '400069' },
    { name: 'Bandra West',   lat: 19.0596, lng: 72.8295, pin: '400050' },
    { name: 'Borivali West', lat: 19.2307, lng: 72.8567, pin: '400092' },
    { name: 'Goregaon East', lat: 19.1663, lng: 72.8526, pin: '400063' },
    { name: 'Malad West',    lat: 19.1860, lng: 72.8484, pin: '400064' },
    { name: 'Powai',         lat: 19.1176, lng: 72.9060, pin: '400076' },
    { name: 'Kurla',         lat: 19.0726, lng: 72.8845, pin: '400070' },
    { name: 'Dahisar',       lat: 19.2500, lng: 72.8600, pin: '400068' },
  ] },
  { city: 'Bengaluru', state: 'Karnataka', weight: 3, localities: [
    { name: 'Koramangala',     lat: 12.9352, lng: 77.6245, pin: '560034' },
    { name: 'Indiranagar',     lat: 12.9784, lng: 77.6408, pin: '560038' },
    { name: 'Whitefield',      lat: 12.9698, lng: 77.7500, pin: '560066' },
    { name: 'Jayanagar',       lat: 12.9250, lng: 77.5938, pin: '560041' },
    { name: 'Hebbal',          lat: 13.0358, lng: 77.5970, pin: '560024' },
    { name: 'Electronic City', lat: 12.8452, lng: 77.6602, pin: '560100' },
    { name: 'Marathahalli',    lat: 12.9591, lng: 77.6974, pin: '560037' },
    { name: 'Rajajinagar',     lat: 12.9910, lng: 77.5520, pin: '560010' },
  ] },
  { city: 'Pune', state: 'Maharashtra', weight: 3, localities: [
    { name: 'Kothrud',       lat: 18.5074, lng: 73.8077, pin: '411038' },
    { name: 'Hinjewadi',     lat: 18.5912, lng: 73.7389, pin: '411057' },
    { name: 'Viman Nagar',   lat: 18.5679, lng: 73.9143, pin: '411014' },
    { name: 'Koregaon Park', lat: 18.5362, lng: 73.8939, pin: '411001' },
    { name: 'Baner',         lat: 18.5590, lng: 73.7868, pin: '411045' },
    { name: 'Hadapsar',      lat: 18.5089, lng: 73.9260, pin: '411028' },
    { name: 'Kharadi',       lat: 18.5515, lng: 73.9470, pin: '411014' },
  ] },
  { city: 'Thane', state: 'Maharashtra', weight: 2, localities: [
    { name: 'Thane West',       lat: 19.2183, lng: 72.9781, pin: '400601' },
    { name: 'Ghodbunder Road',  lat: 19.2800, lng: 72.9700, pin: '400607' },
    { name: 'Mulund',           lat: 19.1726, lng: 72.9425, pin: '400080' },
    { name: 'Ulhasnagar',       lat: 19.2215, lng: 73.1645, pin: '421003' },
    { name: 'Ambernath',        lat: 19.2094, lng: 73.1875, pin: '421501' },
    { name: 'Badlapur',         lat: 19.1550, lng: 73.2650, pin: '421503' },
  ] },
  { city: 'Navi Mumbai', state: 'Maharashtra', weight: 2, localities: [
    { name: 'Vashi',    lat: 19.0770, lng: 72.9986, pin: '400703' },
    { name: 'Nerul',    lat: 19.0330, lng: 73.0197, pin: '400706' },
    { name: 'Belapur',  lat: 19.0157, lng: 73.0350, pin: '400614' },
    { name: 'Kharghar', lat: 19.0330, lng: 73.0650, pin: '410210' },
    { name: 'Airoli',   lat: 19.1590, lng: 72.9990, pin: '400708' },
  ] },
  { city: 'Mumbai', state: 'Maharashtra', weight: 2, localities: [
    { name: 'Dadar',   lat: 19.0178, lng: 72.8478, pin: '400014' },
    { name: 'Worli',   lat: 19.0176, lng: 72.8162, pin: '400018' },
    { name: 'Colaba',  lat: 18.9067, lng: 72.8147, pin: '400005' },
    { name: 'Byculla', lat: 18.9750, lng: 72.8330, pin: '400027' },
  ] },
];

const FIRST = ['Suresh', 'Ramesh', 'Anita', 'Priya', 'Imran', 'Vijay', 'Sunita', 'Rahul', 'Deepak',
  'Kavita', 'Manoj', 'Shalini', 'Arjun', 'Farhan', 'Nilesh', 'Pooja', 'Sanjay', 'Meena', 'Rakesh',
  'Jyoti', 'Ganesh', 'Asha', 'Prakash', 'Rekha', 'Amit', 'Swati', 'Vikram', 'Lata', 'Kiran', 'Nikhil'];
const LAST = ['Sharma', 'Patil', 'Yadav', 'Shaikh', 'Iyer', 'Kadam', 'Joshi', 'Naik', 'Gupta',
  'Desai', 'Kulkarni', 'Reddy', 'Nair', 'More', 'Jadhav', 'Bhosale', 'Chavan', 'Pawar', 'Rao', 'Shetty'];

const COMMENTS_GOOD = ['On time and tidy. Would call again.', 'Fixed it in one visit.',
  'Explained the problem before starting. Fair price.', 'Polite and quick.', 'Very professional.'];
const COMMENTS_MID = ['Job done, but arrived late.', 'Fine overall. Charged a bit more than quoted.',
  'Work is okay. Had to call twice.', 'Average — nothing wrong, nothing special.'];
const COMMENTS_BAD = ['Did not finish the work.', 'Turned up two hours late.',
  'Had to get it redone by someone else.', 'Quoted one price, asked for another.'];

/* ── purge ─────────────────────────────────────────────────────────────────── */
async function listSeededUsers() {
  const found = [];
  for (let page = 1; page <= 60; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    const users = data?.users ?? [];
    found.push(...users.filter((u) => (u.email ?? '').endsWith('@' + EMAIL_DOMAIN)));
    if (users.length < 1000) break;
  }
  return found;
}

if (PURGE) {
  console.log('Purging every seeded scale-test account (providers AND customers)…');
  const users = await listSeededUsers();
  console.log(`  ${users.length} seeded auth users found.`);
  const { count: before } = await service.from('service_providers')
    .select('id', { count: 'exact', head: true });
  let removed = 0;
  const CONC = 8;
  for (let i = 0; i < users.length; i += CONC) {
    const batch = users.slice(i, i + CONC);
    const res = await Promise.all(batch.map((u) => service.auth.admin.deleteUser(u.id)));
    removed += res.filter((r) => !r.error).length;
    const err = res.find((r) => r.error);
    if (err) console.log('  ! ' + err.error.message);
    if (removed % 100 < CONC && removed) console.log(`  … ${removed}/${users.length}`);
  }
  const { count: after } = await service.from('service_providers')
    .select('id', { count: 'exact', head: true });
  const { count: revs } = await service.from('reviews').select('id', { count: 'exact', head: true });
  const { count: bks } = await service.from('bookings').select('id', { count: 'exact', head: true });
  console.log(`  deleted ${removed} users; service_providers ${before} → ${after} (cascade).`);
  console.log(`  remaining: ${bks} bookings, ${revs} reviews (these belong to the real test accounts).`);
  process.exit(0);
}

/* ── seed ──────────────────────────────────────────────────────────────────── */
const { data: categories, error: catErr } = await service
  .from('service_categories').select('id, name, slug').order('name');
if (catErr || !categories?.length) {
  console.log('Cannot seed: no service_categories (' + (catErr?.message ?? 'empty') + ')');
  process.exit(1);
}

const existing = await listSeededUsers();
if (existing.length) {
  console.log(`⚠ ${existing.length} seeded users already exist. Run with --purge first to reseed cleanly.`);
  process.exit(1);
}

let denseCategory = null, denseRegion = null;
if (DENSE_COUNT > 0) {
  denseCategory = categories.find((c) => c.slug === DENSE_CATEGORY);
  denseRegion = REGIONS.find((r) => r.city.toLowerCase() === String(DENSE_CITY).toLowerCase());
  if (!denseCategory) { console.log(`Cannot seed: no category with slug "${DENSE_CATEGORY}".`); process.exit(1); }
  if (!denseRegion) { console.log(`Cannot seed: no seeded region named "${DENSE_CITY}".`); process.exit(1); }
}

const TOTAL = COUNT + DENSE_COUNT;
console.log(`${categories.length} categories available.`);
console.log(`Seeding ${COUNT} spread providers${DENSE_COUNT ? ` + ${DENSE_COUNT} ${denseCategory.name} in ${denseRegion.city}` : ''}` +
  `, ${CUSTOMERS} customers (seed ${SEED})…`);
const t0 = Date.now();

// Weighted locality pool for the spread population.
const pool = [];
for (const region of REGIONS) {
  for (const loc of region.localities) {
    for (let w = 0; w < region.weight; w++) pool.push({ region, loc });
  }
}

/* Provider plan. `quality` is the hidden truth — reviews are noisy samples of it, and the whole
   point of the Bayesian engine is to recover it from few observations. Most tradespeople are
   competent, a few are excellent, a few are poor: a left-skewed spread, not a uniform one. */
const plans = [];
for (let n = 0; n < TOTAL; n++) {
  const dense = n >= COUNT;
  const { region, loc } = dense
    ? { region: denseRegion, loc: pick(denseRegion.localities) }
    : pool[n % pool.length];
  const category = dense ? denseCategory : pick(categories);
  // ±0.005° ≈ ±550 m — providers cluster around the locality, they don't sit on one pin.
  /* `quality` is the CEILING on how far reputation can ever spread: reviews are noisy samples of
     it, so with infinite reviews review_score converges on it and no more. Measured on the previous
     seed, that ceiling was the binding constraint — the 46+ review band reached sd 0.450 against a
     quality sd of 0.452 (σ 0.75 × √(1−2/π)), i.e. the engine had already recovered everything there
     was to recover. Widening σ to 0.95 lifts the ceiling to ~0.573. It also pulls mean quality from
     4.40 to 4.24 and drops the floor to 2.0, which is the more honest shape anyway: a real
     marketplace has genuinely bad tradespeople, and a seed with none of them cannot show the
     ranking doing its job. */
  const quality = clamp(5 - Math.abs(gaussian(0, 0.95)), 2.0, 5);
  /* Review count: an explicit heavy-tailed mixture rather than a uniform draw. A young marketplace
     looks like this — most providers have a handful of reviews, a minority have real track records,
     and a chunk are genuinely new. It matters for more than realism: the Bayesian shrinkage in
     compute_reputation only becomes visible when review COUNTS differ, so a uniform 0-320 spread
     (the oldest version) hid the very mechanism Step 7 exists for.

     Bands shifted up on 2026-08-12 (mean ≈ 12 → ≈ 20). compute_reputation shrinks toward a prior of
     4.0 with c_confidence = 5 virtual reviews, so a provider only escapes the prior once their
     time-decayed weight clears 5. Measured on the previous seed, 878 of 1,085 providers (81%) sat at
     ≤10 reviews and scored sd 0.192 — the prior, not their work, was setting their rank. The tail
     lengthens to 180 because a marketplace's visible winners are the ones with real track records,
     and they are what "Best match" has to be able to surface.

     Cost is still the reason these are bands and not an exp() tail: mean ≈ 20 puts 1,000 providers
     at ~21k reviews, up from ~13k but nowhere near the ~50k an exponential would have produced. */
  const roll = rnd();
  const reviewCount = roll < 0.15 ? 0
    : roll < 0.65 ? intBetween(2, 12)
    : roll < 0.93 ? intBetween(13, 50)
    : intBetween(51, 180);
  plans.push({
    dense,
    region, loc, category, quality, reviewCount,
    first: pick(FIRST), last: pick(LAST),
    lat: loc.lat + between(-0.005, 0.005),
    lng: loc.lng + between(-0.005, 0.005),
    experience_years: intBetween(1, 22),
    /* ~8% quote per job rather than per hour. hourly_rate 0 is a REAL product state — the cards
       render it as "Custom pricing" / "Contact for pricing", and the price sorts have a specific
       rule that those providers go LAST in both directions rather than heading the cheapest page.
       The old seeder never produced one, so both the UI branch and the rule were untested by
       construction, and verify-scale had to skip that assertion honestly. */
    hourly_rate: rnd() < 0.08 ? 0 : intBetween(3, 16) * 50,
    trust_tier: rnd() < 0.6 ? 1 : rnd() < 0.8 ? 2 : 3,
    is_available: rnd() < 0.85,
    // Operational history: most providers complete, some cancel, a few get disputed.
    cancelRate: rnd() < 0.7 ? between(0, 0.06) : between(0.06, 0.25),
    disputeRate: rnd() < 0.85 ? 0 : between(0.02, 0.10),
  });
}

/* ── 1) auth users ─────────────────────────────────────────────────────────── */
const CONCURRENCY = 8;
let created = 0, failed = 0;

async function makeUser(email, password, meta) {
  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: meta,
  });
  if (error) { failed++; return null; }
  created++;
  if (created % 100 === 0) console.log(`  … ${created} auth users`);
  return data.user.id;
}

for (let i = 0; i < TOTAL; i += CONCURRENCY) {
  const slice = plans.slice(i, i + CONCURRENCY);
  const ids = await Promise.all(slice.map((p, k) => makeUser(
    `${PROVIDER_PREFIX}${i + k}@${EMAIL_DOMAIN}`, `Scale#${SEED}#${i + k}`,
    { seeded: true, full_name: `${p.first} ${p.last}` },
  )));
  ids.forEach((id, k) => { slice[k].userId = id; });
}

const customerIds = [];
for (let i = 0; i < CUSTOMERS; i += CONCURRENCY) {
  const ids = await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, CUSTOMERS - i) }, (_, k) => makeUser(
      `${CUSTOMER_PREFIX}${i + k}@${EMAIL_DOMAIN}`, `Cust#${SEED}#${i + k}`,
      { seeded: true, full_name: `${pick(FIRST)} ${pick(LAST)}` },
    )),
  );
  customerIds.push(...ids.filter(Boolean));
}
console.log(`  ${created} auth users created (${failed} failed) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* ── 2) provider rows ──────────────────────────────────────────────────────────
   `trg_provider_birth` (BEFORE INSERT) forces every new row to be born pending/unverified and
   ZEROES rating/reputation_score/total_reviews — invariant 1, and it applies to the service role
   too. So approval is a separate UPDATE, exactly as review_provider_application does it.
   🔴 Note what is NOT in that UPDATE any more: rating, total_reviews, reputation_score. Those are
   now earned from real reviews below, because the nightly job recomputes them from reviews anyway
   and would erase anything written here. */
const usable = plans.filter((p) => p.userId);
let inserted = 0;
for (let i = 0; i < usable.length; i += 100) {
  const batch = usable.slice(i, i + 100).map((p) => ({
    user_id: p.userId,
    category_id: p.category.id,
    business_name: `${p.first} ${p.last}`,
    bio: `${p.category.name} serving ${p.loc.name} and nearby areas of ${p.region.city}.`,
    experience_years: p.experience_years,
    hourly_rate: p.hourly_rate,
    /* 🔴 trust_tier is NOT written here. It is derived by recompute_trust_tier() from verified
       provider_documents in step 3c — the same rule that erased the reputation scores overnight
       applies to tiers, because nightly-expire-documents re-derives them too. */
    is_available: p.is_available,
    city: p.region.city,
    state: p.region.state,
    address: p.loc.name,
    pincode: p.loc.pin,
    latitude: Number(p.lat.toFixed(6)),
    longitude: Number(p.lng.toFixed(6)),
    kyc_status: 'verified',
    applied_at: new Date().toISOString(),
    reviewed_at: new Date().toISOString(),
  }));
  const { data, error } = await service.from('service_providers').insert(batch).select('id');
  if (error) { console.log('  ! insert batch failed: ' + error.message); continue; }
  (data ?? []).forEach((row, k) => { usable[i + k].providerId = row.id; });
  inserted += batch.length;
}

let approved = 0;
const withId = usable.filter((p) => p.providerId);
for (let i = 0; i < withId.length; i += 50) {
  const res = await Promise.all(withId.slice(i, i + 50).map((p) => service.from('service_providers')
    .update({ status: 'approved', is_verified: true, kyc_status: 'verified' }).eq('id', p.providerId)));
  approved += res.filter((r) => !r.error).length;
}
console.log(`  ${inserted} provider rows inserted, ${approved} approved.`);

/* ── 3) bookings + reviews: the actual inputs to reputation ────────────────────
   A review needs a booking between those two parties, and compute_reputation reads BOTH: reviews
   (Bayesian, 90-day half-life) and booking outcomes (completion / cancellation / dispute). So the
   history has to be plausible on both axes, and DATED — an all-today history would decay
   identically for everyone and flatten the very spread we are creating. */
if (NO_REVIEWS) {
  console.log('  --no-reviews: skipping history. Every score will sit at the prior.');
} else if (!customerIds.length) {
  console.log('  ! no customers created — cannot seed reviews.');
} else {
  const DAY = 86400000;
  const bookingRows = [], reviewPlans = [];

  /* The DEMO providers get history too. They are seeded by migration 20260710121000 with fake
     rating/total_reviews and no reviews, so 20260825120000 correctly reset them to "New on Seva" —
     truthful, but it leaves the four best-known names on the platform looking empty. They are real
     approved providers, so they should look like real approved providers. Matched on their
     @seva.demo owner e-mail: precise enough to leave the actual test accounts (which have their
     own genuine history) and the ui-check litter alone. */
  const { data: demoUsers } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const demoIds = (demoUsers?.users ?? [])
    .filter((u) => (u.email ?? '').endsWith('@seva.demo')).map((u) => u.id);
  const { data: demoProviders } = demoIds.length
    ? await service.from('service_providers')
        .select('id, category_id, hourly_rate, city, address').in('user_id', demoIds).eq('status', 'approved')
    : { data: [] };

  const cohort = [...withId, ...(demoProviders ?? []).map((d) => ({
    providerId: d.id,
    category: { id: d.category_id },
    loc: { name: d.address ?? d.city ?? 'Mumbai' },
    hourly_rate: Number(d.hourly_rate) || 400,
    quality: clamp(5 - Math.abs(gaussian(0, 0.6)), 3.2, 5),      // demo names read as established
    reviewCount: intBetween(25, 90),
    cancelRate: between(0, 0.05),
    disputeRate: 0,
  }))];
  if ((demoProviders ?? []).length) {
    console.log(`  including ${demoProviders.length} @seva.demo providers in the history pass`);
  }

  for (const p of cohort) {
    const completed = p.reviewCount + intBetween(0, Math.ceil(p.reviewCount * 0.6) + 2);
    const cancels = Math.round(completed * p.cancelRate);
    const disputes = Math.round(completed * p.disputeRate);

    for (let i = 0; i < completed + cancels + disputes; i++) {
      const isCancel = i >= completed && i < completed + cancels;
      const isDispute = i >= completed + cancels;
      /* Skewed RECENT, not uniform over the window. This is the cheapest fix of the three and was
         the least obvious: compute_reputation decays reviews on a ~90-day half-life, so a date
         drawn uniformly from 1-200 days is worth only ~0.51 of its face weight on average, and ten
         real reviews landed at Σw ≈ 5.1 against a prior weight of 5 — a dead heat the prior wins
         half of. Weighting toward recent lifts that average to ~0.64 for the same number of rows,
         costing nothing in runtime. It is also what a GROWING marketplace looks like: volume rises
         over time, so most reviews are recent ones. u^1.8 over the same 200-day window. */
      const daysAgo = Math.floor(1 + 199 * Math.pow(rnd(), 1.8));
      const when = new Date(Date.now() - daysAgo * DAY).toISOString();
      const amount = p.hourly_rate * 2;
      bookingRows.push({
        row: {
          customer_id: pick(customerIds), provider_id: p.providerId, category_id: p.category.id,
          service_type: 'one-time',
          scheduled_date: when.slice(0, 10), scheduled_time: '11:00',
          duration_hours: 2, hourly_rate: p.hourly_rate, total_amount: amount,
          price_agreed: amount, price_charged: isCancel ? null : amount,
          payment_method: 'upi',
          status: isCancel ? 'cancelled' : isDispute ? 'disputed' : 'reviewed',
          payment_status: isCancel ? 'pending' : isDispute ? 'held' : 'released',
          created_at: when, updated_at: when,
          address: `${intBetween(1, 90)} ${p.loc.name}`,
          service_pincode: null,
        },
        // Only the first `reviewCount` completed bookings carry a review.
        review: (!isCancel && !isDispute && i < p.reviewCount)
          ? { quality: p.quality, when, providerId: p.providerId }
          : null,
      });
    }
  }

  console.log(`  seeding ${bookingRows.length} bookings…`);
  let bkDone = 0;
  for (let i = 0; i < bookingRows.length; i += 200) {
    const slice = bookingRows.slice(i, i + 200);
    const { data, error } = await service.from('bookings').insert(slice.map((b) => b.row)).select('id, customer_id');
    if (error) { console.log('  ! booking batch failed: ' + error.message); continue; }
    (data ?? []).forEach((row, k) => {
      const src = slice[k];
      if (src.review) reviewPlans.push({ ...src.review, bookingId: row.id, customerId: row.customer_id });
    });
    bkDone += slice.length;
    if (bkDone % 2000 < 200) console.log(`    … ${bkDone}/${bookingRows.length} bookings`);
  }

  console.log(`  seeding ${reviewPlans.length} reviews…`);
  let revDone = 0;
  for (let i = 0; i < reviewPlans.length; i += 200) {
    const batch = reviewPlans.slice(i, i + 200).map((r) => {
      // A noisy read on the hidden quality, rounded to whole stars like a real rater.
      const stars = Math.round(clamp(gaussian(r.quality, 0.65), 1, 5));
      const comments = stars >= 4 ? COMMENTS_GOOD : stars === 3 ? COMMENTS_MID : COMMENTS_BAD;
      return {
        booking_id: r.bookingId, customer_id: r.customerId, provider_id: r.providerId,
        reviewer_id: r.customerId, direction: 'customer_to_provider',
        rating: stars, comment: pick(comments),
        rating_quality: Math.round(clamp(gaussian(r.quality, 0.8), 1, 5)),
        rating_punctuality: Math.round(clamp(gaussian(r.quality, 0.9), 1, 5)),
        rating_communication: Math.round(clamp(gaussian(r.quality, 0.8), 1, 5)),
        rating_price_fairness: Math.round(clamp(gaussian(r.quality, 0.9), 1, 5)),
        created_at: r.when,
      };
    });
    const { error } = await service.from('reviews').insert(batch);
    if (error) { console.log('  ! review batch failed: ' + error.message); continue; }
    revDone += batch.length;
    if (revDone % 2000 < 200) console.log(`    … ${revDone}/${reviewPlans.length} reviews`);
  }
  console.log(`  ${bkDone} bookings, ${revDone} reviews written.`);

  /* ── 3b) THE ARTIFACTS A REAL BOOKING LEAVES BEHIND ──────────────────────────
     A booking written straight into the table is not the same object a booking created through
     the app is. The app's version accumulates a `booking_events` row per transition (that trail IS
     the timeline the detail page renders) and, once escrow settles, a `payment_transactions` row.
     Measured before this: 20,202 seeded bookings shared 145 events and 24 payments between them —
     so every seeded booking rendered an empty timeline, and the escrow ledger described almost
     none of the money the platform believed it had moved.

     Driving 20k bookings through transition_booking would be the perfect fidelity and is not
     affordable (~7 RPCs each, per-party auth). So the trail is SYNTHESISED to match exactly what
     that function would have written — the same statuses, the same actor_role per step, ordered
     timestamps between creation and settlement. Shapes copied from real rows in the DB rather than
     invented. */
  const settledIds = [], eventRows = [], paymentRows = [];
  /* Re-read what we just wrote — we need ids and final statuses together, and the insert only
     returned ids. Paged explicitly at 1,000: PostgREST caps there silently, and a truncated read
     would leave the newest bookings with no timeline for no visible reason. */
  let cursor = 0;
  const allBookings = [];
  const seenBooking = new Set();
  for (;;) {
    const { data } = await service.from('bookings')
      .select('id, status, total_amount, created_at')
      /* 🔴 ORDER BY id, not created_at. Thousands of seeded bookings share a created_at and
         Postgres is free to order ties differently per page, so range() paging over a
         non-unique key returns some rows TWICE and skips others. It did: 144,795 events where
         ~112k were expected, and a duplicate-key violation on payment_transactions that aborted
         the payment pass at 8,000 of 17,851 rows.
         This is the same unstable-pagination defect verify-scale.mjs asserts search against
         (20260824120000 added an id tie-break for exactly this) — committed here by the very
         script that seeds the data those assertions run on. A unique key, plus a belt-and-braces
         dedupe below, because a silent duplicate is worse than a slow read. */
      .order('id', { ascending: true })
      .range(cursor, cursor + 999);
    if (!data?.length) break;
    for (const b of data) if (!seenBooking.has(b.id)) { seenBooking.add(b.id); allBookings.push(b); }
    if (data.length < 1000) break;
    cursor += 1000;
  }

  // The exact ladder transition_booking walks, per terminal status.
  const LADDER = {
    reviewed:  [['requested','accepted','provider'], ['accepted','en_route','provider'],
                ['en_route','arrived','provider'], ['arrived','in_progress','provider'],
                ['in_progress','completed','provider'], ['completed','confirmed','customer'],
                ['confirmed','paid','system'], ['paid','reviewed','customer']],
    disputed:  [['requested','accepted','provider'], ['accepted','en_route','provider'],
                ['en_route','arrived','provider'], ['arrived','in_progress','provider'],
                ['in_progress','completed','provider'], ['completed','disputed','customer']],
    cancelled: [['requested','cancelled','customer']],
  };

  for (const b of allBookings) {
    const steps = LADDER[b.status];
    if (!steps) continue;                                   // requested/accepted etc. — nothing yet
    const born = new Date(b.created_at).getTime();
    for (let i = 0; i < steps.length; i++) {
      const [from, to, role] = steps[i];
      eventRows.push({
        booking_id: b.id, from_status: from, to_status: to,
        actor_id: null, actor_role: role,
        // Spread across the day the job ran, in order, so the timeline reads plausibly.
        created_at: new Date(born + (i + 1) * 45 * 60 * 1000).toISOString(),
      });
    }
    if (b.status === 'reviewed') {
      const rupees = Number(b.total_amount) || 0;
      const fee = Math.round(rupees * 0.01 * 100) / 100;     // the 1% platform fee (20260730120000)
      settledIds.push(b.id);
      paymentRows.push({
        booking_id: b.id,
        // Shaped like Razorpay's ids so nothing downstream has to special-case seeded rows;
        // prefixed 'seed' so they can never be mistaken for a reconcilable real payment.
        razorpay_order_id: 'order_seed' + b.id.replace(/-/g, '').slice(0, 14),
        razorpay_payment_id: 'pay_seed' + b.id.replace(/-/g, '').slice(0, 16),
        amount: Math.round(rupees * 100),                    // PAISE, as the live rows are
        currency: 'INR', status: 'released',
        platform_fee: fee, provider_amount: Math.round((rupees - fee) * 100) / 100,
        created_at: b.created_at,
      });
    }
  }

  console.log(`  seeding ${eventRows.length} booking_events and ${paymentRows.length} payment rows…`);
  /* Returns { done, failed } rather than bailing at the first bad batch. The previous version
     returned early, so one duplicate-key error left 8,000 of 17,851 payments written and reported
     the truncated number as if it were the total — a partial seed that looks like a finished one. */
  const bulk = async (table, rows, label) => {
    let done = 0, failed = 0, firstError = null;
    for (let i = 0; i < rows.length; i += 500) {
      const slice = rows.slice(i, i + 500);
      const { error } = await service.from(table).insert(slice);
      if (error) { failed += slice.length; firstError ??= error.message; }
      else done += slice.length;
      if ((done + failed) % 5000 < 500) console.log(`    … ${done + failed}/${rows.length} ${label}`);
    }
    if (failed) console.log(`  🔴 ${label}: ${failed} rows FAILED (${firstError}) — the seed is incomplete`);
    return done;
  };
  const ev = await bulk('booking_events', eventRows, 'events');
  const pay = await bulk('payment_transactions', paymentRows, 'payments');
  console.log(`  ${ev} booking_events, ${pay} payment_transactions written.`);

  /* ── 3c) DOCUMENTS, so the TRUST TIER is EARNED ──────────────────────────────
     🔴 The same mistake reputation_score taught us, in a third place. trust_tier was written
     directly by this seeder: 435 providers carried tier 2 or 3 with ZERO verified documents.
     recompute_trust_tier() derives the tier from verified provider_documents (and
     provider_experience), and `nightly-expire-documents` re-runs that logic every night — so those
     tiers were fiction with an expiry date, exactly like the reputation scores were.

     Seed the EVIDENCE instead:
       photo_id + selfie  → every approved provider (the launch KYC baseline)  → tier 1
       a credential doc   → ~30%                                              → tier 2
       police_verification→ ~8%, with a future expiry                         → tier 3
     …then let the function decide. Note `id_secondary`/`pan` are deliberately NOT used as the
     credential: 20260817120000 excludes them precisely so a PAN photocopy cannot buy the tier a
     trade certificate is supposed to mean. */
  const CREDENTIALS = ['rpl_cert', 'council_reg', 'fssai', 'insurance', 'rc'];
  const docRows = [];
  for (const p of cohort) {
    const base = { provider_id: p.providerId, verification_status: 'verified', verified_source: 'admin',
      verified_at: new Date().toISOString(), file_path: null, meta: { seeded: true } };
    docRows.push({ ...base, doc_code: 'photo_id' }, { ...base, doc_code: 'selfie' });
    const roll = rnd();
    if (roll < 0.30) docRows.push({ ...base, doc_code: pick(CREDENTIALS) });
    if (roll < 0.08) {
      docRows.push({ ...base, doc_code: 'police_verification',
        // Must be in the future or recompute_trust_tier ignores it — an expired check is no check.
        expires_at: new Date(Date.now() + 300 * DAY).toISOString().slice(0, 10) });
    }
  }
  const docs = await bulk('provider_documents', docRows, 'documents');
  console.log(`  ${docs} provider_documents written (file_path null — metadata only, no image).`);

  console.log('  recomputing trust tiers from those documents…');
  let tiered = 0;
  for (let i = 0; i < cohort.length; i += 40) {
    const res = await Promise.all(cohort.slice(i, i + 40)
      .map((p) => service.rpc('recompute_trust_tier', { p_provider_id: p.providerId })));
    tiered += res.filter((r) => !r.error).length;
  }
  console.log(`  ${tiered} trust tiers recomputed by the engine (not written by this script).`);
}

/* ── 4) let the ENGINE compute the scores ──────────────────────────────────── */
console.log('  running recompute_all_reputation() — the same function the nightly cron runs…');
const tRep = Date.now();
const { error: repErr } = await service.rpc('recompute_all_reputation');
if (repErr) console.log('  ! recompute_all_reputation failed: ' + repErr.message);
else console.log(`  reputation recomputed in ${((Date.now() - tRep) / 1000).toFixed(1)}s`);

/* ── 5) report the distribution, because a seed you cannot see is a seed you cannot trust ──
   Report from where the density actually IS. This was pinned to Mumbai centre, which silently
   measured the wrong cohort the moment --dense-city named anywhere else: a Bengaluru density run
   would print the Maharashtra spread's stats and fire (or fail to fire) the narrow-spread warning
   on providers the run never touched. The default stays Mumbai centre only because that is where
   the unweighted spread is thickest. */
const reportAt = denseRegion
  ? { name: `${denseRegion.city} (dense cohort)`, lat: denseRegion.localities[0].lat, lng: denseRegion.localities[0].lng }
  : { name: 'Mumbai centre', lat: 19.0760, lng: 72.8777 };
const { data: stats } = await service.rpc('search_providers', {
  p_lat: reportAt.lat, p_lng: reportAt.lng, p_category_id: null, p_radius_km: 15, p_limit: 1000,
  p_query: null, p_min_rating: null, p_available_only: false, p_sort: 'match',
});
const { count: total } = await service.from('service_providers')
  .select('id', { count: 'exact', head: true }).eq('status', 'approved');

console.log(`\n${total} approved providers now in the DB.`);
if (stats?.length) {
  const reps = stats.map((r) => Number(r.reputation_score));
  const rats = stats.map((r) => Number(r.rating)).filter((v) => v > 0);
  const uniq = new Set(reps.map((v) => v.toFixed(2)));
  const mean = reps.reduce((a, b) => a + b, 0) / reps.length;
  const sd = Math.sqrt(reps.reduce((a, b) => a + (b - mean) ** 2, 0) / reps.length);
  console.log(`\nWithin 15 km of ${reportAt.name} (${stats.length} providers):`);
  console.log(`  reputation_score : ${Math.min(...reps).toFixed(2)} – ${Math.max(...reps).toFixed(2)}` +
    `  mean ${mean.toFixed(2)}  sd ${sd.toFixed(3)}  (${uniq.size} distinct values)`);
  if (rats.length) console.log(`  star rating      : ${Math.min(...rats).toFixed(2)} – ${Math.max(...rats).toFixed(2)} across ${rats.length} rated providers`);
  console.log(`  unrated ("New on Seva"): ${stats.length - rats.length}`);
  if (sd < 0.2) console.log('  ⚠ reputation spread is still narrow — ranking will look like plain proximity.');
}
console.log(`\nTotal time ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
console.log(`To remove every seeded account:  node scripts/seed-scale-providers.mjs --purge`);
