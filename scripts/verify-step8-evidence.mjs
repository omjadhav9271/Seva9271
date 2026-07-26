/*
  Verifies Step-8.5 (dispute evidence + admin contact route) against the LIVE Supabase DB.
  Run AFTER `supabase db push` of 20260729120000_seva_dispute_evidence.sql, with test3 = admin.

  Account mapping (same as verify-step8):
    PROVIDER_EMAIL = test1 · CUSTOMER_EMAIL = test2 · STRANGER_EMAIL = test3 (admin)

  What it checks:
    (a) TABLE RLS — insert: a party can attach evidence while the dispute is OPEN; a party CANNOT
        forge uploader_role or uploaded_by; a NON-PARTY (the admin) cannot insert.
    (b) TABLE RLS — read: each party sees ONLY THEIR OWN evidence; the admin sees BOTH sides.
    (c) STORAGE RLS — a party can upload to <disputeId>/… while open; a non-party cannot; the
        object is readable by its owner + the admin, but NOT by the other party.
    (d) LIFECYCLE — once the dispute is RESOLVED, a party can no longer attach evidence.
    (e) CONTACT ROUTE — /api/admin/dispute-contacts is admin-only (party → 403; admin → both
        parties' name/phone/email). Skipped if the dev server isn't running.

  Usage:
    CUSTOMER_EMAIL=test2@gmail.com CUSTOMER_PASSWORD=test2@9271 \
    PROVIDER_EMAIL=test1@gmail.com PROVIDER_PASSWORD=test1@9271 \
    STRANGER_EMAIL=test3@gmail.com STRANGER_PASSWORD=test3@9271 \
    node scripts/verify-step8-evidence.mjs
*/
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'dispute-evidence';

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };
const errMsg = (e) => (e && (e.message || JSON.stringify(e))) || '';
const rlsDenied = (e) => e && (e.code === '42501' || /row-level security|violates|not authorized|Unauthorized/i.test(errMsg(e)));

console.log('DB:', URL, '\n');
if (!SERVICE) { console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY not in .env.local.'); process.exit(0); }
const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

async function authClient(prefix) {
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = process.env[`${prefix}_EMAIL`], password = process.env[`${prefix}_PASSWORD`];
  if (!email) return { client, userId: null, token: null };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) { console.log(`${prefix} signIn error:`, error.message); return { client, userId: null, token: null }; }
  return { client, userId: data?.user?.id ?? null, token: data?.session?.access_token ?? null };
}

console.log('[sessions]');
const { client: test2Client, userId: test2Id, token: test2Token } = await authClient('CUSTOMER');
const { client: test1Client, userId: test1Id } = await authClient('PROVIDER');
const { client: adminClient, userId: adminId, token: adminToken } = await authClient('STRANGER');
console.log('  test1(provider):', test1Id ?? 'NONE', '| test2(customer):', test2Id ?? 'NONE', '| test3(admin):', adminId ?? 'NONE', '\n');
if (!test1Id || !test2Id || !adminId || new Set([test1Id, test2Id, adminId]).size !== 3) {
  console.log('Cannot run: need THREE distinct sessions.'); process.exit(0);
}

// preflight: migration applied?
{
  const { error } = await service.from('dispute_evidence').select('id', { head: true, count: 'exact' });
  if (error) { console.log('Cannot run: dispute_evidence not reachable (' + error.message + '). Did you run supabase db push?'); process.exit(1); }
  const { data: buckets } = await service.storage.listBuckets();
  if (!(buckets ?? []).some((b) => b.id === BUCKET)) { console.log(`Cannot run: bucket '${BUCKET}' missing. Did the migration apply?`); process.exit(1); }
  const { data: adminProf } = await service.from('profiles').select('role').eq('id', adminId).maybeSingle();
  if (adminProf?.role !== 'admin') { console.log(`Cannot run: test3 is role='${adminProf?.role}', not admin.`); process.exit(1); }
}


const runStart = new Date().toISOString();
const walletOf = async (u) => Number((await service.from('profiles').select('wallet_balance').eq('id', u).maybeSingle()).data?.wallet_balance ?? 0);
const repOf = async (u) => Number((await service.from('profiles').select('reputation_score').eq('id', u).maybeSingle()).data?.reputation_score ?? 0);
const w1 = await walletOf(test1Id), w2 = await walletOf(test2Id), r1 = await repOf(test1Id), r2 = await repOf(test2Id);

const spIds = [], bookingIds = [], objectPaths = [];
let categoryId = null;
{ const { data: cat } = await service.from('service_categories').select('id').limit(1).maybeSingle(); categoryId = cat?.id ?? null; }
const uniq = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic; bucket checks declared type

// Step 9 allows ONE provider profile per user and test1 permanently owns one, so the fixture
// provider gets its own throwaway owner account AND session — it has to be a real signed-in
// party to attach evidence and to be denied access to the counterparty's files.
const throwawayOwners = [];
async function mkProvider(name) {
  const email = `step85-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@seva.test`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const { data: created, error: cErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (cErr) throw new Error('mkOwner: ' + cErr.message);
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error('mkOwner signIn: ' + sErr.message);
  throwawayOwners.push(created.user.id);
  const { data, error } = await service.from('service_providers').insert({
    user_id: created.user.id, business_name: name, bio: 'step8.5 seed', hourly_rate: 300, city: 'Mumbai', state: 'MH',
  }).select('id').single();
  if (error) throw new Error('mkProvider: ' + error.message);
  spIds.push(data.id);
  return { id: data.id, ownerId: created.user.id, client };
}
async function mkBooking(sp) {
  const { data, error } = await service.from('bookings').insert({
    customer_id: test2Id, provider_id: sp, category_id: categoryId, service_type: 'one-time',
    scheduled_date: '2026-09-20', scheduled_time: '11:00', duration_hours: 2, hourly_rate: 300,
    total_amount: 600, payment_method: 'upi', status: 'in_progress', payment_status: 'pending',
  }).select('id').single();
  if (error) throw new Error('mkBooking: ' + error.message);
  bookingIds.push(data.id); return data.id;
}
const disputeIdOf = (d) => (Array.isArray(d) ? d[0] : d)?.id ?? null;
// evidence row insert via a given client (table RLS test)
const insEvidence = (client, { disputeId, bookingId, role, uploadedBy, kind = 'image' }) =>
  client.from('dispute_evidence').insert({
    dispute_id: disputeId, booking_id: bookingId, uploader_role: role,
    uploaded_by: uploadedBy, file_path: `${disputeId}/${uniq()}.png`, mime_type: 'image/png', kind,
  }).select('id');

try {
  const sp = await mkProvider('Step8.5 provider');
  const bk = await mkBooking(sp.id);
  const raised = await test2Client.rpc('raise_dispute', { p_booking_id: bk, p_reason: 'work_not_done', p_description: 'seed' });
  const dId = disputeIdOf(raised.data);
  if (!dId) throw new Error('raise_dispute failed: ' + errMsg(raised.error));

  // ================= (a) table insert RLS =================
  console.log('[a) table RLS — who may attach evidence while OPEN]');
  {
    const good1 = await insEvidence(test2Client, { disputeId: dId, bookingId: bk, role: 'customer', uploadedBy: test2Id });
    if (!good1.error) ok('customer (party) can attach evidence while the dispute is open');
    else no('customer insert rejected: ' + errMsg(good1.error));

    const good2 = await insEvidence(sp.client, { disputeId: dId, bookingId: bk, role: 'provider', uploadedBy: sp.ownerId });
    if (!good2.error) ok('provider (party) can attach evidence too');
    else no('provider insert rejected: ' + errMsg(good2.error));

    const lie = await insEvidence(test2Client, { disputeId: dId, bookingId: bk, role: 'provider', uploadedBy: test2Id });
    if (rlsDenied(lie.error)) ok('a party CANNOT forge uploader_role (customer claiming provider) — RLS blocks it');
    else no('forged uploader_role not blocked: ' + JSON.stringify(lie.error ?? lie.data));

    const spoof = await insEvidence(test2Client, { disputeId: dId, bookingId: bk, role: 'customer', uploadedBy: sp.ownerId });
    if (rlsDenied(spoof.error)) ok('a party CANNOT set uploaded_by to someone else — RLS blocks it');
    else no('forged uploaded_by not blocked: ' + JSON.stringify(spoof.error ?? spoof.data));

    const outsider = await insEvidence(adminClient, { disputeId: dId, bookingId: bk, role: 'customer', uploadedBy: adminId });
    if (rlsDenied(outsider.error)) ok('a NON-PARTY (admin) cannot inject evidence — the admin adjudicates, not submits');
    else no('non-party insert not blocked: ' + JSON.stringify(outsider.error ?? outsider.data));
  }

  // ================= (b) read visibility =================
  console.log('\n[b) table RLS — read: own-only for parties, all for admin]');
  {
    const asCust = (await test2Client.from('dispute_evidence').select('id, uploader_role').eq('dispute_id', dId)).data ?? [];
    const asProv = (await sp.client.from('dispute_evidence').select('id, uploader_role').eq('dispute_id', dId)).data ?? [];
    const asAdmin = (await adminClient.from('dispute_evidence').select('id, uploader_role').eq('dispute_id', dId)).data ?? [];
    if (asCust.length === 1 && asCust[0].uploader_role === 'customer') ok('customer sees ONLY their own evidence (1 row)');
    else no('customer read leaked/short: ' + JSON.stringify(asCust));
    if (asProv.length === 1 && asProv[0].uploader_role === 'provider') ok('provider sees ONLY their own evidence (1 row)');
    else no('provider read leaked/short: ' + JSON.stringify(asProv));
    if (asAdmin.length === 2) ok('admin sees BOTH parties\' evidence (2 rows)');
    else no('admin did not see both rows: ' + JSON.stringify(asAdmin));
  }

  // ================= (c) storage RLS =================
  console.log('\n[c) storage RLS — upload/read on the private bucket]');
  {
    const custPath = `${dId}/${uniq()}.png`;
    const up = await test2Client.storage.from(BUCKET).upload(custPath, pngBytes, { contentType: 'image/png' });
    if (!up.error) { ok('customer (party) can UPLOAD to their dispute folder while open'); objectPaths.push(custPath); }
    else no('customer upload rejected: ' + errMsg(up.error));

    const outsiderPath = `${dId}/${uniq()}.png`;
    const upBad = await adminClient.storage.from(BUCKET).upload(outsiderPath, pngBytes, { contentType: 'image/png' });
    if (upBad.error) ok('a non-party (admin) CANNOT upload evidence: ' + errMsg(upBad.error));
    else { no('non-party upload was allowed'); objectPaths.push(outsiderPath); }

    // owner + admin can sign; the OTHER party cannot
    const ownerSign = await test2Client.storage.from(BUCKET).createSignedUrl(custPath, 60);
    if (ownerSign.data?.signedUrl) ok('owner can generate a signed URL for their own file');
    else no('owner could not sign own file: ' + errMsg(ownerSign.error));

    const adminSign = await adminClient.storage.from(BUCKET).createSignedUrl(custPath, 60);
    if (adminSign.data?.signedUrl) ok('admin can generate a signed URL for any evidence file');
    else no('admin could not sign evidence file: ' + errMsg(adminSign.error));

    const otherSign = await sp.client.storage.from(BUCKET).createSignedUrl(custPath, 60);
    if (!otherSign.data?.signedUrl) ok('the OTHER party cannot read a file that isn\'t theirs (storage RLS)');
    else no('other party WRONGLY signed a counterparty file');
  }

  // ================= (d) lifecycle: no evidence after resolution =================
  console.log('\n[d) lifecycle — evidence closes when the dispute resolves]');
  {
    const res = await adminClient.rpc('resolve_dispute', { p_dispute_id: dId, p_outcome: 'no_fault', p_fault: 'none', p_notes: 'evidence test', p_refund_amount: null });
    if (res.error) no('resolve_dispute failed: ' + errMsg(res.error));
    const late = await insEvidence(test2Client, { disputeId: dId, bookingId: bk, role: 'customer', uploadedBy: test2Id });
    if (rlsDenied(late.error)) ok('after resolution a party can no longer attach evidence (RLS)');
    else no('evidence insert after resolution not blocked: ' + JSON.stringify(late.error ?? late.data));
    const lateUp = await test2Client.storage.from(BUCKET).upload(`${dId}/${uniq()}.png`, pngBytes, { contentType: 'image/png' });
    if (lateUp.error) ok('after resolution a party can no longer upload files (storage RLS)');
    else { no('upload after resolution not blocked'); objectPaths.push(lateUp.data?.path); }
  }

  // ================= (e) contact route (admin-only) =================
  console.log('\n[e) contact route — admin-only]');
  {
    let serverUp = false;
    try { const r = await fetch('http://localhost:3000', { signal: AbortSignal.timeout(3000) }); serverUp = r.ok || r.status < 500; } catch { serverUp = false; }
    if (!serverUp) {
      sk('dev server not running on :3000 — start `npm run dev` to exercise /api/admin/dispute-contacts');
    } else {
      const asParty = await fetch(`http://localhost:3000/api/admin/dispute-contacts?disputeId=${dId}`, { headers: { Authorization: `Bearer ${test2Token}` } });
      if (asParty.status === 403) ok('a party (non-admin) gets 403 from the contact route');
      else no('contact route did not 403 a party: HTTP ' + asParty.status);

      const asAdmin = await fetch(`http://localhost:3000/api/admin/dispute-contacts?disputeId=${dId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const body = await asAdmin.json().catch(() => ({}));
      if (asAdmin.ok && body.customer && body.provider) ok(`admin gets both parties' contacts (customer email ${body.customer.email ? 'present' : 'null'}, provider phone ${body.provider.phone ? 'present' : 'null'})`);
      else no('admin contact fetch failed: HTTP ' + asAdmin.status + ' ' + JSON.stringify(body));
    }
  }
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
}

// ================= cleanup =================
console.log('\n[cleanup]');
{
  if (objectPaths.length) await service.storage.from(BUCKET).remove(objectPaths.filter(Boolean));
  for (const id of bookingIds) await service.from('notifications').delete().like('link', `/bookings/${id}%`);
  if (bookingIds.length) {
    await service.from('wallet_transactions').delete().in('reference_id', bookingIds);
    await service.from('bookings').delete().in('id', bookingIds); // cascades disputes + dispute_evidence
  }
  if (spIds.length) {
    await service.from('reputation_snapshots').delete().in('subject_id', spIds);
    await service.from('service_providers').delete().in('id', spIds);
  }
  for (const u of [test1Id, test2Id]) await service.from('reputation_snapshots').delete().eq('subject_type', 'customer').eq('subject_id', u).gte('computed_at', runStart);
  for (const uid of throwawayOwners) await service.auth.admin.deleteUser(uid);
  await service.from('profiles').update({ wallet_balance: w1, reputation_score: r1 }).eq('id', test1Id);
  await service.from('profiles').update({ wallet_balance: w2, reputation_score: r2 }).eq('id', test2Id);
  console.log(`  cleaned ${bookingIds.length} booking(s), ${spIds.length} provider(s), ${objectPaths.filter(Boolean).length} storage object(s); wallet/reputation restored.`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
