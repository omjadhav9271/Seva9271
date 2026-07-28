/*
  Verifies Step-9 (provider onboarding + KYC verification) against the LIVE Supabase DB.
  Run AFTER `supabase db push` of 20260731120000_seva_provider_onboarding.sql, with test3 = admin.

  Account mapping — NOTE the roles are shuffled versus earlier steps, because the applicant must
  be a user who does NOT already own a provider row (uniq_provider_per_user):
    CUSTOMER_EMAIL = test2 → THE APPLICANT (applies to become a provider)
    PROVIDER_EMAIL = test1 → the booking customer (already owns the long-lived test provider row)
    STRANGER_EMAIL = test3 → the ADMIN who reviews

  What it checks:
    (a) 🔴 SELF-VERIFICATION HOLE — a client cannot insert status='approved'/is_verified=true
        (INSERT column grants reject it), and a plain insert is BORN pending + unverified + zeroed
        (the birth trigger), whatever the client sends.
    (b) THE RPC — submit_provider_application creates a pending / unverified / kyc='submitted'
        row, resubmitting UPSERTS the same row (no duplicates), and a second direct insert is
        refused by uniq_provider_per_user.
    (c) NOT LIVE UNTIL APPROVED — a pending provider is absent from the public list, absent from
        the direct-link detail query, and NOT bookable (bookings RLS refuses the insert).
    (d) REVIEW IS ADMIN-ONLY — both non-admins are rejected by review_provider_application;
        the admin can reject (reason recorded + provider notified + can resubmit) and approve
        (→ approved + verified, notified, and NOW bookable).
    (e) KYC STORAGE RLS — an applicant writes only their own folder, the owner and the admin can
        sign their documents, another user cannot, and after approval the documents are frozen.
    (f) COLUMN GRANTS — kyc_documents / rejection_reason are unreadable by `authenticated`
        directly; the owner reads their own row through my_provider_profile.
    (h) VERIFICATION ATTESTS TO A CLAIM (migration 20260801120000) — an approved provider who
        changes their CATEGORY loses the badge and goes back in the queue, while ordinary
        descriptive edits keep them live and their KYC evidence stays frozen.

  Usage:
    CUSTOMER_EMAIL=test2@gmail.com CUSTOMER_PASSWORD=test2@9271 \
    PROVIDER_EMAIL=test1@gmail.com PROVIDER_PASSWORD=test1@9271 \
    STRANGER_EMAIL=test3@gmail.com STRANGER_PASSWORD=test3@9271 \
    node scripts/verify-step9.mjs
*/
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'kyc-docs';

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };
const errMsg = (e) => (e && (e.message || JSON.stringify(e))) || '';
const denied = (e) => e && (e.code === '42501' || /permission denied|row-level security|violates|not authorized|admin only/i.test(errMsg(e)));

console.log('DB:', URL, '\n');
if (!SERVICE) { console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY not in .env.local.'); process.exit(0); }
const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

async function authClient(prefix) {
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = process.env[`${prefix}_EMAIL`], password = process.env[`${prefix}_PASSWORD`];
  if (!email) return { client, userId: null };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) { console.log(`${prefix} signIn error:`, error.message); return { client, userId: null }; }
  return { client, userId: data?.user?.id ?? null };
}

console.log('[sessions]');
const { client: applicant, userId: applicantId } = await authClient('CUSTOMER');
const { client: booker, userId: bookerId } = await authClient('PROVIDER');
const { client: adminClient, userId: adminId } = await authClient('STRANGER');
console.log('  applicant(test2):', applicantId ?? 'NONE', '| booker(test1):', bookerId ?? 'NONE', '| admin(test3):', adminId ?? 'NONE', '\n');
if (!applicantId || !bookerId || !adminId || new Set([applicantId, bookerId, adminId]).size !== 3) {
  console.log('Cannot run: need THREE distinct sessions.'); process.exit(0);
}

// ---------------------------------------------------------------- preflight
{
  const { error } = await service.from('service_providers').select('kyc_status').limit(1);
  if (error) { console.log('Cannot run: kyc_status missing (' + error.message + '). Did you run supabase db push?'); process.exit(1); }
  const { data: buckets } = await service.storage.listBuckets();
  const bucket = (buckets ?? []).find((b) => b.id === BUCKET);
  if (!bucket) { console.log(`Cannot run: bucket '${BUCKET}' missing.`); process.exit(1); }
  if (bucket.public) { console.log(`Cannot run: bucket '${BUCKET}' is PUBLIC — KYC documents must be private.`); process.exit(1); }
  const { data: adminProf } = await service.from('profiles').select('role').eq('id', adminId).maybeSingle();
  if (adminProf?.role !== 'admin') { console.log(`Cannot run: test3 is role='${adminProf?.role}', not admin.`); process.exit(1); }

  // The applicant must start with no provider row. Clear a leftover from a previous run, but
  // never touch a row that carries real history.
  const { data: existing } = await service.from('service_providers').select('id').eq('user_id', applicantId).maybeSingle();
  if (existing) {
    const { count } = await service.from('bookings').select('id', { count: 'exact', head: true }).eq('provider_id', existing.id);
    if (count > 0) {
      console.log(`Cannot run: applicant already owns provider ${existing.id} with ${count} booking(s). Point CUSTOMER_* at a user with no provider profile.`);
      process.exit(1);
    }
    await service.from('service_providers').delete().eq('id', existing.id);
    console.log('  (cleared a leftover provider row from a previous run)');
  }
}

const runStart = new Date().toISOString();
const objectPaths = [], bookingIds = [];
let providerId = null;
let categoryId = null;
{ const { data: cat } = await service.from('service_categories').select('id').limit(1).maybeSingle(); categoryId = cat?.id ?? null; }
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const rowOf = async (id) => (await service.from('service_providers')
  .select('id, user_id, status, is_verified, kyc_status, kyc_documents, rejection_reason, applied_at, reviewed_by, reviewed_at, rating, business_name')
  .eq('id', id).maybeSingle()).data;

/* Step 9.5 made approval conditional on every document the CATEGORY requires being VERIFIED.
   This script is about the Step-9 gate (born pending, admin-only review, not bookable until
   approved), so it stages the paperwork rather than testing it — verify-step9-5.mjs owns that.
   Records anything missing and has the admin verify it, skipping what's already verified. */
async function satisfyRequiredDocuments() {
  const { data: sp } = await service.from('service_providers')
    .select('category_id').eq('id', providerId).maybeSingle();
  const { data: reqs } = await service.from('category_kyc_requirements')
    .select('doc_code').eq('category_id', sp.category_id).eq('requirement', 'required');
  const { data: have } = await service.from('provider_documents')
    .select('doc_code, verification_status').eq('provider_id', providerId);
  const verified = new Set((have ?? []).filter((d) => d.verification_status === 'verified').map((d) => d.doc_code));

  for (const r of reqs ?? []) {
    if (verified.has(r.doc_code)) continue;
    const rec = await applicant.rpc('record_provider_document', {
      p_doc_code: r.doc_code, p_file_path: `${applicantId}/${r.doc_code}.png`,
      p_reference_number: null, p_issued_at: null, p_expires_at: null, p_meta: {},
    });
    if (rec.error) no(`stage ${r.doc_code}: ` + errMsg(rec.error));
  }
  const future = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
  const { data: docs } = await service.from('provider_documents')
    .select('id, verification_status').eq('provider_id', providerId);
  for (const d of docs ?? []) {
    if (d.verification_status === 'verified') continue;
    const res = await adminClient.rpc('review_provider_document', {
      p_document_id: d.id, p_status: 'verified', p_expires_at: future, p_note: null,
    });
    if (res.error) no('stage verify: ' + errMsg(res.error));
  }
}

const mkBooking = (client, customerId, provId) => client.from('bookings').insert({
  customer_id: customerId, provider_id: provId, category_id: categoryId, service_type: 'one-time',
  scheduled_date: '2026-09-20', scheduled_time: '11:00', duration_hours: 2, hourly_rate: 300,
  total_amount: 600, payment_method: 'upi',
}).select('id').maybeSingle();

try {
  // ================= (a) the self-verification hole =================
  console.log('[a) 🔴 a provider row cannot be born approved/verified]');
  {
    const forged = await applicant.from('service_providers').insert({
      user_id: applicantId, category_id: categoryId, business_name: 'Forged Verified Co',
      hourly_rate: 300, city: 'Mumbai', state: 'MH', status: 'approved', is_verified: true,
    }).select('id');
    if (denied(forged.error)) ok('direct insert of status=approved + is_verified=true is REJECTED: ' + errMsg(forged.error));
    else {
      no('SELF-VERIFICATION HOLE OPEN — client inserted an approved provider: ' + JSON.stringify(forged.error ?? forged.data));
      if (forged.data?.[0]?.id) await service.from('service_providers').delete().eq('id', forged.data[0].id);
    }

    const ratingForge = await applicant.from('service_providers').insert({
      user_id: applicantId, business_name: 'Five Star Co', rating: 5, total_reviews: 999,
    }).select('id');
    if (denied(ratingForge.error)) ok('direct insert of rating/total_reviews is REJECTED: ' + errMsg(ratingForge.error));
    else {
      no('client set its own rating at insert time: ' + JSON.stringify(ratingForge.error ?? ratingForge.data));
      if (ratingForge.data?.[0]?.id) await service.from('service_providers').delete().eq('id', ratingForge.data[0].id);
    }

    // A legal insert (granted columns only) must still be BORN pending + unverified + zeroed.
    const plain = await applicant.from('service_providers').insert({
      user_id: applicantId, category_id: categoryId, business_name: 'Birth State Co',
      hourly_rate: 300, city: 'Mumbai', state: 'MH',
    }).select('id, status, is_verified, rating, total_reviews, total_bookings').maybeSingle();
    if (plain.error) {
      no('a plain provider insert was rejected outright: ' + errMsg(plain.error));
    } else {
      const r = plain.data;
      if (r.status === 'pending' && r.is_verified === false && Number(r.rating) === 0
          && Number(r.total_reviews) === 0 && Number(r.total_bookings) === 0) {
        ok('a plain insert is born pending + unverified + rating/reviews/bookings 0 (birth trigger)');
      } else {
        no('birth state wrong: ' + JSON.stringify(r));
      }
      // uniq_provider_per_user: a SECOND row for the same user must fail.
      const dup = await applicant.from('service_providers').insert({
        user_id: applicantId, business_name: 'Second Profile Co', city: 'Mumbai',
      }).select('id');
      if (dup.error) ok('a second provider row for the same user is refused (uniq_provider_per_user): ' + errMsg(dup.error));
      else {
        no('DUPLICATE provider row created for one user: ' + JSON.stringify(dup.data));
        if (dup.data?.[0]?.id) await service.from('service_providers').delete().eq('id', dup.data[0].id);
      }
      await service.from('service_providers').delete().eq('id', r.id); // clear for the RPC path
    }
  }

  // ================= (e1) storage upload happens before submitting =================
  console.log('\n[e) KYC storage RLS — private bucket, own folder only]');
  const docPath = `${applicantId}/${uniq()}.png`;
  {
    const up = await applicant.storage.from(BUCKET).upload(docPath, pngBytes, { contentType: 'image/png' });
    if (!up.error) { ok('applicant can upload into their OWN folder'); objectPaths.push(docPath); }
    else no('applicant upload rejected: ' + errMsg(up.error));

    const foreign = `${bookerId}/${uniq()}.png`;
    const upBad = await applicant.storage.from(BUCKET).upload(foreign, pngBytes, { contentType: 'image/png' });
    if (upBad.error) ok('applicant CANNOT write into another user\'s folder: ' + errMsg(upBad.error));
    else { no('cross-folder upload was allowed'); objectPaths.push(foreign); }

    const ownerSign = await applicant.storage.from(BUCKET).createSignedUrl(docPath, 60);
    if (ownerSign.data?.signedUrl) ok('owner can sign their own document');
    else no('owner could not sign own document: ' + errMsg(ownerSign.error));

    const otherSign = await booker.storage.from(BUCKET).createSignedUrl(docPath, 60);
    if (!otherSign.data?.signedUrl) ok('another user CANNOT sign someone else\'s KYC document');
    else no('another user signed a KYC document they do not own');

    const adminSign = await adminClient.storage.from(BUCKET).createSignedUrl(docPath, 60);
    if (adminSign.data?.signedUrl) ok('admin can sign any KYC document (needed to review it)');
    else no('admin could not sign a KYC document: ' + errMsg(adminSign.error));

    const anonSign = await anon.storage.from(BUCKET).createSignedUrl(docPath, 60);
    if (!anonSign.data?.signedUrl) ok('anon cannot reach KYC documents at all');
    else no('ANON signed a KYC document');
  }

  // ================= (b) the RPC =================
  console.log('\n[b) submit_provider_application — the only way in]');
  {
    const docs = [{ path: docPath, label: 'Photo ID', name: 'id.png', mime: 'image/png', uploaded_at: new Date().toISOString() }];
    const args = {
      p_category_id: categoryId, p_business_name: 'Step9 Applicant', p_bio: 'verify step9',
      p_experience_years: 4, p_hourly_rate: 350, p_city: 'Mumbai', p_state: 'MH',
      p_address: 'Andheri', p_documents: docs,
    };
    const res = await applicant.rpc('submit_provider_application', args);
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    if (res.error || !row) { no('submit_provider_application failed: ' + errMsg(res.error)); }
    else {
      providerId = row.id;
      const fresh = await rowOf(providerId);
      if (fresh.status === 'pending' && fresh.is_verified === false && fresh.kyc_status === 'submitted' && fresh.applied_at)
        ok('application row is pending + unverified + kyc_status=submitted, applied_at stamped');
      else no('application row wrong: ' + JSON.stringify(fresh));
      if ((fresh.kyc_documents ?? []).length === 1) ok('the uploaded document is recorded on the row');
      else no('kyc_documents not stored: ' + JSON.stringify(fresh.kyc_documents));
    }

    // resubmit → same row, no duplicate
    const again = await applicant.rpc('submit_provider_application', { ...args, p_business_name: 'Step9 Applicant v2' });
    if (again.error) no('resubmit failed: ' + errMsg(again.error));
    else {
      const { count } = await service.from('service_providers').select('id', { count: 'exact', head: true }).eq('user_id', applicantId);
      const fresh = await rowOf(providerId);
      if (count === 1 && fresh.business_name === 'Step9 Applicant v2')
        ok('resubmitting UPSERTS the same row (still exactly 1 provider profile for the user)');
      else no(`resubmit produced ${count} rows / name=${fresh?.business_name}`);
      if (fresh.status === 'pending' && fresh.is_verified === false)
        ok('resubmission cannot self-promote — still pending + unverified');
      else no('resubmit changed status/verification: ' + JSON.stringify(fresh));
    }
  }

  if (!providerId) throw new Error('no application row — cannot continue');

  // ================= (f) column grants =================
  console.log('\n[f) the kyc columns are not client-readable]');
  {
    const leak = await applicant.from('service_providers').select('id, kyc_documents').eq('id', providerId);
    if (denied(leak.error)) ok('kyc_documents is not selectable by `authenticated`: ' + errMsg(leak.error));
    else no('kyc_documents readable from the client: ' + JSON.stringify(leak.error ?? leak.data));

    const reasonLeak = await booker.from('service_providers').select('id, rejection_reason').eq('id', providerId);
    if (denied(reasonLeak.error)) ok('rejection_reason is not selectable by `authenticated`');
    else no('rejection_reason readable from the client: ' + JSON.stringify(reasonLeak.error ?? reasonLeak.data));

    const own = await applicant.from('my_provider_profile').select('id, status, kyc_status, kyc_documents, rejection_reason').maybeSingle();
    if (!own.error && own.data?.kyc_status === 'submitted')
      ok('the owner reads their own application through my_provider_profile');
    else no('owner could not read own row via my_provider_profile: ' + errMsg(own.error));

    const notMine = await booker.from('my_provider_profile').select('id').eq('id', providerId);
    if (!notMine.error && (notMine.data ?? []).length === 0)
      ok('my_provider_profile shows another user nothing');
    else no('my_provider_profile leaked a foreign row: ' + JSON.stringify(notMine.error ?? notMine.data));
  }

  // ================= (c) pending = invisible + unbookable =================
  console.log('\n[c) a pending provider is not live]');
  {
    const list = await anon.from('service_providers').select('id').eq('status', 'approved');
    if (!(list.data ?? []).some((p) => p.id === providerId)) ok('pending provider is absent from the public list');
    else no('pending provider appears in the approved list');

    const direct = await anon.from('service_providers').select('id').eq('id', providerId).eq('status', 'approved').maybeSingle();
    if (!direct.data) ok('direct-link detail query returns nothing for a pending provider');
    else no('direct link exposed a pending provider');

    const bk = await mkBooking(booker, bookerId, providerId);
    if (denied(bk.error)) ok('booking a PENDING provider is refused by RLS: ' + errMsg(bk.error));
    else {
      no('a pending provider was booked: ' + JSON.stringify(bk.error ?? bk.data));
      if (bk.data?.id) bookingIds.push(bk.data.id);
    }
  }

  // ================= (d) review is admin-only =================
  console.log('\n[d) review_provider_application — admin only, and it flips the row]');
  {
    const selfApprove = await applicant.rpc('review_provider_application', { p_provider_id: providerId, p_decision: 'approve' });
    if (selfApprove.error) ok('the APPLICANT cannot approve themselves: ' + errMsg(selfApprove.error));
    else no('applicant approved their own application');

    const strangerApprove = await booker.rpc('review_provider_application', { p_provider_id: providerId, p_decision: 'approve' });
    if (strangerApprove.error) ok('a non-admin user cannot approve anyone: ' + errMsg(strangerApprove.error));
    else no('a non-admin approved an application');

    const anonApprove = await anon.rpc('review_provider_application', { p_provider_id: providerId, p_decision: 'approve' });
    if (anonApprove.error) ok('anon cannot call review_provider_application');
    else no('ANON approved an application');

    const stillPending = await rowOf(providerId);
    if (stillPending.status === 'pending' && stillPending.is_verified === false)
      ok('after three rejected attempts the row is untouched (pending, unverified)');
    else no('a rejected review attempt still changed the row: ' + JSON.stringify(stillPending));

    const badDecision = await adminClient.rpc('review_provider_application', { p_provider_id: providerId, p_decision: 'maybe' });
    if (badDecision.error) ok('an invalid decision is refused: ' + errMsg(badDecision.error));
    else no('invalid decision accepted');

    // --- reject
    const reason = 'ID photo is blurred — please re-upload a clear one.';
    const rej = await adminClient.rpc('review_provider_application', { p_provider_id: providerId, p_decision: 'reject', p_reason: reason });
    if (rej.error) no('admin reject failed: ' + errMsg(rej.error));
    else {
      const r = await rowOf(providerId);
      if (r.status === 'rejected' && r.kyc_status === 'rejected' && r.is_verified === false && r.rejection_reason === reason && r.reviewed_by === adminId && r.reviewed_at)
        ok('admin REJECT → status/kyc rejected, reason + reviewer + timestamp recorded');
      else no('reject left the row wrong: ' + JSON.stringify(r));

      const { data: notes } = await applicant.from('notifications').select('title, message, link')
        .eq('user_id', applicantId).gte('created_at', runStart).order('created_at', { ascending: false }).limit(1);
      if (notes?.[0]?.message === reason && notes[0].link === '/become-provider')
        ok('the provider is notified with the exact reason, linked to /become-provider');
      else no('rejection notification missing/wrong: ' + JSON.stringify(notes));

      const own = await applicant.from('my_provider_profile').select('status, rejection_reason').maybeSingle();
      if (own.data?.rejection_reason === reason) ok('the provider can read the reason on their own row (resubmit screen)');
      else no('provider cannot see the rejection reason: ' + JSON.stringify(own.error ?? own.data));
    }

    // --- resubmit after rejection clears the reason and returns to the queue
    const resub = await applicant.rpc('submit_provider_application', {
      p_category_id: categoryId, p_business_name: 'Step9 Applicant v3', p_bio: 'fixed',
      p_experience_years: 4, p_hourly_rate: 350, p_city: 'Mumbai', p_state: 'MH',
      p_address: 'Andheri', p_documents: [{ path: docPath, label: 'Photo ID', name: 'id.png', mime: 'image/png', uploaded_at: new Date().toISOString() }],
    });
    if (resub.error) no('resubmit after rejection failed: ' + errMsg(resub.error));
    else {
      const r = await rowOf(providerId);
      if (r.kyc_status === 'submitted' && r.rejection_reason === null)
        ok('resubmitting after a rejection clears the reason and re-enters the queue');
      else no('resubmit after rejection left: ' + JSON.stringify(r));
      if (r.status === 'rejected' || r.status === 'pending') ok(`status stays non-live on resubmit (${r.status})`);
      else no('resubmit made the provider live: ' + r.status);
    }

    // --- approve (Step 9.5: the paperwork must be verified first)
    await satisfyRequiredDocuments();
    const app = await adminClient.rpc('review_provider_application', { p_provider_id: providerId, p_decision: 'approve' });
    if (app.error) no('admin approve failed: ' + errMsg(app.error));
    else {
      const r = await rowOf(providerId);
      if (r.status === 'approved' && r.is_verified === true && r.kyc_status === 'verified' && r.rejection_reason === null)
        ok('admin APPROVE → approved + verified + kyc verified, reason cleared');
      else no('approve left the row wrong: ' + JSON.stringify(r));

      const { data: notes } = await applicant.from('notifications').select('title, type')
        .eq('user_id', applicantId).gte('created_at', runStart).order('created_at', { ascending: false }).limit(1);
      if (notes?.[0]?.type === 'success') ok('the provider is notified that they are verified');
      else no('approval notification missing/wrong: ' + JSON.stringify(notes));
    }
  }

  // ================= (c2) approved = live and bookable =================
  console.log('\n[c2) once approved, the provider is live]');
  {
    const list = await anon.from('service_providers').select('id').eq('status', 'approved');
    if ((list.data ?? []).some((p) => p.id === providerId)) ok('approved provider now appears in the public list');
    else no('approved provider still missing from the list');

    const bk = await mkBooking(booker, bookerId, providerId);
    if (!bk.error && bk.data?.id) { ok('an approved provider CAN be booked'); bookingIds.push(bk.data.id); }
    else no('approved provider still not bookable: ' + errMsg(bk.error));
  }

  // ================= (e2) documents freeze after approval =================
  console.log('\n[e2) verified documents are frozen]');
  {
    await applicant.storage.from(BUCKET).remove([docPath]);
    const { data: listed } = await service.storage.from(BUCKET).list(applicantId);
    const stillThere = (listed ?? []).some((o) => `${applicantId}/${o.name}` === docPath);
    if (stillThere) ok('a verified provider cannot delete the documents that justified approval');
    else no('the KYC document was deleted after verification');
  }

  // ================= (h) verification attests to a CLAIM =================
  // Regression cover for the hole found after Step 9 shipped: category_id is deliberately absent
  // from the client's UPDATE grant, but submit_provider_application is SECURITY DEFINER, so its
  // upsert wrote category over an APPROVED row while leaving status/is_verified alone — a
  // verified electrician could re-point their verified badge at elderly care, in a state
  // (approved + kyc submitted) the admin queue doesn't even list. Fixed in 20260801120000.
  console.log('\n[h) changing what you are verified FOR costs you the badge]');
  {
    const { data: cats } = await service.from('service_categories').select('id, slug').limit(2);
    const otherCategory = (cats ?? []).find((c) => c.id !== categoryId)?.id ?? null;

    const direct = await applicant.from('service_providers')
      .update({ category_id: otherCategory }).eq('id', providerId).select('id');
    if (denied(direct.error)) ok('a direct UPDATE of category_id is refused (Step-1 column grant)');
    else no('client updated category_id directly: ' + JSON.stringify(direct.error ?? direct.data));

    if (!otherCategory) {
      sk('only one service category exists — cannot exercise the category switch');
    } else {
      const before = await rowOf(providerId);
      const realDoc = [{ path: docPath, label: 'Photo ID', name: 'id.png', mime: 'image/png', uploaded_at: new Date().toISOString() }];
      const swap = await applicant.rpc('submit_provider_application', {
        p_category_id: otherCategory, p_business_name: 'Step9 Applicant', p_bio: 'switching trade',
        p_experience_years: 4, p_hourly_rate: 350, p_city: 'Mumbai', p_state: 'MH',
        p_address: 'Andheri', p_documents: realDoc,
      });
      const after = await rowOf(providerId);
      if (swap.error) {
        no('resubmission with a new category errored: ' + errMsg(swap.error));
      } else if (before.status === 'approved' && after.status === 'pending' && after.is_verified === false) {
        ok('switching category on an APPROVED row revokes the badge → pending + unverified');
      } else {
        no(`ESCALATION: category changed while status=${after.status}, is_verified=${after.is_verified}`);
      }
      if (after.kyc_status === 'submitted' && after.reviewed_at === null)
        ok('...and it re-enters the admin queue as a fresh application');
      else no('not cleanly re-queued: ' + JSON.stringify({ kyc: after.kyc_status, reviewed_at: after.reviewed_at }));

      const { data: notes } = await applicant.from('notifications').select('title')
        .eq('user_id', applicantId).gte('created_at', runStart).order('created_at', { ascending: false }).limit(1);
      if (/back in review/i.test(notes?.[0]?.title ?? ''))
        ok('...and the provider is told their profile is paused (honest status)');
      else no('provider not notified they went offline: ' + JSON.stringify(notes));

      // the badge must survive ordinary edits, or providers get knocked offline for a typo fix
      // (the new category may require different documents — stage them first)
      await satisfyRequiredDocuments();
      await adminClient.rpc('review_provider_application', { p_provider_id: providerId, p_decision: 'approve' });
      // note the SWAPPED document: an approved provider must not be able to substitute the
      // evidence an admin actually looked at.
      const edit = await applicant.rpc('submit_provider_application', {
        p_category_id: otherCategory, p_business_name: 'Step9 Applicant Renamed', p_bio: 'same trade, new blurb',
        p_experience_years: 6, p_hourly_rate: 420, p_city: 'Mumbai', p_state: 'MH',
        p_address: 'Andheri',
        p_documents: [{ path: `${applicantId}/swapped.png`, label: 'Photo ID', name: 'swapped.png', mime: 'image/png', uploaded_at: new Date().toISOString() }],
      });
      const edited = await rowOf(providerId);
      if (!edit.error && edited.status === 'approved' && edited.is_verified === true && edited.business_name === 'Step9 Applicant Renamed')
        ok('descriptive edits (name/bio/rate) keep an approved provider live');
      else no('a harmless edit changed the verification state: ' + JSON.stringify({ err: errMsg(edit.error), status: edited.status, verified: edited.is_verified }));

      // and the evidence behind a granted badge is not silently replaceable
      const keptDoc = (edited.kyc_documents ?? [])[0]?.path;
      if (keptDoc === docPath) ok('an approved provider cannot swap the KYC evidence behind their badge');
      else no(`approved provider replaced their KYC evidence: ${JSON.stringify(edited.kyc_documents)}`);
    }
  }

  // ================= eKYC stub =================
  console.log('\n[g) eKYC adapter is a stub, as specified]');
  {
    const { data, error } = await adminClient.rpc('request_ekyc', { p_provider_id: providerId });
    if (!error && data === 'ekyc_stub_pending') ok('request_ekyc returns the documented stub value');
    else no('request_ekyc: ' + (errMsg(error) || JSON.stringify(data)));
  }
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
}

// ================= cleanup =================
console.log('\n[cleanup]');
{
  for (const id of bookingIds) {
    await service.from('notifications').delete().like('link', `/bookings/${id}%`);
    await service.from('booking_events').delete().eq('booking_id', id);
  }
  if (bookingIds.length) await service.from('bookings').delete().in('id', bookingIds);
  if (objectPaths.length) await service.storage.from(BUCKET).remove(objectPaths);
  await service.from('notifications').delete().eq('user_id', applicantId).eq('link', '/become-provider').gte('created_at', runStart);
  if (providerId) {
    await service.from('reputation_snapshots').delete().eq('subject_type', 'provider').eq('subject_id', providerId);
    await service.from('service_providers').delete().eq('id', providerId);
  }
  console.log(`  removed ${bookingIds.length} booking(s), ${objectPaths.length} storage object(s), the test application and its notifications.`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
