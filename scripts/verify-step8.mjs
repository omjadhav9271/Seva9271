/*
  Verifies Step-8 (disputes + admin console) against the LIVE Supabase DB.
  Run it AFTER `supabase db push` of 20260728120000_seva_disputes.sql AND after promoting one
  account to admin (this script expects STRANGER = the admin).

  Account mapping (live-DB roles; see the test-accounts note):
    PROVIDER_EMAIL = test1  (owns the seeded service_providers rows → the "provider party")
    CUSTOMER_EMAIL = test2  (the "customer party")
    STRANGER_EMAIL = test3  (promoted to role='admin' → resolves disputes, reads the bundle)
  To avoid the customer/provider naming flipping around in the customer-direction test, we alias
  the three sessions by account: test1Client / test2Client / adminClient.

  Strategy: the service role seeds providers + bookings + ledger rows directly (it is the only
  writer of those), then all dispute actions go through the REAL RPCs from the REAL sessions —
  raise_dispute from a party, resolve_dispute from the admin — exactly as the app calls them.
  compute_reputation / dispute_fault_rate are server-only, so we call them via the service role.

  What it checks (the Step-8 "Done when"):
    (a) raise_dispute: either party can dispute a disputable booking → booking becomes 'disputed',
        a booking_events row records it (actor = raiser), and the counterparty is notified
    (b) a SECOND open dispute on the same booking is rejected (status guard + partial unique index)
    (c) a NON-PARTY is rejected from raise_dispute (no admin bypass — even the admin is rejected)
    (d) resolve_dispute is ADMIN-ONLY: a party (customer or provider) is rejected; the admin
        succeeds, records outcome+fault, exits 'disputed', notifies BOTH parties
    (e) MONEY — held → favor_provider: escrow released to the provider's wallet (−15% fee), ledger
        captured→released, booking payment_status→'released'
    (f) MONEY — released → favor_customer: wallet CLAWBACK (debit) from the already-paid provider,
        booking payment_status→'refunded', status→'cancelled'
    (g) REPUTATION follows FAULT (provider): an exonerated provider takes NO hit; one found at
        fault drops — before/after resolution
    (h) REPUTATION follows FAULT (customer): symmetric — exonerated customer unchanged, at-fault
        customer drops
    (i) EVIDENCE BUNDLE access: the admin reads a booking's disputes/bookings/messages/events/
        payments/profiles it is NOT party to; a non-admin non-party reads ZERO of each
    (j) dispute_fault_rate is server-only (authenticated/anon cannot execute it)

  Usage (from repo root):
    CUSTOMER_EMAIL=test2@gmail.com CUSTOMER_PASSWORD=test2@9271 \
    PROVIDER_EMAIL=test1@gmail.com PROVIDER_PASSWORD=test1@9271 \
    STRANGER_EMAIL=test3@gmail.com STRANGER_PASSWORD=test3@9271 \
    node scripts/verify-step8.mjs
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
const round2 = (x) => Math.round(x * 100) / 100;

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

// ---- sessions (aliased by account to keep customer/provider flips readable) ----
console.log('[sessions]');
const { client: test2Client, userId: test2Id } = await authClient('CUSTOMER'); // customer party
const { client: test1Client, userId: test1Id } = await authClient('PROVIDER'); // provider party
const { client: adminClient, userId: adminId }  = await authClient('STRANGER'); // admin
console.log('  test1(provider):', test1Id ?? 'NONE', '| test2(customer):', test2Id ?? 'NONE', '| test3(admin):', adminId ?? 'NONE', '\n');
const distinct = new Set([test1Id, test2Id, adminId]);
if (!test1Id || !test2Id || !adminId || distinct.size !== 3) {
  console.log('Cannot run: need THREE distinct sessions (set CUSTOMER_*, PROVIDER_*, STRANGER_*).');
  process.exit(0);
}

// ---- preflight: migration applied + admin promoted ----
{
  const { error } = await service.from('disputes').select('id', { head: true, count: 'exact' });
  if (error) { console.log('Cannot run: disputes table not reachable (' + error.message + '). Did you run supabase db push?'); process.exit(1); }
  const { data: adminProf } = await service.from('profiles').select('role').eq('id', adminId).maybeSingle();
  if (adminProf?.role !== 'admin') {
    console.log(`Cannot run: STRANGER account (test3) is role='${adminProf?.role}', not 'admin'. Promote it first.`);
    process.exit(1);
  }
}

// ---- reputation constants (mirror the migration) for expected values ----
const PRIOR = 4.0, C = 5, W_REV = 0.7, W_OPS = 0.3;
// score of a provider/customer with NO reviews and a given ops_score
const scoreNoReviews = (ops) => round2(W_REV * ((C * PRIOR) / C) + W_OPS * ops); // review_score → prior

// ---- record originals to restore (this script mutates real wallet + reputation) ----
const runStart = new Date().toISOString();
const walletOf = async (uid) => Number((await service.from('profiles').select('wallet_balance').eq('id', uid).maybeSingle()).data?.wallet_balance ?? 0);
const repOf    = async (uid) => Number((await service.from('profiles').select('reputation_score').eq('id', uid).maybeSingle()).data?.reputation_score ?? 0);
const w1_0 = await walletOf(test1Id), w2_0 = await walletOf(test2Id);
const rep1_0 = await repOf(test1Id), rep2_0 = await repOf(test2Id);

// ---- seed helpers (service role; track every id for cleanup) ----
const spIds = [], bookingIds = [];
let categoryId = null;
{ const { data: cat } = await anon.from('service_categories').select('id').limit(1).maybeSingle(); categoryId = cat?.id ?? null; }

let rnd = 0;
const uniq = () => `${Date.now()}_${rnd++}`;

async function mkProvider(ownerId, name) {
  const { data, error } = await service.from('service_providers').insert({
    user_id: ownerId, business_name: name, bio: 'step8 verify seed',
    hourly_rate: 300, city: 'Mumbai', state: 'MH',
  }).select('id').single();
  if (error) throw new Error('mkProvider ' + name + ': ' + error.message);
  spIds.push(data.id);
  return data.id;
}
async function mkBooking({ customer, provider, status, payment_status = 'pending', total = 600, price_charged = null }) {
  const { data, error } = await service.from('bookings').insert({
    customer_id: customer, provider_id: provider, category_id: categoryId,
    service_type: 'one-time', scheduled_date: '2026-09-20', scheduled_time: '11:00',
    duration_hours: 2, hourly_rate: 300, total_amount: total, price_charged,
    payment_method: 'upi', status, payment_status,
  }).select('id').single();
  if (error) throw new Error('mkBooking: ' + error.message);
  bookingIds.push(data.id);
  return data.id;
}
async function mkPayTx(bookingId, { status, amount = 60000, provider_amount = null, platform_fee = null, withPayment = true }) {
  const { data, error } = await service.from('payment_transactions').insert({
    booking_id: bookingId, razorpay_order_id: 'order_s8_' + uniq(),
    razorpay_payment_id: withPayment ? 'pay_s8_' + uniq() : null,
    amount, status, provider_amount, platform_fee,
  }).select('id').single();
  if (error) throw new Error('mkPayTx: ' + error.message);
  return data.id;
}
const disputeIdOf = (data) => { const row = Array.isArray(data) ? data[0] : data; return row?.id ?? null; };
async function raiseAs(client, bookingId, reason = 'other', description = null) {
  return client.rpc('raise_dispute', { p_booking_id: bookingId, p_reason: reason, p_description: description });
}
async function resolveAs(client, disputeId, outcome, fault, { notes = null, refund = null } = {}) {
  return client.rpc('resolve_dispute', { p_dispute_id: disputeId, p_outcome: outcome, p_fault: fault, p_notes: notes, p_refund_amount: refund });
}
const computeRep = async (type, id) => {
  const { data, error } = await service.rpc('compute_reputation', { p_subject_type: type, p_subject_id: id });
  if (error) throw new Error('compute_reputation(' + type + '): ' + error.message);
  return Number(data);
};
const faultRate = async (type, id) => {
  const { data, error } = await service.rpc('dispute_fault_rate', { p_subject_type: type, p_subject_id: id });
  if (error) throw new Error('dispute_fault_rate(' + type + '): ' + error.message);
  return Number(data);
};
const latestSnap = async (type, id) => (await service.from('reputation_snapshots').select('score, breakdown, computed_at')
  .eq('subject_type', type).eq('subject_id', id).order('computed_at', { ascending: false }).limit(1).maybeSingle()).data ?? null;
const bookingRow = async (id) => (await service.from('bookings').select('status, payment_status').eq('id', id).maybeSingle()).data;
const payTxRow = async (id) => (await service.from('payment_transactions').select('*').eq('id', id).maybeSingle()).data;
const disputeRow = async (id) => (await service.from('disputes').select('*').eq('id', id).maybeSingle()).data;
const notifCount = async (uid, title, bookingId) => (await service.from('notifications')
  .select('id', { head: true, count: 'exact' }).eq('user_id', uid).eq('title', title).like('link', `/bookings/${bookingId}%`)).count ?? 0;
const eventExists = async (bookingId, toStatus, actorRole) => {
  const q = service.from('booking_events').select('id', { head: true, count: 'exact' }).eq('booking_id', bookingId).eq('to_status', toStatus);
  if (actorRole) q.eq('actor_role', actorRole);
  return (await q).count ?? 0;
};
// count rows a given client can SEE (RLS-scoped) for a table on a booking
const seenBy = async (client, table, bookingId) =>
  ((await client.from(table).select('id').eq('booking_id', bookingId)).data ?? []).length;

const errMsg = (e) => (e && (e.message || JSON.stringify(e))) || '';
const isDenied = (e) => e && (e.code === '42501' || /permission denied/i.test(errMsg(e)));

try {

  // ================= (a) raise_dispute: either party → disputed + event + counterparty notified =================
  console.log('[a) raise_dispute: either party disputes a disputable booking → disputed + event + notify]');
  {
    const sp = await mkProvider(test1Id, 'Step8 A provider');
    // customer raises
    const bkCust = await mkBooking({ customer: test2Id, provider: sp, status: 'in_progress' });
    const rC = await raiseAs(test2Client, bkCust, 'work_not_done', 'nothing was done');
    if (!rC.error && disputeIdOf(rC.data)) ok('CUSTOMER can raise a dispute (raise_dispute returned the row)');
    else no('customer raise_dispute failed: ' + errMsg(rC.error));
    const afterC = await bookingRow(bkCust);
    if (afterC?.status === 'disputed') ok('booking → disputed after a customer raise');
    else no('booking not disputed after customer raise: ' + JSON.stringify(afterC));
    if (await eventExists(bkCust, 'disputed', 'customer')) ok("booking_events row records the disputed transition (actor_role='customer')");
    else no('no disputed booking_event with actor_role=customer');
    if (await notifCount(test1Id, 'Dispute raised', bkCust)) ok('counterparty (provider) notified on raise');
    else no('provider was not notified on a customer-raised dispute');

    // provider raises (the other direction)
    const bkProv = await mkBooking({ customer: test2Id, provider: sp, status: 'completed' });
    const rP = await raiseAs(test1Client, bkProv, 'payment_not_received');
    if (!rP.error && disputeIdOf(rP.data)) ok('PROVIDER can raise a dispute');
    else no('provider raise_dispute failed: ' + errMsg(rP.error));
    if ((await bookingRow(bkProv))?.status === 'disputed') ok('booking → disputed after a provider raise');
    else no('booking not disputed after provider raise');
    if (await notifCount(test2Id, 'Dispute raised', bkProv)) ok('counterparty (customer) notified on raise');
    else no('customer was not notified on a provider-raised dispute');

    // ---- (b) second open dispute on the same booking is rejected ----
    console.log('\n[b) a second OPEN dispute on the same booking is rejected]');
    const dup = await raiseAs(test1Client, bkCust, 'other');
    if (dup.error) ok('second raise_dispute on an already-disputed booking rejected: ' + errMsg(dup.error));
    else no('second raise_dispute unexpectedly succeeded');
    // and the partial unique index blocks a direct 2nd non-resolved row
    const dupIns = await service.from('disputes').insert({ booking_id: bkCust, raised_by: test1Id, raiser_role: 'provider', reason: 'other', status: 'open' }).select('id');
    if (dupIns.error && dupIns.error.code === '23505') ok('partial unique index blocks a 2nd non-resolved dispute row (23505)');
    else no('partial unique index did not block a 2nd open dispute: ' + JSON.stringify(dupIns.error ?? dupIns.data));

    // ---- (c) a non-party is rejected from raise_dispute (no admin bypass) ----
    console.log('\n[c) a non-party (here: the admin) is rejected from raise_dispute]');
    const bkFresh = await mkBooking({ customer: test2Id, provider: sp, status: 'in_progress' });
    const np = await raiseAs(adminClient, bkFresh, 'other');
    if (np.error && /not a party/i.test(errMsg(np.error))) ok('non-party raise_dispute rejected: ' + errMsg(np.error));
    else no('non-party raise_dispute not cleanly rejected: ' + JSON.stringify(np.error ?? np.data));
  }

  // ================= (d) resolve_dispute is ADMIN-ONLY; admin resolves + notifies both =================
  console.log('\n[d) resolve_dispute: parties rejected, admin resolves + notifies both]');
  {
    const sp = await mkProvider(test1Id, 'Step8 D provider');
    const bk = await mkBooking({ customer: test2Id, provider: sp, status: 'in_progress' });
    const r = await raiseAs(test2Client, bk, 'other');
    const dId = disputeIdOf(r.data);

    const byCustomer = await resolveAs(test2Client, dId, 'no_fault', 'none');
    if (byCustomer.error && /admin only/i.test(errMsg(byCustomer.error))) ok('a PARTY (customer) calling resolve_dispute is rejected: ' + errMsg(byCustomer.error));
    else no('customer resolve_dispute not rejected: ' + JSON.stringify(byCustomer.error ?? byCustomer.data));
    const byProvider = await resolveAs(test1Client, dId, 'no_fault', 'none');
    if (byProvider.error && /admin only/i.test(errMsg(byProvider.error))) ok('a PARTY (provider) calling resolve_dispute is rejected');
    else no('provider resolve_dispute not rejected: ' + JSON.stringify(byProvider.error ?? byProvider.data));

    const byAdmin = await resolveAs(adminClient, dId, 'no_fault', 'none', { notes: 'both heard; no fault' });
    if (!byAdmin.error) ok('the ADMIN can resolve the dispute');
    else no('admin resolve_dispute failed: ' + errMsg(byAdmin.error));
    const dAfter = await disputeRow(dId);
    if (dAfter?.status === 'resolved' && dAfter?.outcome === 'no_fault' && dAfter?.fault_party === 'none' && dAfter?.resolved_by === adminId)
      ok('dispute recorded resolved with outcome+fault+resolver');
    else no('resolved dispute not recorded as expected: ' + JSON.stringify(dAfter));
    if ((await bookingRow(bk))?.status !== 'disputed') ok("booking EXITS 'disputed' on resolution (status=" + (await bookingRow(bk))?.status + ')');
    else no("booking still 'disputed' after resolution");
    const both = (await notifCount(test2Id, 'Dispute resolved', bk)) > 0 && (await notifCount(test1Id, 'Dispute resolved', bk)) > 0;
    if (both) ok('BOTH parties notified on resolution');
    else no('resolution did not notify both parties');
  }

  // ================= (e) MONEY: held → favor_provider releases escrow to the provider (−15%) =================
  console.log('\n[e) money: held booking, favor_provider → escrow released to provider wallet (−15% fee)]');
  {
    const sp = await mkProvider(test1Id, 'Step8 E provider');
    const bk = await mkBooking({ customer: test2Id, provider: sp, status: 'in_progress', payment_status: 'held', price_charged: 600 });
    const tx = await mkPayTx(bk, { status: 'captured', amount: 60000 });
    const wBefore = await walletOf(test1Id);
    const r = await raiseAs(test2Client, bk, 'other');
    const rr = await resolveAs(adminClient, disputeIdOf(r.data), 'favor_provider', 'customer');
    if (rr.error) no('resolve favor_provider failed: ' + errMsg(rr.error));
    const wAfter = await walletOf(test1Id);
    if (round2(wAfter - wBefore) === 510) ok(`provider wallet credited the 85% payout: +₹${round2(wAfter - wBefore)} (600 − 15% fee)`);
    else no(`provider wallet delta wrong: expected +510, got +${round2(wAfter - wBefore)}`);
    const wt = (await service.from('wallet_transactions').select('type, amount').eq('reference_id', bk).eq('user_id', test1Id).eq('type', 'credit').maybeSingle()).data;
    if (wt && Number(wt.amount) === 510) ok('a credit wallet_transaction of 510 was written for the provider');
    else no('provider credit wallet_transaction not found/!=510: ' + JSON.stringify(wt));
    const txRow = await payTxRow(tx);
    if (txRow?.status === 'released' && Number(txRow.provider_amount) === 510 && Number(txRow.platform_fee) === 90)
      ok('ledger row captured→released with provider_amount=510, platform_fee=90');
    else no('ledger row not released as expected: ' + JSON.stringify(txRow));
    if ((await bookingRow(bk))?.payment_status === 'released') ok("booking payment_status → 'released'");
    else no('booking payment_status not released');
  }

  // ================= (f) MONEY: released → favor_customer claws back from the provider =================
  console.log('\n[f) money: already-released booking, favor_customer → wallet clawback (debit) from provider]');
  {
    const sp = await mkProvider(test1Id, 'Step8 F provider');
    const bk = await mkBooking({ customer: test2Id, provider: sp, status: 'paid', payment_status: 'released', price_charged: 600 });
    await mkPayTx(bk, { status: 'released', amount: 60000, provider_amount: 510, platform_fee: 90 });
    // simulate the earlier payout sitting in the provider's wallet, so the clawback has funds
    await service.rpc('credit_wallet', { p_user_id: test1Id, p_amount: 600, p_type: 'credit', p_description: 'step8 seed prior payout', p_reference_id: bk });
    const wBefore = await walletOf(test1Id);
    const r = await raiseAs(test2Client, bk, 'poor_quality');
    const rr = await resolveAs(adminClient, disputeIdOf(r.data), 'favor_customer', 'provider', { notes: 'refund the customer' });
    if (rr.error) no('resolve favor_customer failed: ' + errMsg(rr.error));
    const wAfter = await walletOf(test1Id);
    if (round2(wBefore - wAfter) === 600) ok(`provider wallet CLAWED BACK the full ₹600: ${round2(wAfter - wBefore)}`);
    else no(`clawback delta wrong: expected −600, got ${round2(wAfter - wBefore)}`);
    const wt = (await service.from('wallet_transactions').select('type, amount').eq('reference_id', bk).eq('user_id', test1Id).eq('type', 'debit').maybeSingle()).data;
    if (wt && Number(wt.amount) === 600) ok('a debit wallet_transaction of 600 was written (the clawback)');
    else no('clawback debit wallet_transaction not found/!=600: ' + JSON.stringify(wt));
    const bAfter = await bookingRow(bk);
    if (bAfter?.payment_status === 'refunded' && bAfter?.status === 'cancelled') ok("booking → status 'cancelled', payment_status 'refunded'");
    else no('booking not refunded/cancelled as expected: ' + JSON.stringify(bAfter));
  }

  // ================= (g) REPUTATION follows FAULT — provider side =================
  console.log('\n[g) reputation follows FAULT (provider): exonerated takes NO hit, at-fault DROPS]');
  {
    const cleanOps = 5; // 4 paid bookings, no cancellations
    const expExon  = scoreNoReviews(cleanOps);                 // fault_rate 0 → ops 5
    const expFault = scoreNoReviews(cleanOps - 3 * 0.25);      // fault_rate 1/4 → ops 4.25

    // -- exonerated provider --
    const pExon = await mkProvider(test1Id, 'Step8 G exonerated');
    let bExon;
    for (let i = 0; i < 4; i++) { const b = await mkBooking({ customer: test2Id, provider: pExon, status: 'paid' }); if (i === 0) bExon = b; }
    const gExonBefore = await computeRep('provider', pExon);
    const rE = await raiseAs(test2Client, bExon, 'other');
    await resolveAs(adminClient, disputeIdOf(rE.data), 'favor_provider', 'customer'); // provider NOT at fault
    const gExonAfter = await computeRep('provider', pExon);
    const frExon = await faultRate('provider', pExon);
    console.log(`  exonerated: before ${gExonBefore} → after ${gExonAfter} (expected ${expExon}, provider fault_rate=${frExon})`);
    if (Math.abs(gExonAfter - gExonBefore) <= 0.001) ok(`EXONERATED provider: score UNCHANGED (${gExonBefore} → ${gExonAfter})`);
    else no(`exonerated provider score moved: ${gExonBefore} → ${gExonAfter}`);
    if (frExon === 0) ok('exonerated provider dispute_fault_rate = 0 (disputed but not at fault)');
    else no(`exonerated provider fault_rate should be 0, got ${frExon}`);

    // -- at-fault provider (identical record, only fault differs) --
    const pFault = await mkProvider(test1Id, 'Step8 G at-fault');
    let bFault;
    for (let i = 0; i < 4; i++) { const b = await mkBooking({ customer: test2Id, provider: pFault, status: 'paid' }); if (i === 0) bFault = b; }
    const gFaultBefore = await computeRep('provider', pFault);
    const rF = await raiseAs(test2Client, bFault, 'poor_quality');
    await resolveAs(adminClient, disputeIdOf(rF.data), 'partial', 'provider', { refund: 100 }); // provider AT fault, booking stays 'paid'
    const gFaultAfter = await computeRep('provider', pFault);
    const frFault = await faultRate('provider', pFault);
    console.log(`  at-fault:   before ${gFaultBefore} → after ${gFaultAfter} (expected ${expFault}, provider fault_rate=${frFault})`);
    if (gFaultAfter < gFaultBefore) ok(`AT-FAULT provider: score DROPPED (${gFaultBefore} → ${gFaultAfter})`);
    else no(`at-fault provider score did not drop: ${gFaultBefore} → ${gFaultAfter}`);
    if (Math.abs(gFaultAfter - expFault) <= 0.02) ok(`at-fault score matches the −3·fault_rate ops formula (${gFaultAfter} ≈ ${expFault})`);
    else no(`at-fault score off formula: got ${gFaultAfter}, expected ${expFault}`);
    if (gFaultAfter < gExonAfter) ok(`FAULT is what moves the needle: at-fault (${gFaultAfter}) < exonerated (${gExonAfter}) — a frivolous dispute alone cannot tank a provider`);
    else no(`at-fault (${gFaultAfter}) should score below exonerated (${gExonAfter})`);
  }

  // ================= (h) REPUTATION follows FAULT — customer side =================
  console.log('\n[h) reputation follows FAULT (customer): exonerated unchanged, at-fault DROPS]');
  {
    // customer = test1 (clean of real customer bookings); provider = an SP owned by test2
    const spC = await mkProvider(test2Id, 'Step8 H provider');
    const bcExon = await mkBooking({ customer: test1Id, provider: spC, status: 'paid' });
    const bcFault = await mkBooking({ customer: test1Id, provider: spC, status: 'paid' });
    const cBefore = await computeRep('customer', test1Id);
    const frBefore = await faultRate('customer', test1Id);

    // exonerate the customer (provider raises; resolved with no customer fault)
    const rE = await raiseAs(test2Client, bcExon, 'customer_behaviour');
    await resolveAs(adminClient, disputeIdOf(rE.data), 'no_fault', 'none');
    const cAfterExon = await computeRep('customer', test1Id);
    const frExon = await faultRate('customer', test1Id);
    console.log(`  exonerated: ${cBefore} → ${cAfterExon} (customer fault_rate ${frBefore} → ${frExon})`);
    if (Math.abs(cAfterExon - cBefore) <= 0.001 && frExon === frBefore) ok(`EXONERATED customer: score UNCHANGED (${cBefore} → ${cAfterExon})`);
    else no(`exonerated customer moved: ${cBefore} → ${cAfterExon} (fault_rate ${frBefore}→${frExon})`);

    // now find the customer at fault
    const rF = await raiseAs(test2Client, bcFault, 'customer_behaviour');
    await resolveAs(adminClient, disputeIdOf(rF.data), 'favor_provider', 'customer');
    const cAfterFault = await computeRep('customer', test1Id);
    const frFault = await faultRate('customer', test1Id);
    console.log(`  at-fault:   ${cAfterExon} → ${cAfterFault} (customer fault_rate ${frExon} → ${frFault})`);
    if (cAfterFault < cAfterExon && frFault > frExon) ok(`AT-FAULT customer: score DROPPED (${cAfterExon} → ${cAfterFault}), fault_rate ${frExon} → ${frFault}`);
    else no(`at-fault customer did not drop: ${cAfterExon} → ${cAfterFault} (fault_rate ${frExon}→${frFault})`);
  }

  // ================= (i) evidence-bundle access: admin reads a foreign booking, non-admin reads zero =================
  console.log('\n[i) evidence bundle: admin reads a booking it is not party to; a non-admin non-party reads ZERO]');
  {
    // foreign booking whose ONLY party is test1 → test2 is a clean non-admin outsider; test3 is admin & non-party
    const spF = await mkProvider(test1Id, 'Step8 I provider');
    const bkF = await mkBooking({ customer: test1Id, provider: spF, status: 'in_progress' });
    await service.from('disputes').insert({ booking_id: bkF, raised_by: test1Id, raiser_role: 'customer', reason: 'other', status: 'open' });
    await service.from('messages').insert({ booking_id: bkF, sender_id: test1Id, body: 'step8 evidence message' });
    await mkPayTx(bkF, { status: 'captured', amount: 60000 });

    // admin (not a party) sees the whole bundle via the additive admin_read_* policies
    const aD = await seenBy(adminClient, 'disputes', bkF);
    const aM = await seenBy(adminClient, 'messages', bkF);
    const aE = await seenBy(adminClient, 'booking_events', bkF);
    const aP = await seenBy(adminClient, 'payment_transactions', bkF);
    const aB = ((await adminClient.from('bookings').select('id').eq('id', bkF)).data ?? []).length;
    const aProf = ((await adminClient.from('profiles').select('id').eq('id', test1Id)).data ?? []).length;
    if (aD > 0 && aB > 0 && aM > 0 && aP > 0 && aProf > 0)
      ok(`admin reads the foreign bundle (disputes=${aD}, booking=${aB}, messages=${aM}, paytx=${aP}, profile=${aProf})`);
    else no(`admin could not read the full foreign bundle: disputes=${aD}, booking=${aB}, messages=${aM}, paytx=${aP}, profile=${aProf}`);

    // non-admin non-party sees NOTHING
    const nD = await seenBy(test2Client, 'disputes', bkF);
    const nM = await seenBy(test2Client, 'messages', bkF);
    const nE = await seenBy(test2Client, 'booking_events', bkF);
    const nP = await seenBy(test2Client, 'payment_transactions', bkF);
    const nB = ((await test2Client.from('bookings').select('id').eq('id', bkF)).data ?? []).length;
    if (nD === 0 && nB === 0 && nM === 0 && nE === 0 && nP === 0)
      ok('a non-admin non-party reads ZERO rows of the foreign booking (disputes/booking/messages/events/paytx)');
    else no(`non-admin leaked foreign data: disputes=${nD}, booking=${nB}, messages=${nM}, events=${nE}, paytx=${nP}`);
  }

  // ================= (j) dispute_fault_rate is server-only =================
  console.log('\n[j) dispute_fault_rate is server-only (no client execute)]');
  {
    const r1 = await test2Client.rpc('dispute_fault_rate', { p_subject_type: 'customer', p_subject_id: test2Id });
    if (isDenied(r1.error)) ok('authenticated cannot execute dispute_fault_rate: ' + errMsg(r1.error));
    else no('authenticated executed dispute_fault_rate (should be denied): ' + JSON.stringify(r1.error ?? r1.data));
    const r2 = await anon.rpc('dispute_fault_rate', { p_subject_type: 'customer', p_subject_id: test2Id });
    if (isDenied(r2.error)) ok('anon cannot execute dispute_fault_rate');
    else no('anon executed dispute_fault_rate (should be denied): ' + JSON.stringify(r2.error ?? r2.data));
  }

} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
}

// ================= cleanup =================
console.log('\n[cleanup]');
{
  for (const id of bookingIds) await service.from('notifications').delete().like('link', `/bookings/${id}%`);
  if (bookingIds.length) {
    await service.from('wallet_transactions').delete().in('reference_id', bookingIds);
    await service.from('bookings').delete().in('id', bookingIds); // cascades disputes, payment_transactions, messages, events
  }
  if (spIds.length) {
    await service.from('reputation_snapshots').delete().in('subject_id', spIds);
    await service.from('service_providers').delete().in('id', spIds);
  }
  // remove only the customer snapshots this run created, then restore wallet + reputation
  for (const uid of [test1Id, test2Id]) {
    await service.from('reputation_snapshots').delete().eq('subject_type', 'customer').eq('subject_id', uid).gte('computed_at', runStart);
  }
  await service.from('profiles').update({ wallet_balance: w1_0, reputation_score: rep1_0 }).eq('id', test1Id);
  await service.from('profiles').update({ wallet_balance: w2_0, reputation_score: rep2_0 }).eq('id', test2Id);
  console.log(`  cleaned up ${bookingIds.length} bookings (+cascaded disputes/paytx/messages/events), ${spIds.length} providers, snapshots + wallet txns; wallet/reputation restored (test1 ₹${w1_0}/${rep1_0}, test2 ₹${w2_0}/${rep2_0}).`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
