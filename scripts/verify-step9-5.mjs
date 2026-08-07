/*
  Verifies Step-9.5 (category-aware KYC, trust tiers, portable experience) against the LIVE DB.
  Run AFTER `supabase db push` of 20260802120000_seva_category_kyc.sql, with test3 = admin.

  Account mapping (same as verify-step9 — the applicant must own no provider row):
    CUSTOMER_EMAIL = test2 → THE APPLICANT
    PROVIDER_EMAIL = test1 → a second signed-in user, used to prove isolation
    STRANGER_EMAIL = test3 → the ADMIN

  What it checks:
    (a) REQUIREMENTS COME FROM DATA — a driver needs DL/RC/insurance, a plumber needs neither;
        a brand-new category inherits the base requirements with no deploy.
    (b) DOCUMENTS ARE RPC-ONLY — no direct insert/update, and a client cannot mark anything
        verified or silently replace a document that already is.
    (c) APPROVAL IS GATED — an admin cannot approve a driver whose licence isn't verified, and
        a 'badge' document (police verification) never blocks.
    (d) TRUST TIER is server-computed and moves with verified documents/experience.
    (e) EXPERIENCE IS CAPABILITY, NOT REPUTATION — verifying work history must NOT move the
        reputation score. This is the moat (§7.3); if it ever fails, stop and fix it.
    (f) EXPIRY demotes: a lapsed document loses its verified status and the tier drops.
    (g) NO LEAKS — provider_missing_documents refuses to enumerate another provider's gaps.

  Usage — credentials come from .env.local (see .env.example):
    node scripts/verify-step9-5.mjs
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
const denied = (e) => e && (e.code === '42501' || /permission denied|row-level security|violates|admin only|not authorized/i.test(errMsg(e)));

console.log('DB:', URL, '\n');
if (!SERVICE) { console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY not in .env.local.'); process.exit(0); }
const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

async function authClient(prefix) {
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = cred(`${prefix}_EMAIL`), password = cred(`${prefix}_PASSWORD`);
  if (!email) return { client, userId: null };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) { console.log(`${prefix} signIn error:`, error.message); return { client, userId: null }; }
  return { client, userId: data?.user?.id ?? null };
}

console.log('[sessions]');
const { client: applicant, userId: applicantId } = await authClient('CUSTOMER');
const { client: other, userId: otherId } = await authClient('PROVIDER');
const { client: adminClient, userId: adminId } = await authClient('STRANGER');
console.log('  applicant:', applicantId ?? 'NONE', '| other:', otherId ?? 'NONE', '| admin:', adminId ?? 'NONE', '\n');
if (!applicantId || !otherId || !adminId) { console.log('Cannot run: need three sessions.'); process.exit(0); }

// ---------------------------------------------------------------- preflight
{
  const { error } = await service.from('kyc_document_types').select('code').limit(1);
  if (error) { console.log('Cannot run: kyc_document_types missing (' + error.message + '). Did you db push?'); process.exit(1); }
  const { data: prof } = await service.from('profiles').select('role').eq('id', adminId).maybeSingle();
  if (prof?.role !== 'admin') { console.log('Cannot run: test3 is not admin.'); process.exit(1); }
  const { data: existing } = await service.from('service_providers').select('id').eq('user_id', applicantId).maybeSingle();
  if (existing) {
    const { count } = await service.from('bookings').select('id', { count: 'exact', head: true }).eq('provider_id', existing.id);
    if (count > 0) { console.log(`Cannot run: applicant owns provider ${existing.id} with ${count} bookings.`); process.exit(1); }
    await service.from('service_providers').delete().eq('id', existing.id);
    console.log('  (cleared a leftover provider row)');
  }
}

const runStart = new Date().toISOString();
let providerId = null, tempCategoryId = null;
const objectPaths = [];
const catOf = async (slug) => (await service.from('service_categories').select('id').eq('slug', slug).maybeSingle()).data?.id;
const rowOf = async () => (await service.from('service_providers')
  .select('id, status, is_verified, kyc_status, trust_tier, reputation_score').eq('id', providerId).maybeSingle()).data;
const docsOf = async () => (await service.from('provider_documents')
  .select('id, doc_code, verification_status, reference_number, expires_at').eq('provider_id', providerId)).data ?? [];

try {
  // ================= (a) requirements come from data =================
  console.log('[a) requirements are per-category, and live in data]');
  const driverCat = await catOf('driver'), plumberCat = await catOf('plumber');
  {
    const reqFor = async (catId) => ((await service.from('category_kyc_requirements')
      .select('doc_code, requirement').eq('category_id', catId)).data ?? []);
    const driver = await reqFor(driverCat), plumber = await reqFor(plumberCat);
    const dReq = driver.filter((r) => r.requirement === 'required').map((r) => r.doc_code).sort();
    const pReq = plumber.filter((r) => r.requirement === 'required').map((r) => r.doc_code).sort();

    if (['dl', 'insurance', 'rc'].every((c) => dReq.includes(c))) ok(`a DRIVER must supply DL, RC and insurance (${dReq.join(', ')})`);
    else no('driver requirements wrong: ' + dReq.join(', '));
    if (pReq.length === 2 && pReq.includes('photo_id') && pReq.includes('selfie'))
      ok('a PLUMBER needs only a photo ID and a selfie — nothing extra');
    else no('plumber requirements wrong: ' + pReq.join(', '));
    if (driver.some((r) => r.doc_code === 'police_verification' && r.requirement === 'badge'))
      ok('police verification is a BADGE for drivers, not a gate');
    else no('police verification is not configured as a badge');
  }

  // a brand-new category inherits the base requirements with no deploy
  {
    const { data: nc } = await service.from('service_categories')
      .insert({ name: 'ZZ Verify Cat', slug: 'zz-verify-' + Date.now() }).select('id').single();
    tempCategoryId = nc.id;
    const { data: seeded } = await service.from('category_kyc_requirements').select('doc_code').eq('category_id', nc.id);
    const codes = (seeded ?? []).map((s) => s.doc_code).sort();
    // Bucket C added the optional second-ID slot to the base set, so a new category must inherit
    // four things now, not three: the primary ID, the live selfie, PAN (at payout) and the
    // optional secondary ID.
    if (codes.join(',') === 'id_secondary,pan,photo_id,selfie') ok('a NEW category inherits the base requirements automatically (no deploy)');
    else no('new category did not inherit base requirements: ' + codes.join(','));
  }

  // ================= (b) documents are RPC-only =================
  console.log('\n[b) documents are RPC-only and server-verified]');
  {
    const applied = await applicant.rpc('submit_provider_application', {
      p_category_id: driverCat, p_business_name: 'Step9.5 Driver', p_bio: 'verify', p_experience_years: 3,
      p_hourly_rate: 400, p_city: 'Mumbai', p_state: 'MH', p_address: 'Andheri', p_documents: [],
    });
    const row = Array.isArray(applied.data) ? applied.data[0] : applied.data;
    if (applied.error || !row) throw new Error('submit_provider_application failed: ' + errMsg(applied.error));
    providerId = row.id;

    const direct = await applicant.from('provider_documents')
      .insert({ provider_id: providerId, doc_code: 'dl', verification_status: 'verified' }).select('id');
    if (denied(direct.error)) ok('a client cannot INSERT into provider_documents directly: ' + errMsg(direct.error));
    else no('direct document insert was allowed: ' + JSON.stringify(direct.error ?? direct.data));

    const rec = await applicant.rpc('record_provider_document', {
      p_doc_code: 'dl', p_file_path: `${applicantId}/dl.png`, p_reference_number: 'MH0120201234567',
      p_issued_at: null, p_expires_at: null, p_meta: {},
    });
    if (rec.error) no('record_provider_document failed: ' + errMsg(rec.error));
    else {
      const dl = (await docsOf()).find((d) => d.doc_code === 'dl');
      if (dl?.verification_status === 'pending') ok('a recorded document is born PENDING — the client cannot self-verify');
      else no('document not born pending: ' + JSON.stringify(dl));
      if (dl?.reference_number && /^X+4567$/.test(dl.reference_number))
        ok(`the licence number is stored MASKED (${dl.reference_number}) — never in full`);
      else no('reference number not masked: ' + dl?.reference_number);
    }

    const asClient = await applicant.rpc('review_provider_document', {
      p_document_id: (await docsOf()).find((d) => d.doc_code === 'dl')?.id, p_status: 'verified', p_expires_at: null, p_note: null,
    });
    if (asClient.error) ok('a client cannot call review_provider_document: ' + errMsg(asClient.error));
    else no('client marked its own document verified');
  }

  // ================= (c) approval is gated on the paperwork =================
  console.log('\n[c) an admin cannot approve a driver with no verified licence]');
  {
    const early = await adminClient.rpc('review_provider_application', { p_provider_id: providerId, p_decision: 'approve' });
    if (early.error && /required documents/i.test(errMsg(early.error)))
      ok('approval REFUSED while required documents are unverified: ' + errMsg(early.error).slice(0, 90));
    else no('approval was not blocked: ' + JSON.stringify(early.error ?? 'approved'));

    const still = await rowOf();
    if (still.status === 'pending' && still.is_verified === false) ok('...and the row is untouched by the refused attempt');
    else no('refused approval still changed the row: ' + JSON.stringify(still));

    // supply + verify everything the category requires
    for (const code of ['photo_id', 'selfie', 'rc', 'insurance']) {
      const r = await applicant.rpc('record_provider_document', {
        p_doc_code: code, p_file_path: `${applicantId}/${code}.png`, p_reference_number: null,
        p_issued_at: null, p_expires_at: null, p_meta: {},
      });
      if (r.error) no(`record ${code}: ` + errMsg(r.error));
    }
    const future = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
    for (const d of await docsOf()) {
      const res = await adminClient.rpc('review_provider_document', {
        p_document_id: d.id, p_status: 'verified', p_expires_at: future, p_note: null,
      });
      if (res.error) no(`admin verify ${d.doc_code}: ` + errMsg(res.error));
    }
    const verified = (await docsOf()).filter((d) => d.verification_status === 'verified').length;
    if (verified === 5) ok('the admin verified all five documents this category requires');
    else no(`expected 5 verified documents, got ${verified}`);

    const nowOk = await adminClient.rpc('review_provider_application', { p_provider_id: providerId, p_decision: 'approve' });
    if (!nowOk.error) ok('approval SUCCEEDS once the paperwork is verified');
    else no('approval still failed: ' + errMsg(nowOk.error));

    const after = await rowOf();
    if (after.status === 'approved' && after.is_verified === true) ok('provider is approved + verified');
    else no('row wrong after approval: ' + JSON.stringify(after));
    if (Number(after.reputation_score) > 0)
      ok(`a newly approved provider starts at a real trust score (${after.reputation_score}), not 0`);
    else no('reputation_score is still 0 after approval — the cold-start fix did not fire');
    if (after.trust_tier >= 2) ok(`trust tier reflects the verified credentials (tier ${after.trust_tier})`);
    else no('trust tier did not rise with verified credentials: ' + after.trust_tier);
  }

  // ================= (d) badge documents never block =================
  console.log('\n[d) a badge document is optional, and lifts the tier when present]');
  {
    const before = (await rowOf()).trust_tier;
    await applicant.rpc('record_provider_document', {
      p_doc_code: 'police_verification', p_file_path: `${applicantId}/pv.png`, p_reference_number: null,
      p_issued_at: null, p_expires_at: null, p_meta: {},
    });
    const pv = (await docsOf()).find((d) => d.doc_code === 'police_verification');
    const future = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
    await adminClient.rpc('review_provider_document', { p_document_id: pv.id, p_status: 'verified', p_expires_at: future, p_note: null });
    const after = (await rowOf()).trust_tier;
    if (before < 3 && after === 3) ok(`police verification lifts the provider to tier 3 (${before} → ${after})`);
    else no(`tier did not reach 3 with police verification (${before} → ${after})`);
  }

  // ================= (e) EXPERIENCE MUST NOT MOVE REPUTATION =================
  console.log('\n[e) experience is CAPABILITY — it must never move the reputation score]');
  {
    const add = await applicant.rpc('record_provider_experience', {
      p_employer_name: 'A Electricals Pvt Ltd', p_role: 'Senior electrician',
      p_from_date: '2019-04-01', p_to_date: '2021-03-31',
    });
    if (add.error) no('record_provider_experience failed: ' + errMsg(add.error));
    const { data: exp } = await service.from('provider_experience').select('id, verified, source').eq('provider_id', providerId);
    if (exp?.length === 1 && exp[0].verified === false && exp[0].source === 'self_declared')
      ok('claimed history is stored as self-declared and UNVERIFIED');
    else no('experience row wrong: ' + JSON.stringify(exp));

    const scoreBefore = Number((await rowOf()).reputation_score);
    const ver = await adminClient.rpc('verify_provider_experience', { p_id: exp[0].id, p_source: 'epfo' });
    if (ver.error) no('verify_provider_experience failed: ' + errMsg(ver.error));
    await service.rpc('compute_reputation', { p_subject_type: 'provider', p_subject_id: providerId });
    const scoreAfter = Number((await rowOf()).reputation_score);

    if (scoreBefore === scoreAfter)
      ok(`verified experience did NOT move the reputation score (${scoreBefore} → ${scoreAfter}) — the moat holds`);
    else no(`🔴 EXPERIENCE MOVED THE SCORE (${scoreBefore} → ${scoreAfter}) — off-platform history must never feed reputation`);

    const { data: pub } = await service.from('provider_experience').select('verified').eq('id', exp[0].id).maybeSingle();
    if (pub.verified) ok('...but it IS verified, so it can be shown on the public profile');
    else no('experience was not marked verified');
  }

  // ================= (f) expiry demotes =================
  console.log('\n[f) a lapsed document loses its status and demotes the tier]');
  {
    // capture the tier WHILE the police verification is still valid — review_provider_document
    // recomputes on every call, so backdating the expiry demotes immediately; the nightly sweep
    // is what catches documents that lapse with the passage of time.
    const tierBefore = (await rowOf()).trust_tier;
    const pv = (await docsOf()).find((d) => d.doc_code === 'police_verification');
    const past = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    await adminClient.rpc('review_provider_document', { p_document_id: pv.id, p_status: 'verified', p_expires_at: past, p_note: null });
    const swept = await service.rpc('expire_provider_documents');
    if (swept.error) no('expire_provider_documents failed: ' + errMsg(swept.error));
    const pvAfter = (await docsOf()).find((d) => d.doc_code === 'police_verification');
    const tierAfter = (await rowOf()).trust_tier;
    if (pvAfter.verification_status === 'expired') ok('the lapsed document is marked expired by the nightly sweep');
    else no('lapsed document still reads: ' + pvAfter.verification_status);
    if (tierAfter < tierBefore) ok(`trust tier demoted automatically (${tierBefore} → ${tierAfter})`);
    else no(`tier did not demote after expiry (${tierBefore} → ${tierAfter})`);
  }

  // ================= (g) no enumeration of someone else's gaps =================
  console.log('\n[g) a definer function must gate its own access]');
  {
    const leak = await other.rpc('provider_missing_documents', { p_provider_id: providerId });
    if (leak.error || (leak.data ?? []).length === 0)
      ok('another user cannot enumerate this provider\'s missing documents');
    else no('LEAK: another user listed missing documents: ' + JSON.stringify(leak.data));

    const own = await applicant.rpc('provider_document_checklist', { p_provider_id: providerId });
    if (!own.error && (own.data ?? []).length > 0) ok('the owner CAN read their own checklist');
    else no('owner could not read their checklist: ' + errMsg(own.error));

    const notMine = await other.rpc('provider_document_checklist', { p_provider_id: providerId });
    if ((notMine.data ?? []).length === 0) ok('another user gets an empty checklist for a foreign provider');
    else no('checklist leaked to another user: ' + (notMine.data ?? []).length + ' rows');
  }

  // ================= (h) a verified document cannot be silently swapped =================
  console.log('\n[h) verified evidence is frozen]');
  {
    const swap = await applicant.rpc('record_provider_document', {
      p_doc_code: 'photo_id', p_file_path: `${applicantId}/swapped.png`, p_reference_number: null,
      p_issued_at: null, p_expires_at: null, p_meta: {},
    });
    if (swap.error && /already verified/i.test(errMsg(swap.error)))
      ok('a verified document cannot be replaced by the provider: ' + errMsg(swap.error).slice(0, 70));
    else no('verified document was replaceable: ' + JSON.stringify(swap.error ?? 'replaced'));
  }
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
}

// ================= cleanup =================
console.log('\n[cleanup]');
{
  if (objectPaths.length) await service.storage.from('kyc-docs').remove(objectPaths);
  if (providerId) {
    await service.from('reputation_snapshots').delete().eq('subject_type', 'provider').eq('subject_id', providerId);
    await service.from('service_providers').delete().eq('id', providerId);  // cascades documents + experience
  }
  if (tempCategoryId) await service.from('service_categories').delete().eq('id', tempCategoryId);
  await service.from('notifications').delete().eq('user_id', applicantId).eq('link', '/become-provider').gte('created_at', runStart);
  console.log('  removed the test application, its documents, experience and the temp category.');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
