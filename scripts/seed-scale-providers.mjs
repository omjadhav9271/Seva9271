/*
  Scale-test seed for Step-11 matching: hundreds of approved providers spread across real
  localities in Bengaluru, Pune, Mumbai City, Mumbai Suburban, Thane, Kalyan-Dombivli and
  Navi Mumbai — so proximity ranking can be judged at realistic density instead of 5 rows.

  Every seeded provider needs its own auth user: service_providers.user_id is NOT NULL, unique
  per user, and FK'd to auth.users ON DELETE CASCADE. That cascade is the teardown — deleting the
  seeded auth users removes their provider rows with them.

  Seed data is written with the SERVICE ROLE, which bypasses RLS and column grants on purpose:
  reputation_score and trust_tier are server-computed in real life (invariant 1) and are set here
  only so ranking has something to rank. Nothing in the app can do this.

  Deterministic: the same --seed produces the same providers, so a rerun is reproducible.

  Usage (from repo root):
    node scripts/seed-scale-providers.mjs               # seed the default 480
    node scripts/seed-scale-providers.mjs --count 200
    node scripts/seed-scale-providers.mjs --purge       # remove EVERY seeded provider + user
*/
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const EMAIL_DOMAIN = 'sevascale.test';          // non-routable; the purge key
const EMAIL_PREFIX = 'seva-scale-';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PURGE = argv.includes('--purge');
const COUNT = Number(arg('--count', 480));
const SEED = Number(arg('--seed', 20260810));

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

/* ── real localities ───────────────────────────────────────────────────────────
   Coordinates marked (osm) were resolved from OpenStreetMap; the rest are placed at
   plausible points within the named locality. Good to a few hundred metres, which is the
   resolution the ~250 m grid snap gives anyway. */
const REGIONS = [
  { city: 'Kalyan', state: 'Maharashtra', weight: 3, localities: [
    { name: 'Khadakpada',            lat: 19.25074, lng: 73.13399 },   // osm
    { name: 'Birla College Road',    lat: 19.24817, lng: 73.14711 },   // osm
    { name: 'Kala Talao',            lat: 19.24603, lng: 73.13144 },   // osm
    { name: 'Kalyan Station',        lat: 19.23522, lng: 73.13449 },   // osm
    { name: 'Kalyan West',           lat: 19.24035, lng: 73.12528 },   // osm
    { name: 'Don Bosco School Road', lat: 19.24400, lng: 73.12900 },   // approx
    { name: 'Rita Memorial School',  lat: 19.25300, lng: 73.14200 },   // approx
    { name: 'Prem Auto',             lat: 19.24650, lng: 73.13600 },   // approx
    { name: 'Kolsewadi',             lat: 19.23900, lng: 73.14600 },
    { name: 'Dombivli East',         lat: 19.20940, lng: 73.08700 },
  ] },
  { city: 'Mumbai Suburban', state: 'Maharashtra', weight: 3, localities: [
    { name: 'Andheri East',  lat: 19.1136, lng: 72.8697 },
    { name: 'Bandra West',   lat: 19.0596, lng: 72.8295 },
    { name: 'Borivali West', lat: 19.2307, lng: 72.8567 },
    { name: 'Goregaon East', lat: 19.1663, lng: 72.8526 },
    { name: 'Malad West',    lat: 19.1860, lng: 72.8484 },
    { name: 'Powai',         lat: 19.1176, lng: 72.9060 },
    { name: 'Kurla',         lat: 19.0726, lng: 72.8845 },
    { name: 'Dahisar',       lat: 19.2500, lng: 72.8600 },
  ] },
  { city: 'Bengaluru', state: 'Karnataka', weight: 3, localities: [
    { name: 'Koramangala',     lat: 12.9352, lng: 77.6245 },
    { name: 'Indiranagar',     lat: 12.9784, lng: 77.6408 },
    { name: 'Whitefield',      lat: 12.9698, lng: 77.7500 },
    { name: 'Jayanagar',       lat: 12.9250, lng: 77.5938 },
    { name: 'Hebbal',          lat: 13.0358, lng: 77.5970 },
    { name: 'Electronic City', lat: 12.8452, lng: 77.6602 },
    { name: 'Marathahalli',    lat: 12.9591, lng: 77.6974 },
    { name: 'Rajajinagar',     lat: 12.9910, lng: 77.5520 },
  ] },
  { city: 'Pune', state: 'Maharashtra', weight: 3, localities: [
    { name: 'Kothrud',       lat: 18.5074, lng: 73.8077 },
    { name: 'Hinjewadi',     lat: 18.5912, lng: 73.7389 },
    { name: 'Viman Nagar',   lat: 18.5679, lng: 73.9143 },
    { name: 'Koregaon Park', lat: 18.5362, lng: 73.8939 },
    { name: 'Baner',         lat: 18.5590, lng: 73.7868 },
    { name: 'Hadapsar',      lat: 18.5089, lng: 73.9260 },
    { name: 'Kharadi',       lat: 18.5515, lng: 73.9470 },
  ] },
  { city: 'Thane', state: 'Maharashtra', weight: 2, localities: [
    { name: 'Thane West',       lat: 19.2183, lng: 72.9781 },
    { name: 'Ghodbunder Road',  lat: 19.2800, lng: 72.9700 },
    { name: 'Mulund',           lat: 19.1726, lng: 72.9425 },
    { name: 'Ulhasnagar',       lat: 19.2215, lng: 73.1645 },
    { name: 'Ambernath',        lat: 19.2094, lng: 73.1875 },
    { name: 'Badlapur',         lat: 19.1550, lng: 73.2650 },
  ] },
  { city: 'Navi Mumbai', state: 'Maharashtra', weight: 2, localities: [
    { name: 'Vashi',    lat: 19.0770, lng: 72.9986 },
    { name: 'Nerul',    lat: 19.0330, lng: 73.0197 },
    { name: 'Belapur',  lat: 19.0157, lng: 73.0350 },
    { name: 'Kharghar', lat: 19.0330, lng: 73.0650 },
    { name: 'Airoli',   lat: 19.1590, lng: 72.9990 },
  ] },
  { city: 'Mumbai', state: 'Maharashtra', weight: 2, localities: [
    { name: 'Dadar',   lat: 19.0178, lng: 72.8478 },
    { name: 'Worli',   lat: 19.0176, lng: 72.8162 },
    { name: 'Colaba',  lat: 18.9067, lng: 72.8147 },
    { name: 'Byculla', lat: 18.9750, lng: 72.8330 },
  ] },
];

const FIRST = ['Suresh', 'Ramesh', 'Anita', 'Priya', 'Imran', 'Vijay', 'Sunita', 'Rahul', 'Deepak',
  'Kavita', 'Manoj', 'Shalini', 'Arjun', 'Farhan', 'Nilesh', 'Pooja', 'Sanjay', 'Meena', 'Rakesh',
  'Jyoti', 'Ganesh', 'Asha', 'Prakash', 'Rekha', 'Amit', 'Swati', 'Vikram', 'Lata', 'Kiran', 'Nikhil'];
const LAST = ['Sharma', 'Patil', 'Yadav', 'Shaikh', 'Iyer', 'Kadam', 'Joshi', 'Naik', 'Gupta',
  'Desai', 'Kulkarni', 'Reddy', 'Nair', 'More', 'Jadhav', 'Bhosale', 'Chavan', 'Pawar', 'Rao', 'Shetty'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  console.log('Purging seeded scale-test providers…');
  const users = await listSeededUsers();
  console.log(`  ${users.length} seeded auth users found.`);
  const { count: before } = await service.from('service_providers')
    .select('id', { count: 'exact', head: true });
  let removed = 0;
  for (const u of users) {
    const { error } = await service.auth.admin.deleteUser(u.id);
    if (error) console.log('  ! ' + u.email + ': ' + error.message);
    else removed++;
    if (removed % 50 === 0 && removed) console.log(`  … ${removed}/${users.length}`);
  }
  const { count: after } = await service.from('service_providers')
    .select('id', { count: 'exact', head: true });
  console.log(`  deleted ${removed} users; service_providers ${before} → ${after} (cascade).`);
  process.exit(0);
}

/* ── seed ──────────────────────────────────────────────────────────────────── */
const { data: categories, error: catErr } = await service
  .from('service_categories').select('id, name, slug').order('name');
if (catErr || !categories?.length) {
  console.log('Cannot seed: no service_categories (' + (catErr?.message ?? 'empty') + ')');
  process.exit(1);
}
console.log(`${categories.length} categories available.`);

const existing = await listSeededUsers();
if (existing.length) {
  console.log(`⚠ ${existing.length} seeded users already exist. Run with --purge first to reseed cleanly.`);
  process.exit(1);
}

// Build the weighted locality pool.
const pool = [];
for (const region of REGIONS) {
  for (const loc of region.localities) {
    for (let w = 0; w < region.weight; w++) pool.push({ region, loc });
  }
}

console.log(`Seeding ${COUNT} providers across ${REGIONS.length} regions (seed ${SEED})…`);
const t0 = Date.now();

const CONCURRENCY = 8;
let created = 0, failed = 0;
const rows = [];

async function makeOne(n) {
  const { region, loc } = pool[n % pool.length];
  const category = pick(categories);
  const first = pick(FIRST), last = pick(LAST);
  // ±0.005° ≈ ±550 m — providers cluster around the locality, they don't sit on one pin.
  const lat = loc.lat + between(-0.005, 0.005);
  const lng = loc.lng + between(-0.005, 0.005);
  const email = `${EMAIL_PREFIX}${n}@${EMAIL_DOMAIN}`;

  const { data, error } = await service.auth.admin.createUser({
    email, password: `Scale#${SEED}#${n}`, email_confirm: true,
    user_metadata: { seeded: true, full_name: `${first} ${last}` },
  });
  if (error) { failed++; return; }

  const reviews = intBetween(0, 320);
  rows.push({
    user_id: data.user.id,
    category_id: category.id,
    business_name: `${first} ${last}`,
    bio: `${category.name} serving ${loc.name} and nearby areas of ${region.city}. Seeded scale-test profile.`,
    experience_years: intBetween(1, 22),
    hourly_rate: intBetween(3, 16) * 50,
    rating: Number(between(3.4, 5.0).toFixed(2)),
    total_reviews: reviews,
    reputation_score: Number(between(2.0, 4.9).toFixed(2)),
    trust_tier: rnd() < 0.6 ? 1 : rnd() < 0.8 ? 2 : 3,
    is_verified: true,
    is_available: rnd() < 0.85,
    city: region.city,
    state: region.state,
    address: loc.name,
    latitude: Number(lat.toFixed(6)),
    longitude: Number(lng.toFixed(6)),
    status: 'approved',
    kyc_status: 'verified',
    applied_at: new Date().toISOString(),
    reviewed_at: new Date().toISOString(),
  });
  created++;
  if (created % 50 === 0) console.log(`  … ${created}/${COUNT} users created`);
}

for (let i = 0; i < COUNT; i += CONCURRENCY) {
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, COUNT - i) }, (_, k) => makeOne(i + k)));
}
console.log(`  ${created} auth users created (${failed} failed) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Insert provider rows in batches.
// NOTE: `trg_provider_birth` (BEFORE INSERT) forces every new row to be born pending/unverified —
// invariant 1, and it applies to the service role too. So the status in `rows` is ignored on
// INSERT and has to be granted afterwards by UPDATE, which is exactly what an admin approval does.
// Don't "fix" this by disabling the trigger; the seed should go through the same gate as reality.
let inserted = 0;
const seededIds = [];
for (let i = 0; i < rows.length; i += 100) {
  const batch = rows.slice(i, i + 100);
  const { data, error } = await service.from('service_providers').insert(batch).select('id');
  if (error) console.log('  ! insert batch failed: ' + error.message);
  else { inserted += batch.length; seededIds.push(...(data ?? []).map((r) => r.id)); }
}

/* Approve them and restore the reputation figures the birth trigger zeroed.
   enforce_provider_birth_state() sets status/is_verified/rating/reputation_score/total_reviews/
   total_bookings on INSERT regardless of what was supplied — including for the service role. It is
   BEFORE INSERT only, so an UPDATE is the sanctioned way to grant these, which is precisely what
   review_provider_application and the nightly reputation job do. */
let approved = 0;
for (let i = 0; i < seededIds.length; i += 100) {
  const ids = seededIds.slice(i, i + 100);
  const wanted = ids.map((id, k) => ({ id, src: rows[i + k] }));
  // Per-row values differ, so this is one update per row rather than one per batch.
  const results = await Promise.all(wanted.map(({ id, src }) => service.from('service_providers')
    .update({
      status: 'approved', is_verified: true, kyc_status: 'verified',
      rating: src.rating, total_reviews: src.total_reviews, reputation_score: src.reputation_score,
    }).eq('id', id)));
  approved += results.filter((r) => !r.error).length;
  const firstErr = results.find((r) => r.error);
  if (firstErr) console.log('  ! approve failed: ' + firstErr.error.message);
}
console.log(`  ${approved} rows approved with reputation (born pending+zeroed, as the trigger requires).`);

const { count: total } = await service.from('service_providers')
  .select('id', { count: 'exact', head: true }).eq('status', 'approved');
console.log(`\n${inserted} provider rows inserted. ${total} approved providers now in the DB.`);
console.log(`Total time ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
console.log(`\nTo remove every one of them:  node scripts/seed-scale-providers.mjs --purge`);
