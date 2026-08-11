/*
  Is the data in this database SHAPED like data the application would have produced?

  ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
  Seva computes three verdicts from evidence, and never stores a verdict that evidence cannot
  justify:

      rating / total_reviews  ←  the reviews table          (update_provider_rating trigger)
      reputation_score        ←  reviews + booking outcomes (compute_reputation)
      trust_tier              ←  verified documents         (recompute_trust_tier)

  Seed data broke that rule three separate times, and each break was invisible until someone went
  looking with a specific question:

      484 providers claiming 76,367 reviews  →  8 actual rows in `reviews`
      435 providers at trust_tier 2 or 3     →  0 verified documents between them
      20,202 bookings                        →  145 booking_events, 24 payment_transactions

  Each one produced a system that LOOKED right and behaved wrongly: ranking that ignored
  reputation because reputation was constant, tiers that the nightly job would silently demote,
  timelines that rendered empty, and an escrow ledger describing almost none of the money the
  platform believed it had moved.

  The failures were not really about seeding. They were about a missing contract: nothing in the
  system asserted that a stored verdict must be derivable from stored evidence. This file is that
  contract, and it is deliberately written against ALL data rather than seeded rows only —
  a production row that violates it is a worse bug than a fixture that does.

  🔴 IT IS NOT A SEED CHECKER. If it only checked seeds it would have to know which rows are
  seeds, and the whole point is that there should be no detectable difference.

  Usage (from repo root):
    node scripts/verify-data-fidelity.mjs
*/
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
if (!env.SUPABASE_SERVICE_ROLE_KEY) { console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY missing.'); process.exit(0); }
const service = createClient(URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };

/** Run a scalar SQL probe through an existing definer RPC is not possible, so page the REST API.
 *  Everything below is expressed as "fetch the rows that VIOLATE the rule" — an empty result is a
 *  pass, and any violation can be printed rather than merely counted. */
async function all(table, select, tweak = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    /* ORDER BY id is not decoration. range() paging without a total order lets Postgres return
       rows in a different sequence per page, so some rows come back twice and others never come
       back at all. The first version of this file omitted it and reported "82 approved providers
       have never been scored" and "6 terminal bookings have no events" — misses, not violations,
       and indistinguishable from real findings by eye. That is the same defect this very run
       caught in the seeder minutes earlier, and the same one 20260824120000 fixed in
       search_providers. Three times in one codebase: assume any range() without an order is wrong. */
    const { data, error } = await tweak(service.from(table).select(select))
      .order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

console.log('DB:', URL, '\n');

/* The verify suite inserts bookings DIRECTLY with the service role, at whatever status a given
   test needs — that is the point of a fixture, and such rows legitimately have no transition trail
   and no payment row. They are not product data and this contract does not apply to them.

   They are excluded BY OWNER (the four real test accounts) rather than by a fuzzy heuristic, and
   the exclusion is printed with its count every run. Two things this deliberately does NOT do:
   silently tolerate them, or delete them — several of those bookings feed the accumulated
   reputation fixtures that verify-step7/step8 assert against on a 2-decimal knife-edge, and
   perturbing the system to make a new checker green is the wrong way round. */
const TEST_PREFIXES = ['CUSTOMER', 'PROVIDER', 'ADMIN', 'OUTSIDER', 'STRANGER'];
const testEmails = new Set(TEST_PREFIXES.map((p) => env[`${p}_EMAIL`]).filter(Boolean));
const fixtureOwners = new Set();
if (testEmails.size) {
  for (let page = 1; page <= 20; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    const users = data?.users ?? [];
    for (const u of users) if (u.email && testEmails.has(u.email)) fixtureOwners.add(u.id);
    if (users.length < 1000) break;
  }
}

try {
  const providers = await all('service_providers',
    'id, business_name, status, rating, total_reviews, reputation_score, trust_tier');
  const approved = providers.filter((p) => p.status === 'approved');
  const reviews = await all('reviews', 'id, booking_id, provider_id, customer_id, direction, rating');
  const bookings = await all('bookings', 'id, customer_id, provider_id, status, payment_status, total_amount');
  const docs = await all('provider_documents', 'provider_id, doc_code, verification_status, expires_at');
  const events = await all('booking_events', 'booking_id');
  const pays = await all('payment_transactions', 'booking_id, amount, platform_fee, provider_amount, status, created_at');

  console.log(`[scope] ${providers.length} providers (${approved.length} approved), ${bookings.length} bookings, ` +
    `${reviews.length} reviews, ${docs.length} documents, ${events.length} events, ${pays.length} payments\n`);

  /* ===== 1) A DISPLAYED RATING MUST BE BACKED BY REVIEWS ===== */
  console.log('[a rating is a summary of reviews, not a number someone typed]');
  {
    const c2p = reviews.filter((r) => r.direction === 'customer_to_provider');
    const byProvider = new Map();
    for (const r of c2p) {
      const e = byProvider.get(r.provider_id) ?? { n: 0, sum: 0 };
      e.n++; e.sum += Number(r.rating); byProvider.set(r.provider_id, e);
    }
    const bad = providers.filter((p) => (byProvider.get(p.id)?.n ?? 0) !== p.total_reviews);
    if (bad.length === 0) ok(`every provider's total_reviews equals its actual review rows (${providers.length} checked)`);
    else no(`${bad.length} providers claim reviews they do not have, e.g. ` +
      bad.slice(0, 3).map((p) => `${p.business_name}: counter ${p.total_reviews} vs ${byProvider.get(p.id)?.n ?? 0} rows`).join('; '));

    const ratingOff = providers.filter((p) => {
      const e = byProvider.get(p.id);
      const expected = e ? Math.round((e.sum / e.n) * 100) / 100 : 0;
      return Math.abs(Number(p.rating) - expected) > 0.011;   // the trigger rounds to 2dp
    });
    if (ratingOff.length === 0) ok('every displayed star average matches the mean of its reviews');
    else no(`${ratingOff.length} providers show a rating their reviews do not support, e.g. ` +
      ratingOff.slice(0, 3).map((p) => `${p.business_name}: shows ${p.rating}`).join('; '));
  }

  /* ===== 2) A TRUST TIER MUST BE EARNED ===== */
  console.log('\n[a trust tier is earned from verified documents]');
  {
    const today = new Date().toISOString().slice(0, 10);
    const live = (d) => d.verification_status === 'verified' && (!d.expires_at || d.expires_at > today);
    const EXCLUDED = new Set(['photo_id', 'selfie', 'pan', 'id_secondary', 'police_verification']);
    const credential = new Set(docs.filter((d) => live(d) && !EXCLUDED.has(d.doc_code)).map((d) => d.provider_id));
    const police = new Set(docs.filter((d) => live(d) && d.doc_code === 'police_verification').map((d) => d.provider_id));

    const exp = await all('provider_experience', 'provider_id, verified');
    const experienced = new Set(exp.filter((e) => e.verified).map((e) => e.provider_id));

    const tier2 = providers.filter((p) => p.trust_tier >= 2 && !credential.has(p.id) && !experienced.has(p.id));
    if (tier2.length === 0) ok('every tier-2+ provider has a verified credential or verified experience');
    else no(`${tier2.length} providers hold tier 2+ with no credential and no experience — ` +
      `the nightly document sweep would demote them, e.g. ${tier2.slice(0, 3).map((p) => p.business_name).join(', ')}`);

    const tier3 = providers.filter((p) => p.trust_tier >= 3 && !police.has(p.id));
    if (tier3.length === 0) ok('every tier-3 provider has an in-date police verification');
    else no(`${tier3.length} providers hold tier 3 with no valid police check, e.g. ` +
      tier3.slice(0, 3).map((p) => p.business_name).join(', '));
  }

  /* ===== 3) A REPUTATION SCORE MUST BE THE ENGINE'S OWN ANSWER ===== */
  console.log('\n[a reputation score is the engine\'s output, not a stored opinion]');
  {
    const snaps = await all('reputation_snapshots', 'subject_id, subject_type, score, computed_at',
      (q) => q.eq('subject_type', 'provider'));
    const latest = new Map();
    for (const s of snaps) {
      const prev = latest.get(s.subject_id);
      if (!prev || s.computed_at > prev.computed_at) latest.set(s.subject_id, s);
    }
    const missing = approved.filter((p) => !latest.has(p.id));
    if (missing.length === 0) ok(`every approved provider has a reputation snapshot (${approved.length})`);
    else no(`${missing.length} approved providers have never been scored by the engine`);

    const drifted = approved.filter((p) => {
      const s = latest.get(p.id);
      return s && Math.abs(Number(s.score) - Number(p.reputation_score)) > 0.011;
    });
    if (drifted.length === 0) ok('the stored reputation_score equals the engine\'s latest snapshot everywhere');
    else no(`${drifted.length} providers' stored score disagrees with the engine's own snapshot — ` +
      `someone wrote the column directly, e.g. ${drifted.slice(0, 3).map((p) => p.business_name).join(', ')}`);
  }

  /* ===== 4) EVERY REVIEW SITS ON A REAL BOOKING BETWEEN THOSE TWO PARTIES ===== */
  console.log('\n[a review is attached to a booking those two people actually had]');
  {
    const byId = new Map(bookings.map((b) => [b.id, b]));
    const orphan = reviews.filter((r) => r.booking_id && !byId.has(r.booking_id));
    if (orphan.length === 0) ok('no review points at a booking that does not exist');
    else no(`${orphan.length} reviews reference a missing booking`);

    const mismatched = reviews.filter((r) => {
      const b = r.booking_id && byId.get(r.booking_id);
      return b && (b.provider_id !== r.provider_id || b.customer_id !== r.customer_id);
    });
    if (mismatched.length === 0) ok('every review names the same two parties as its booking');
    else no(`${mismatched.length} reviews name different parties than their booking does`);

    const seen = new Set(), dupes = [];
    for (const r of reviews) {
      const key = `${r.booking_id}|${r.direction}`;
      if (r.booking_id && seen.has(key)) dupes.push(key); else seen.add(key);
    }
    if (dupes.length === 0) ok('at most one review per booking per direction');
    else no(`${dupes.length} duplicate reviews for the same booking + direction`);
  }

  /* ===== 5) A SETTLED BOOKING HAS A MONEY TRAIL AND AN AUDIT TRAIL ===== */
  console.log('\n[a settled booking leaves the traces the app would have left]');
  {
    const isFixture = (b) => fixtureOwners.has(b.customer_id);
    const withEvents = new Set(events.map((e) => e.booking_id));
    const TERMINAL = new Set(['reviewed', 'paid', 'cancelled', 'disputed']);
    const terminal = bookings.filter((b) => TERMINAL.has(b.status));
    const noTrail = terminal.filter((b) => !withEvents.has(b.id));
    const realNoTrail = noTrail.filter((b) => !isFixture(b));
    if (terminal.length === 0) sk('no terminal bookings to check');
    else if (realNoTrail.length === 0) ok(`all ${terminal.length - noTrail.length + realNoTrail.length} terminal bookings have a transition trail`);
    else no(`${realNoTrail.length} of ${terminal.length} terminal bookings have NO booking_events — ` +
      'their detail page renders an empty timeline');
    if (noTrail.length - realNoTrail.length > 0) {
      sk(`${noTrail.length - realNoTrail.length} trail-less bookings belong to the test accounts ` +
        '(fixtures inserted directly at a chosen status) — not product data');
    }

    const paidRows = new Set(pays.map((p) => p.booking_id));
    const released = bookings.filter((b) => b.payment_status === 'released');
    const noMoney = released.filter((b) => !paidRows.has(b.id));
    const realNoMoney = noMoney.filter((b) => !isFixture(b));
    if (released.length === 0) sk('no released bookings to check');
    else if (realNoMoney.length === 0) ok(`all ${released.length} released bookings have a payment_transactions row`);
    else no(`${realNoMoney.length} of ${released.length} released bookings have no payment row — ` +
      'the escrow ledger cannot account for money the booking says moved');
    if (noMoney.length - realNoMoney.length > 0) {
      sk(`${noMoney.length - realNoMoney.length} released bookings with no payment row belong to the test accounts`);
    }
  }

  /* ===== 6) THE MONEY ARITHMETIC IS THE PLATFORM'S OWN RULE ===== */
  console.log('\n[the 1% platform fee adds up]');
  {
    /* platform_fee is NULL on payments taken before 20260730120000 introduced the 1% fee. Those
       rows are correct history, not broken data — charging them retroactively would be the bug.
       So they are counted and skipped, and only rows that CLAIM a fee are checked against it. */
    const legacy = pays.filter((p) => p.platform_fee === null || p.platform_fee === undefined);
    const priced = pays.filter((p) => !legacy.includes(p));
    if (legacy.length) sk(`${legacy.length} payment rows pre-date the 1% fee (platform_fee null) — correct history, not checked`);
    if (!priced.length) { sk('no fee-bearing payment rows to check'); }
    else {
      /* TWO different questions, and conflating them produced a false alarm.

         (a) ARITHMETIC — fee + provider_amount must equal the amount charged. This is an
             invariant: if it fails, money is unaccounted for. Always checked.
         (b) THE RATE — 1% since 20260730120000. This is POLICY, and policy changed: eight real
             rows charge 15% (₹90 on ₹600) because that is what the platform charged when they
             were taken. They add up perfectly. Re-checking them against today's rate reported
             "8 payment rows do not add up", which is not what was wrong with them — nothing was.
             Rate is therefore only asserted for rows written after the fee migration. */
      const FEE_MIGRATION = '2026-07-30';
      const unbalanced = priced.filter((p) => {
        const rupees = Number(p.amount) / 100;                   // stored in paise
        return Math.abs((Number(p.platform_fee) + Number(p.provider_amount)) - rupees) > 0.02;
      });
      if (unbalanced.length === 0) ok(`every payment row balances: fee + provider = amount (${priced.length})`);
      else no(`${unbalanced.length} payment rows do not balance, e.g. amount ${unbalanced[0].amount} paise, ` +
        `fee ${unbalanced[0].platform_fee}, provider ${unbalanced[0].provider_amount}`);

      /* Check the RATE on every row, then forgive only those that both charge a different rate
         AND pre-date the change. Splitting by date first was wrong: seeded payments are
         back-dated across the last 200 days but charge today's 1%, so a date-first split labelled
         16,729 correct rows as "older rate" — a reassuring message about nothing. */
      const offRate = priced.filter((p) => {
        const rupees = Number(p.amount) / 100;
        return Math.abs(Number(p.platform_fee) - Math.round(rupees) / 100) > 0.02;
      });
      const unexplained = offRate.filter((p) => (p.created_at ?? '') >= FEE_MIGRATION);
      if (offRate.length === 0) ok(`every payment charges the 1% platform fee (${priced.length})`);
      else if (unexplained.length === 0) {
        ok(`every payment since ${FEE_MIGRATION} charges 1% (${priced.length - offRate.length})`);
        sk(`${offRate.length} payments pre-date ${FEE_MIGRATION} and charge the older rate — correct history`);
      } else {
        no(`${unexplained.length} payments taken since ${FEE_MIGRATION} do not charge 1%, e.g. ` +
          `fee ${unexplained[0].platform_fee} on ₹${Number(unexplained[0].amount) / 100}`);
      }
    }
  }

  /* ===== 7) THE POPULATION IS ACTUALLY VARIED — a uniform world tests nothing ===== */
  console.log('\n[the population has the variety a ranking needs]');
  {
    const reps = approved.map((p) => Number(p.reputation_score)).filter(Number.isFinite);
    if (reps.length < 20) { sk(`only ${reps.length} approved providers — variety is not meaningful`); }
    else {
      const mean = reps.reduce((a, b) => a + b, 0) / reps.length;
      const sd = Math.sqrt(reps.reduce((a, b) => a + (b - mean) ** 2, 0) / reps.length);
      const distinct = new Set(reps.map((v) => v.toFixed(2))).size;
      if (sd >= 0.15 && distinct >= 20) {
        ok(`reputation varies enough to reorder results (sd ${sd.toFixed(3)}, ${distinct} distinct values)`);
      } else {
        no(`reputation is too level to affect ranking (sd ${sd.toFixed(3)}, ${distinct} distinct) — ` +
          '"Best match" will be indistinguishable from "Nearest"');
      }
      const tiers = new Set(approved.map((p) => p.trust_tier));
      if (tiers.size >= 2) ok(`trust tiers present: ${[...tiers].sort().join(', ')}`);
      else sk(`every provider is tier ${[...tiers][0]} — the tier nudge cannot be observed`);

      const unrated = approved.filter((p) => p.total_reviews === 0).length;
      if (unrated > 0) ok(`${unrated} providers have no reviews — the "New on Seva" path is represented`);
      else sk('every provider has reviews — the unrated path is not represented');
    }
  }
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
