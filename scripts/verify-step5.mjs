/*
  Verifies Step-5 payments/escrow against the LIVE Supabase DB + the running Next.js webhook.
  Run it AFTER:
    - applying all Step 1–4 migrations and 20260718120000_seva_payments_escrow.sql (supabase db push)
    - setting SUPABASE_SERVICE_ROLE_KEY and RAZORPAY_WEBHOOK_SECRET in .env.local
    - starting the app so the webhook route is reachable:  npm run dev   (or npm start)

  Everything is Razorpay TEST-mode simulation: instead of hitting Razorpay's API, we seed the
  payment_transactions ledger row that /api/payments/create-order would have written (using the
  service-role key), then POST a correctly-signed synthetic `payment.captured` to the webhook —
  exactly the "simulate capture" path the Step-5 spec recommends for automated testing.

  What it checks (the Step-5 "Done when"):
    (a) as customer+provider, create a booking (payment_method='upi' → escrow) and accept it
    (b) a BAD webhook signature is rejected (400); a correctly-signed payment.captured sets
        payment_status='held' exactly once (a second identical POST is idempotent — still 'held',
        ledger stays 'captured'); the webhook notifies the PROVIDER "Payment received" (and NOT
        the customer)
    (c) a client canNOT set payment_status directly, and transition_booking(...,'paid') is illegal
    (d) on customer Confirm done of a held booking: provider wallet_balance += price_charged×0.85,
        a wallet_transactions credit row exists, payment_status='released', booking reaches 'paid'
        via a 'system' booking_event; and money notifications are addressed explicitly — provider
        gets "Payout received", customer gets a "Payment complete" receipt, and the customer is
        NEVER mis-served "Payment received"
    (e) credit_wallet is NOT executable by authenticated

  Usage (from repo root, with the dev server running):
    CUSTOMER_EMAIL=test1@gmail.com CUSTOMER_PASSWORD=test1@9271 \
    PROVIDER_EMAIL=test2@gmail.com PROVIDER_PASSWORD=test2@9271 \
    node scripts/verify-step5.mjs

  Needs TWO distinct email-confirmed users (customer + provider), like verify-step4.mjs.
*/
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_SECRET = env.RAZORPAY_WEBHOOK_SECRET;
const WEBHOOK_URL = env.WEBHOOK_URL || process.env.WEBHOOK_URL || 'http://localhost:3000/api/payments/webhook';

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };

console.log('DB:', URL, '\nWebhook:', WEBHOOK_URL, '\n');

if (!SERVICE) {
  console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY is not in .env.local (needed to seed the ledger + assert).');
  process.exit(0);
}
if (!WEBHOOK_SECRET) {
  console.log('Cannot run: RAZORPAY_WEBHOOK_SECRET is not in .env.local (needed to sign the synthetic webhook).');
  process.exit(0);
}

const anon = createClient(URL, ANON);
const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

// ---- helper: authenticated client for a named role (mirrors verify-step4.mjs) ----
async function authClient(prefix) {
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = process.env[`${prefix}_EMAIL`];
  const password = process.env[`${prefix}_PASSWORD`];
  if (!email) return { client, userId: null };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) { console.log(`${prefix} signIn error:`, error.message); return { client, userId: null }; }
  return { client, userId: data?.user?.id ?? null };
}

// ---- helper: POST a webhook body with a given signature; returns { status, json } ----
async function postWebhook(rawBody, signature) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature },
    body: rawBody,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}
const sign = (rawBody) => createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

// ---- helper: notifications addressed to a user for the CURRENT booking ----
// Money + status notifications link to /bookings/<id> (chat adds ?tab=chat), so a link prefix
// match scopes to this booking; callers filter by title. bookingId is set below before use.
async function notifsFor(userId) {
  const { data } = await service.from('notifications')
    .select('title, message, type, link')
    .eq('user_id', userId)
    .like('link', `/bookings/${bookingId}%`);
  return data ?? [];
}
const byTitle = (rows, title) => rows.filter((r) => r.title === title);

// ---- sessions ----
console.log('[sessions]');
const { client: customerClient, userId: customerId } = await authClient('CUSTOMER');
const { client: providerClient, userId: providerId } = await authClient('PROVIDER');
console.log('  customer:', customerId ?? 'NONE', '| provider:', providerId ?? 'NONE', '\n');
if (!customerId || !providerId || customerId === providerId) {
  console.log('Cannot run: need TWO distinct customer + provider sessions (set CUSTOMER_* and PROVIDER_*).');
  process.exit(0);
}

// Make sure the webhook is actually reachable before we assert on it.
try {
  const ping = await postWebhook('{}', 'deadbeef'); // bad sig on purpose → expect 400
  if (ping.status !== 400) {
    console.log(`Webhook reachable but returned ${ping.status} to a bad-signature probe (expected 400). Continuing.`);
  }
} catch (e) {
  console.log(`Cannot reach the webhook at ${WEBHOOK_URL} (${e.message}). Start the app (npm run dev) and retry.`);
  process.exit(0);
}

let providerRowId = null, bookingId = null;
const AMOUNT_RUPEES = 600;
const AMOUNT_PAISE = AMOUNT_RUPEES * 100;
const FEE = Math.round(AMOUNT_RUPEES * 0.15 * 100) / 100;   // 90
const PAYOUT = AMOUNT_RUPEES - FEE;                          // 510

// ================= (a) create + accept a booking =================
console.log('[a) setup: create + accept an escrow booking]');
{
  const { data: cat } = await anon.from('service_categories').select('id').limit(1).maybeSingle();
  const categoryId = cat?.id ?? null;

  const { data: prov, error: provErr } = await providerClient.from('service_providers').insert({
    user_id: providerId, category_id: categoryId, business_name: 'Verify Step5 Provider',
    bio: 'escrow test', hourly_rate: 300, city: 'Mumbai', state: 'MH',
  }).select('id').maybeSingle();
  if (provErr || !prov) { no('create provider profile: ' + (provErr?.message ?? 'no row')); }
  else { providerRowId = prov.id; ok('provider profile created (' + providerRowId.slice(0, 8) + ')'); }

  if (providerRowId) {
    const { data: bk, error: bkErr } = await customerClient.from('bookings').insert({
      customer_id: customerId, provider_id: providerRowId, category_id: categoryId,
      service_type: 'one-time', scheduled_date: '2026-09-01', scheduled_time: '11:00',
      duration_hours: 2, hourly_rate: 300, total_amount: AMOUNT_RUPEES, payment_method: 'upi',
    }).select('id, price_agreed, payment_status, status').maybeSingle();
    if (bkErr || !bk) { no('create booking: ' + (bkErr?.message ?? 'no row')); }
    else {
      bookingId = bk.id;
      ok(`booking created (${bookingId.slice(0, 8)}) — price_agreed=${bk.price_agreed}, payment_status=${bk.payment_status}`);
    }
  }

  if (bookingId) {
    const { error: accErr } = await providerClient.rpc('transition_booking', {
      p_booking_id: bookingId, p_next_status: 'accepted',
    });
    if (accErr) no('provider accept failed: ' + accErr.message);
    else ok('provider accepted (requested → accepted)');
  }
}

if (!bookingId) {
  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(1);
}

// ================= (b) webhook: bad sig rejected, valid capture → held (idempotent) =================
console.log('\n[b) webhook is the only path to held; signature-verified + idempotent]');
{
  // Seed the ledger row that create-order would have written (server-only insert via service role).
  const orderId = 'order_verify_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const paymentId = 'pay_verify_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const { error: seedErr } = await service.from('payment_transactions').insert({
    booking_id: bookingId, razorpay_order_id: orderId, amount: AMOUNT_PAISE, currency: 'INR', status: 'created',
  });
  if (seedErr) { no('seed payment_transactions (created): ' + seedErr.message); }
  else { ok('seeded ledger order ' + orderId.slice(0, 18) + '… (status=created, ' + AMOUNT_PAISE + ' paise)'); }

  const payload = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: AMOUNT_PAISE, status: 'captured' } } },
  });

  // Bad signature → 400, and NOTHING marked held.
  const bad = await postWebhook(payload, sign(payload) + 'tampered');
  if (bad.status === 400) ok('bad signature rejected (400)');
  else no('bad signature NOT rejected (got ' + bad.status + ')');

  // Correctly-signed capture → 200 + booking held.
  const good = await postWebhook(payload, sign(payload));
  if (good.status === 200 && good.json?.held) ok('valid payment.captured accepted (200, held)');
  else no('valid capture not accepted as held (status ' + good.status + ', json ' + JSON.stringify(good.json) + ')');

  const { data: afterHeld } = await service.from('bookings').select('payment_status').eq('id', bookingId).maybeSingle();
  if (afterHeld?.payment_status === 'held') ok('booking.payment_status = held after capture');
  else no('booking.payment_status is ' + (afterHeld?.payment_status ?? 'null') + ' (expected held)');

  // Idempotency: a second identical POST changes nothing.
  const again = await postWebhook(payload, sign(payload));
  if (again.status === 200 && again.json?.idempotent) ok('second identical capture is idempotent (200, idempotent)');
  else if (again.status === 200) ok('second identical capture returned 200 (no double-apply)');
  else no('second capture returned ' + again.status + ' (expected idempotent 200)');

  const { data: txRows } = await service.from('payment_transactions')
    .select('status').eq('booking_id', bookingId);
  const captured = (txRows ?? []).filter((r) => r.status === 'captured').length;
  if (captured === 1) ok('exactly one ledger row is captured (no duplicate settlement)');
  else no('captured ledger rows = ' + captured + ' (expected 1)');

  // The webhook must notify the PROVIDER (and only the provider) that funds are secured. The
  // insert is awaited before the webhook returns 200, so it is committed by now — live via the
  // realtime bell in the app.
  const provHeld = byTitle(await notifsFor(providerId), 'Payment received');
  if (provHeld.length === 1 && /secured/i.test(provHeld[0].message)) {
    ok('provider got "Payment received" on held: ' + JSON.stringify(provHeld[0].message));
  } else {
    no('provider "Payment received" (held) notification not as expected: ' + JSON.stringify(provHeld));
  }
  const custHeld = byTitle(await notifsFor(customerId), 'Payment received');
  if (custHeld.length === 0) ok('customer did NOT get "Payment received" on held (correct recipient)');
  else no('customer WRONGLY got "Payment received" on held: ' + JSON.stringify(custHeld));
}

// ================= (c) no client can set held or reach paid =================
console.log('\n[c) client cannot write money state]');
{
  // Direct column write to payment_status is denied (only descriptive columns are grantable).
  const { error: updErr } = await customerClient.from('bookings')
    .update({ payment_status: 'released' }).eq('id', bookingId).select('id');
  const { data: stillHeld } = await service.from('bookings').select('payment_status').eq('id', bookingId).maybeSingle();
  if (updErr && stillHeld?.payment_status === 'held') ok('direct client update of payment_status denied: ' + updErr.message);
  else if (stillHeld?.payment_status === 'held') ok('direct client update of payment_status had no effect (still held)');
  else no('direct client update of payment_status CHANGED it to ' + stillHeld?.payment_status);

  // transition_booking(..., 'paid') is illegal — 'paid' is system-only now.
  const { error: paidErr } = await customerClient.rpc('transition_booking', {
    p_booking_id: bookingId, p_next_status: 'paid',
  });
  if (paidErr) ok("transition_booking(...,'paid') rejected: " + paidErr.message);
  else no("transition_booking(...,'paid') was ALLOWED from a client (should be illegal)");
}

// ================= (d) customer confirm → payout + released + paid(system) =================
console.log('\n[d) confirm releases escrow: wallet payout + released + paid(system)]');
{
  // Provider drives the job to 'completed' (payment_status stays 'held' throughout).
  let okChain = true;
  for (const next of ['en_route', 'arrived', 'in_progress', 'completed']) {
    const { error } = await providerClient.rpc('transition_booking', { p_booking_id: bookingId, p_next_status: next });
    if (error) { okChain = false; no(`provider → ${next} failed: ${error.message}`); break; }
  }
  if (okChain) ok('provider drove accepted → … → completed (payment stays held)');

  const { data: provBefore } = await service.from('profiles').select('wallet_balance').eq('id', providerId).maybeSingle();
  const before = Number(provBefore?.wallet_balance ?? 0);

  // Customer confirms — fires release_escrow_on_confirm.
  const { error: confErr } = await customerClient.rpc('transition_booking', {
    p_booking_id: bookingId, p_next_status: 'confirmed',
  });
  if (confErr) no('customer confirm failed: ' + confErr.message);
  else ok('customer confirmed (completed → confirmed)');

  const { data: bkAfter } = await service.from('bookings')
    .select('status, payment_status, price_charged').eq('id', bookingId).maybeSingle();
  if (bkAfter?.payment_status === 'released') ok('payment_status = released');
  else no('payment_status is ' + (bkAfter?.payment_status ?? 'null') + ' (expected released)');
  if (bkAfter?.status === 'paid') ok('booking reached status = paid');
  else no('booking status is ' + (bkAfter?.status ?? 'null') + ' (expected paid)');

  const { data: provAfter } = await service.from('profiles').select('wallet_balance').eq('id', providerId).maybeSingle();
  const after = Number(provAfter?.wallet_balance ?? 0);
  const delta = Math.round((after - before) * 100) / 100;
  if (delta === PAYOUT) ok(`provider wallet credited +₹${PAYOUT} (price_charged ₹${bkAfter?.price_charged} × 0.85)`);
  else no(`provider wallet delta = ₹${delta} (expected +₹${PAYOUT})`);

  const { data: credits } = await service.from('wallet_transactions')
    .select('amount, type').eq('reference_id', bookingId).eq('user_id', providerId).eq('type', 'credit');
  if ((credits ?? []).length === 1 && Number(credits[0].amount) === PAYOUT) {
    ok(`wallet_transactions has one credit row of ₹${PAYOUT} for this booking`);
  } else {
    no('wallet_transactions credit row not as expected: ' + JSON.stringify(credits));
  }

  const { data: paidEvent } = await service.from('booking_events')
    .select('actor_role, actor_id').eq('booking_id', bookingId).eq('to_status', 'paid').maybeSingle();
  if (paidEvent?.actor_role === 'system' && !paidEvent?.actor_id) ok("'paid' booking_event was emitted by the system (actor_role=system, no actor_id)");
  else no("'paid' event actor is " + JSON.stringify(paidEvent) + ' (expected system/no actor)');

  // Money notifications on release are addressed EXPLICITLY, never via the generic other-party
  // path: provider → payout credited; customer → payment-complete receipt. And the customer must
  // NEVER receive "Payment received" (the mis-addressing this migration fixes).
  const provNotifs = await notifsFor(providerId);
  const payout = byTitle(provNotifs, 'Payout received');
  if (payout.length === 1 && payout[0].message.includes(String(PAYOUT)) && /wallet/i.test(payout[0].message)) {
    ok('provider got "Payout received" ₹' + PAYOUT + ': ' + JSON.stringify(payout[0].message));
  } else {
    no('provider "Payout received" notification not as expected: ' + JSON.stringify(payout));
  }
  if (byTitle(provNotifs, 'Payment complete').length === 0) ok('provider did NOT get the customer receipt');
  else no('provider WRONGLY got "Payment complete": ' + JSON.stringify(byTitle(provNotifs, 'Payment complete')));

  const custNotifs = await notifsFor(customerId);
  const receipt = byTitle(custNotifs, 'Payment complete');
  if (receipt.length === 1 && receipt[0].message.includes(String(AMOUNT_RUPEES)) && /complete/i.test(receipt[0].message)) {
    ok('customer got "Payment complete" receipt: ' + JSON.stringify(receipt[0].message));
  } else {
    no('customer "Payment complete" receipt not as expected: ' + JSON.stringify(receipt));
  }
  const custWrong = byTitle(custNotifs, 'Payment received');
  if (custWrong.length === 0) ok('customer did NOT get "Payment received" on release (bug fixed)');
  else no('REGRESSION: customer got "Payment received" on release: ' + JSON.stringify(custWrong));
}

// ================= (e) credit_wallet is not authenticated-executable =================
console.log('\n[e) credit_wallet is server-only]');
{
  const { error } = await customerClient.rpc('credit_wallet', {
    p_user_id: customerId, p_amount: 999, p_type: 'credit', p_description: 'hack', p_reference_id: null,
  });
  if (error) ok('credit_wallet not executable by authenticated: ' + error.message);
  else no('credit_wallet WAS executable by an authenticated client (should be denied)');
}

// ================= cleanup =================
console.log('\n[cleanup]');
{
  // Reverse the payout so repeated runs don't accumulate, then remove the booking + provider.
  await service.from('wallet_transactions').delete().eq('reference_id', bookingId);
  const { data: prov } = await service.from('profiles').select('wallet_balance').eq('id', providerId).maybeSingle();
  const bal = Number(prov?.wallet_balance ?? 0);
  await service.from('profiles').update({ wallet_balance: Math.max(0, Math.round((bal - PAYOUT) * 100) / 100) }).eq('id', providerId);
  await service.from('notifications').delete().like('link', `/bookings/${bookingId}%`); // FK is to users, not bookings
  await service.from('bookings').delete().eq('id', bookingId);           // cascades events + payment_transactions
  if (providerRowId) await providerClient.from('service_providers').delete().eq('id', providerRowId);
  console.log('  cleaned up booking, ledger, payout credit, notifications, and provider profile.');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
