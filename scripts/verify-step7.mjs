/*
  Verifies the Step-7 reputation engine against the LIVE Supabase DB.
  Run it AFTER applying 20260726120000_seva_reputation_engine.sql (supabase db push).

  Strategy: the service role seeds providers, bookings and reviews DIRECTLY (with controlled
  created_at values and controlled rater snapshots), then calls compute_reputation explicitly and
  compares scores across constructed cases. Step 6 already proved the submit_review path; here we
  isolate the scoring math + its security envelope.

  What it checks (the Step-7 "Done when"):
    (a) engine writes: compute_reputation returns a 0–5 score, writes a reputation_snapshots row
        with a component breakdown, and updates the denormalized reputation_score; the AFTER
        INSERT trigger on reviews recomputes without an explicit call
    (b) BAYESIAN: one 5★ scores LOWER than ten reviews averaging 4.8 (shrinkage toward prior 4.0)
    (c) TIME-DECAY: a single 5★ from 365 days ago scores LOWER than the same 5★ today
    (d) BOUNDED RATER-WEIGHT: the same five 5★ reviews score higher when the rater's last
        snapshot is high-rep than when the rater has no history — and the weight is CLAMPED
        (a snapshot of 8.0 and an absurd 40.0 both hit the 2× ceiling → identical scores)
    (e) OPS BLEND: cancellations + disputes measurably lower the score (no reviews involved);
        the AFTER INSERT trigger on terminal booking_events recomputes both parties
    (f) CUSTOMER side: the engine scores a customer symmetrically (provider→customer reviews +
        the customer's own cancellation/dispute record) and updates profiles.reputation_score
    (g) server-only: authenticated/anon canNOT execute compute_reputation or
        recompute_all_reputation, nor write reputation_score (either table) or reputation_snapshots
    (h) RLS: provider snapshots are PUBLIC (anon + third party can read); customer snapshots are
        SELF-ONLY (owner reads them, third party + anon read zero rows)

  Usage (from repo root) — roles match the live-DB mapping (provider=test1, customer=test2):
    CUSTOMER_EMAIL=test2@gmail.com CUSTOMER_PASSWORD=test2@9271 \
    PROVIDER_EMAIL=test1@gmail.com PROVIDER_PASSWORD=test1@9271 \
    STRANGER_EMAIL=test3@gmail.com STRANGER_PASSWORD=test3@9271 \
    node scripts/verify-step7.mjs
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

// ---- preflight: migration applied? ----
{
  const { error } = await service.from('reputation_snapshots').select('id', { head: true, count: 'exact' });
  if (error) {
    console.log('Cannot run: reputation_snapshots not reachable (' + error.message + '). Did you run supabase db push?');
    process.exit(1);
  }
}

// ---- engine constants (must mirror the migration) for client-side expected values ----
const LAMBDA = 0.0077, PRIOR = 4.0, C = 5, W_REV = 0.7, W_OPS = 0.3;
const round2 = (x) => Math.round(x * 100) / 100;
// expected score for all-recent reviews (time_w≈1) with a single uniform rater weight + given ops
const expected = (ratings, raterW, ops) => {
  const sumW = ratings.length * raterW;
  const sumWR = ratings.reduce((s, r) => s + r * raterW, 0);
  return round2(W_REV * ((C * PRIOR + sumWR) / (C + sumW)) + W_OPS * ops);
};

// ---- seed helpers (service role; every created id is tracked for cleanup) ----
const providerRows = [], bookingIds = [];
let categoryId = null;
{
  const { data: cat } = await anon.from('service_categories').select('id').limit(1).maybeSingle();
  categoryId = cat?.id ?? null;
}
async function mkProvider(name) {
  const { data, error } = await service.from('service_providers').insert({
    user_id: providerId, business_name: name, bio: 'step7 verify seed',
    hourly_rate: 300, city: 'Mumbai', state: 'MH',
  }).select('id').single();
  if (error) throw new Error('mkProvider ' + name + ': ' + error.message);
  providerRows.push(data.id);
  return data.id;
}
async function mkBooking(provRowId, status) {
  const { data, error } = await service.from('bookings').insert({
    customer_id: customerId, provider_id: provRowId, category_id: categoryId,
    service_type: 'one-time', scheduled_date: '2026-09-20', scheduled_time: '11:00',
    duration_hours: 2, hourly_rate: 300, total_amount: 600, payment_method: 'upi',
    status, payment_status: status === 'paid' ? 'released' : 'pending',
  }).select('id').single();
  if (error) throw new Error('mkBooking: ' + error.message);
  bookingIds.push(data.id);
  return data.id;
}
// One review per (booking, direction). Direct insert fires the star-average, notification AND
// Step-7 recompute triggers — exactly what a submit_review insert would fire.
async function mkReview(bkId, provRowId, rating, { daysAgo = 0, direction = 'customer_to_provider', reviewerId = customerId } = {}) {
  const created = new Date(Date.now() - daysAgo * 86400e3).toISOString();
  const { error } = await service.from('reviews').insert({
    booking_id: bkId, customer_id: customerId, provider_id: provRowId,
    reviewer_id: reviewerId, direction, rating, comment: 'step7 seed', created_at: created,
  });
  if (error) throw new Error('mkReview: ' + error.message);
}
// a provider with n_paid settled bookings and one recent review per booking, ratings[i] each
async function mkProviderWithReviews(name, ratings) {
  const p = await mkProvider(name);
  for (const r of ratings) { const b = await mkBooking(p, 'paid'); await mkReview(b, p, r); }
  return p;
}
const computeRep = async (type, id) => {
  const { data, error } = await service.rpc('compute_reputation', { p_subject_type: type, p_subject_id: id });
  if (error) throw new Error('compute_reputation(' + type + '): ' + error.message);
  return Number(data);
};
const snapCount = async (type, id) => {
  const { count } = await service.from('reputation_snapshots')
    .select('id', { head: true, count: 'exact' }).eq('subject_type', type).eq('subject_id', id);
  return count ?? 0;
};
const latestSnap = async (type, id) => {
  const { data } = await service.from('reputation_snapshots').select('score, breakdown, computed_at')
    .eq('subject_type', type).eq('subject_id', id).order('computed_at', { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
};
// neutralize the rater: with no customer snapshot, the engine must default to weight 1.0
const clearRaterHistory = () =>
  service.from('reputation_snapshots').delete().eq('subject_type', 'customer').eq('subject_id', customerId);
const seedRaterSnapshot = (score, atMs) =>
  service.from('reputation_snapshots').insert({
    subject_type: 'customer', subject_id: customerId, score,
    breakdown: { seeded: 'step7 rater-weight test' }, computed_at: new Date(atMs).toISOString(),
  });

let p1, p2, p3, p4, p5, p6, p7;
try {

  // ================= (a) engine writes: score + snapshot + breakdown + denormalized column =================
  console.log('[a) compute_reputation writes score + snapshot + breakdown; review trigger recomputes]');
  {
    p1 = await mkProvider('Step7 P1 one-5star');
    const b1 = await mkBooking(p1, 'paid');
    const before = await snapCount('provider', p1);
    await mkReview(b1, p1, 5);
    const after = await snapCount('provider', p1);
    if (after > before) ok(`review INSERT trigger recomputed the provider (snapshots ${before}→${after}, no explicit call)`);
    else no(`review INSERT did not create a provider snapshot (snapshots ${before}→${after})`);

    await clearRaterHistory();
    const s1 = await computeRep('provider', p1);
    if (s1 > 0 && s1 <= 5) ok(`compute_reputation('provider') returned ${s1} (0–5)`);
    else no(`provider score out of range: ${s1}`);

    const snap = await latestSnap('provider', p1);
    const bd = snap?.breakdown ?? {};
    const keys = ['review_score', 'review_count', 'ops_score', 'completion', 'cancellation', 'dispute', 'params'];
    if (snap && Number(snap.score) === s1 && keys.every((k) => k in bd))
      ok(`snapshot written with full breakdown (review_score=${bd.review_score}, review_count=${bd.review_count}, ops_score=${bd.ops_score}, completion=${bd.completion})`);
    else no('snapshot/breakdown not as expected: ' + JSON.stringify(snap));

    const { data: prov } = await service.from('service_providers').select('reputation_score').eq('id', p1).maybeSingle();
    if (Number(prov?.reputation_score) === s1) ok(`denormalized service_providers.reputation_score = ${s1}`);
    else no(`denormalized column mismatch: ${prov?.reputation_score} vs returned ${s1}`);
  }

  // ================= (b) BAYESIAN: one 5★ < many at 4.8 avg =================
  console.log('\n[b) Bayesian shrinkage: one 5★ vs ten reviews averaging 4.8]');
  {
    p2 = await mkProviderWithReviews('Step7 P2 ten-4.8avg', [5, 5, 5, 5, 5, 5, 5, 5, 4, 4]); // avg 4.8
    await clearRaterHistory();
    const s1 = await computeRep('provider', p1);
    const s2 = await computeRep('provider', p2);
    const e1 = expected([5], 1, 5), e2 = expected([5, 5, 5, 5, 5, 5, 5, 5, 4, 4], 1, 5);
    console.log(`  one 5★ → ${s1} (expected ≈${e1}) | ten @4.8 avg → ${s2} (expected ≈${e2})`);
    if (s1 < s2) ok(`BAYESIAN holds: one 5★ (${s1}) < ten reviews @4.8 avg (${s2}) — shrunk toward prior ${PRIOR}`);
    else no(`BAYESIAN violated: one 5★ (${s1}) should score below ten @4.8 (${s2})`);
    if (Math.abs(s1 - e1) <= 0.03 && Math.abs(s2 - e2) <= 0.03) ok('both match the client-side Bayesian formula (±0.03)');
    else no(`scores diverge from formula: got ${s1}/${s2}, expected ${e1}/${e2}`);
  }

  // ================= (c) TIME-DECAY: an old 5★ counts less than a recent one =================
  console.log('\n[c) time decay: same single 5★, today vs 365 days ago]');
  {
    p3 = await mkProviderWithReviews('Step7 P3 recent-5star', [5]);
    p4 = await mkProvider('Step7 P4 old-5star');
    const b4 = await mkBooking(p4, 'paid');
    await mkReview(b4, p4, 5, { daysAgo: 365 });
    await clearRaterHistory();
    const s3 = await computeRep('provider', p3);
    const s4 = await computeRep('provider', p4);
    const w = Math.exp(-LAMBDA * 365);
    const e4 = round2(W_REV * ((C * PRIOR + w * 5) / (C + w)) + W_OPS * 5);
    console.log(`  5★ today → ${s3} | 5★ 365d ago → ${s4} (expected ≈${e4}; time_w=exp(-λ·365)=${w.toFixed(4)})`);
    if (s4 < s3) ok(`TIME-DECAY holds: old 5★ (${s4}) < recent 5★ (${s3})`);
    else no(`TIME-DECAY violated: old 5★ (${s4}) should score below recent 5★ (${s3})`);
    if (Math.abs(s4 - e4) <= 0.03) ok(`old-review score matches exp-decay formula (±0.03): ${s4} ≈ ${e4}`);
    else no(`old-review score diverges from formula: got ${s4}, expected ${e4}`);
  }

  // ================= (d) BOUNDED RATER-WEIGHT: high-rep rater moves more, but clamped =================
  console.log('\n[d) bounded rater weight: same five 5★, rater history varied via snapshots]');
  {
    p5 = await mkProviderWithReviews('Step7 P5 rater-weight', [5, 5, 5, 5, 5]);
    const t0 = Date.now();

    await clearRaterHistory();                       // no history → neutral 1.0
    const sNeutral = await computeRep('provider', p5);

    await seedRaterSnapshot(5.0, t0 + 1000);         // high-rep → 5/4 = 1.25×
    const sHigh = await computeRep('provider', p5);

    await seedRaterSnapshot(8.0, t0 + 2000);         // 8/4 = 2.0× — exactly at the ceiling
    const sClamp8 = await computeRep('provider', p5);

    await seedRaterSnapshot(40.0, t0 + 3000);        // 40/4 = 10× raw — MUST clamp to 2.0×
    const sClamp40 = await computeRep('provider', p5);

    console.log(`  rater: none → ${sNeutral} | rep 5.0 (1.25×) → ${sHigh} | rep 8.0 (2×) → ${sClamp8} | rep 40.0 (raw 10×, clamped) → ${sClamp40}`);
    console.log(`  expected ≈ ${expected([5,5,5,5,5],1,5)} / ${expected([5,5,5,5,5],1.25,5)} / ${expected([5,5,5,5,5],2,5)} / ${expected([5,5,5,5,5],2,5)}`);
    if (sHigh > sNeutral) ok(`RATER-WEIGHT holds: high-rep rater (${sHigh}) moves the score more than a no-history rater (${sNeutral})`);
    else no(`RATER-WEIGHT violated: high-rep (${sHigh}) should exceed neutral (${sNeutral})`);
    if (sClamp8 === sClamp40) ok(`BOUNDED: rater snapshots 8.0 and 40.0 both clamp to the 2× ceiling → identical scores (${sClamp8})`);
    else no(`BOUND violated: 8.0 gave ${sClamp8} but 40.0 gave ${sClamp40} (weight escaped the 2× clamp)`);
    if (sClamp40 > sHigh) ok('weight is monotone up to the clamp (2× > 1.25× > 1×)');
    else no(`monotonicity broken: clamped (${sClamp40}) should exceed 1.25× (${sHigh})`);
    await clearRaterHistory();                       // don't leak synthetic snapshots into later cases
  }

  // ================= (e) OPS BLEND: cancellations/disputes lower the score; event trigger fires =================
  console.log('\n[e) operational blend: clean record vs cancellations+disputes (no reviews at all)]');
  {
    p6 = await mkProvider('Step7 P6 clean-ops');
    for (let i = 0; i < 4; i++) await mkBooking(p6, 'paid');
    p7 = await mkProvider('Step7 P7 messy-ops');
    await mkBooking(p7, 'paid'); await mkBooking(p7, 'paid');
    const bCancelled = await mkBooking(p7, 'cancelled');
    await mkBooking(p7, 'disputed');

    const s6 = await computeRep('provider', p6);
    const s7 = await computeRep('provider', p7);
    const bd7 = (await latestSnap('provider', p7))?.breakdown ?? {};
    console.log(`  4/4 paid → ${s6} (expected ≈${round2(W_REV * PRIOR + W_OPS * 5)}) | 2 paid + 1 cancelled + 1 disputed → ${s7} (ops_score=${bd7.ops_score}, completion=${bd7.completion}, cancellation=${bd7.cancellation}, dispute=${bd7.dispute})`);
    if (s7 < s6) ok(`OPS holds: cancellations+disputes lower the score (${s7} < ${s6}) with identical (zero) reviews`);
    else no(`OPS violated: messy record (${s7}) should score below clean record (${s6})`);
    if (Number(bd7.cancellation) === 0.25 && Number(bd7.dispute) === 0.25 && Number(bd7.ops_score) < 5)
      ok(`breakdown exposes the ops inputs (cancellation=0.25, dispute=0.25, ops_score=${bd7.ops_score})`);
    else no('ops breakdown not as expected: ' + JSON.stringify(bd7));

    // terminal booking_events trigger: recomputes BOTH parties with no explicit call
    const provBefore = await snapCount('provider', p7);
    const custBefore = await snapCount('customer', customerId);
    const { error: evErr } = await service.from('booking_events').insert({
      booking_id: bCancelled, from_status: 'requested', to_status: 'cancelled', actor_id: null, actor_role: 'system',
    });
    if (evErr) no('seed terminal booking_event failed: ' + evErr.message);
    const provAfter = await snapCount('provider', p7);
    const custAfter = await snapCount('customer', customerId);
    if (provAfter > provBefore && custAfter > custBefore)
      ok(`terminal booking_event trigger recomputed BOTH parties (provider ${provBefore}→${provAfter}, customer ${custBefore}→${custAfter})`);
    else no(`booking_event trigger did not recompute both parties (provider ${provBefore}→${provAfter}, customer ${custBefore}→${custAfter})`);
  }

  // ================= (f) CUSTOMER side: symmetric scoring + profiles.reputation_score =================
  console.log('\n[f) customer reputation: provider→customer review + own ops record]');
  {
    // attach the provider's counter-review to P1's already-reviewed booking (one per direction)
    const { data: bk } = await service.from('bookings').select('id').eq('provider_id', p1).limit(1).maybeSingle();
    await mkReview(bk.id, p1, 5, { direction: 'provider_to_customer', reviewerId: providerId });
    const sc = await computeRep('customer', customerId);
    if (sc > 0 && sc <= 5) ok(`compute_reputation('customer') returned ${sc} (0–5)`);
    else no(`customer score out of range: ${sc}`);

    // the live test account has real provider→customer reviews from earlier steps; the engine
    // must count ALL of them plus our seeded one — compare against the actual DB count.
    const { count: expectedReviews } = await service.from('reviews')
      .select('id', { head: true, count: 'exact' })
      .eq('direction', 'provider_to_customer').eq('customer_id', customerId);
    const snap = await latestSnap('customer', customerId);
    const bd = snap?.breakdown ?? {};
    if (snap && Number(snap.score) === sc && Number(bd.review_count) === expectedReviews)
      ok(`customer snapshot written (review_score=${bd.review_score} from all ${bd.review_count} provider reviews incl. the seeded one)`);
    else no(`customer snapshot not as expected (review_count=${bd.review_count}, DB has ${expectedReviews}): ` + JSON.stringify(snap));
    if (Number(bd.cancellation) > 0 && Number(bd.dispute) > 0)
      ok(`customer ops reflect their own record (cancellation=${bd.cancellation}, dispute=${bd.dispute} from the seeded cancelled/disputed bookings)`);
    else no('customer ops did not pick up their cancelled/disputed bookings: ' + JSON.stringify(bd));

    const { data: prof } = await service.from('profiles').select('reputation_score').eq('id', customerId).maybeSingle();
    if (Number(prof?.reputation_score) === sc) ok(`denormalized profiles.reputation_score = ${sc}`);
    else no(`profiles.reputation_score mismatch: ${prof?.reputation_score} vs returned ${sc}`);
  }

  // ================= (g) server-only: no client execute, no client writes =================
  console.log('\n[g) server-only: authenticated/anon cannot execute the engine or write its outputs]');
  {
    const denied = (e) => e && (e.code === '42501' || /permission denied/i.test(e.message));

    const r1 = await customerClient.rpc('compute_reputation', { p_subject_type: 'provider', p_subject_id: p1 });
    if (denied(r1.error)) ok('authenticated cannot execute compute_reputation: ' + r1.error.message);
    else no('authenticated executed compute_reputation (should be denied): ' + JSON.stringify(r1.error ?? r1.data));

    const r2 = await anon.rpc('compute_reputation', { p_subject_type: 'provider', p_subject_id: p1 });
    if (denied(r2.error)) ok('anon cannot execute compute_reputation: ' + r2.error.message);
    else no('anon executed compute_reputation (should be denied): ' + JSON.stringify(r2.error ?? r2.data));

    const r3 = await customerClient.rpc('recompute_all_reputation');
    if (denied(r3.error)) ok('authenticated cannot execute recompute_all_reputation: ' + r3.error.message);
    else no('authenticated executed recompute_all_reputation (should be denied): ' + JSON.stringify(r3.error ?? r3.data));

    // column grants: the OWNER of the row still can't bump their own score
    const { data: before1 } = await service.from('service_providers').select('reputation_score').eq('id', p1).maybeSingle();
    const u1 = await providerClient.from('service_providers').update({ reputation_score: 4.99 }).eq('id', p1).select('id');
    const { data: after1 } = await service.from('service_providers').select('reputation_score').eq('id', p1).maybeSingle();
    if (denied(u1.error) && Number(after1?.reputation_score) === Number(before1?.reputation_score))
      ok('provider cannot write their own service_providers.reputation_score: ' + u1.error.message);
    else no('service_providers.reputation_score write not cleanly denied: ' + JSON.stringify(u1.error ?? u1.data));

    const { data: before2 } = await service.from('profiles').select('reputation_score').eq('id', customerId).maybeSingle();
    const u2 = await customerClient.from('profiles').update({ reputation_score: 4.99 }).eq('id', customerId).select('id');
    const { data: after2 } = await service.from('profiles').select('reputation_score').eq('id', customerId).maybeSingle();
    if (denied(u2.error) && Number(after2?.reputation_score) === Number(before2?.reputation_score))
      ok('customer cannot write their own profiles.reputation_score: ' + u2.error.message);
    else no('profiles.reputation_score write not cleanly denied: ' + JSON.stringify(u2.error ?? u2.data));

    const ins = await customerClient.from('reputation_snapshots').insert({
      subject_type: 'customer', subject_id: customerId, score: 5, breakdown: {},
    }).select('id');
    if (denied(ins.error)) ok('client INSERT into reputation_snapshots denied: ' + ins.error.message);
    else no('client INSERT into reputation_snapshots not denied: ' + JSON.stringify(ins.error ?? ins.data));

    const { data: anySnap } = await service.from('reputation_snapshots').select('id')
      .eq('subject_type', 'provider').eq('subject_id', p1).limit(1).maybeSingle();
    const upd = await customerClient.from('reputation_snapshots').update({ score: 5 }).eq('id', anySnap.id).select('id');
    if (denied(upd.error)) ok('client UPDATE on reputation_snapshots denied: ' + upd.error.message);
    else no('client UPDATE on reputation_snapshots not denied: ' + JSON.stringify(upd.error ?? upd.data));

    const del = await customerClient.from('reputation_snapshots').delete().eq('id', anySnap.id).select('id');
    if (denied(del.error)) ok('client DELETE on reputation_snapshots denied: ' + del.error.message);
    else no('client DELETE on reputation_snapshots not denied: ' + JSON.stringify(del.error ?? del.data));
  }

  // ================= (h) RLS: provider snapshots public, customer snapshots self-only =================
  console.log('\n[h) snapshot visibility: provider = public, customer = self-only]');
  {
    const asAnon = await anon.from('reputation_snapshots').select('id').eq('subject_type', 'provider').eq('subject_id', p1);
    if ((asAnon.data ?? []).length > 0) ok(`anon reads provider snapshots (${asAnon.data.length} rows — public trust display)`);
    else no('anon cannot read provider snapshots: ' + JSON.stringify(asAnon.error ?? asAnon.data));

    const asStrangerProv = await strangerClient.from('reputation_snapshots').select('id').eq('subject_type', 'provider').eq('subject_id', p1);
    if ((asStrangerProv.data ?? []).length > 0) ok('third party reads provider snapshots');
    else no('third party cannot read provider snapshots: ' + JSON.stringify(asStrangerProv.error ?? asStrangerProv.data));

    const asOwner = await customerClient.from('reputation_snapshots').select('id').eq('subject_type', 'customer').eq('subject_id', customerId);
    if ((asOwner.data ?? []).length > 0) ok(`customer reads their OWN snapshots (${asOwner.data.length} rows)`);
    else no('customer cannot read their own snapshots: ' + JSON.stringify(asOwner.error ?? asOwner.data));

    const asStrangerCust = await strangerClient.from('reputation_snapshots').select('id').eq('subject_type', 'customer').eq('subject_id', customerId);
    if ((asStrangerCust.data ?? []).length === 0) ok('third party sees ZERO rows of another customer\'s snapshots');
    else no('third party WRONGLY reads a customer\'s snapshots: ' + JSON.stringify(asStrangerCust.data));

    const asAnonCust = await anon.from('reputation_snapshots').select('id').eq('subject_type', 'customer').eq('subject_id', customerId);
    if ((asAnonCust.data ?? []).length === 0) ok('anon sees ZERO rows of customer snapshots');
    else no('anon WRONGLY reads customer snapshots: ' + JSON.stringify(asAnonCust.data));
  }

} catch (e) {
  no('unexpected error: ' + e.message);
}

// ================= cleanup =================
console.log('\n[cleanup]');
{
  for (const id of bookingIds) await service.from('notifications').delete().like('link', `/bookings/${id}%`);
  if (bookingIds.length) await service.from('bookings').delete().in('id', bookingIds); // cascades reviews + events
  if (providerRows.length) {
    await service.from('reputation_snapshots').delete().in('subject_id', providerRows);
    await service.from('service_providers').delete().in('id', providerRows);
  }
  await service.from('reputation_snapshots').delete().eq('subject_type', 'customer').eq('subject_id', customerId);
  await service.from('profiles').update({ reputation_score: 0 }).eq('id', customerId); // back to pre-run state
  console.log(`  cleaned up ${bookingIds.length} bookings (+ cascaded reviews/events), ${providerRows.length} providers, snapshots, notifications; customer score reset.`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
