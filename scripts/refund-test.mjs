/*
  Manually exercises POST /api/payments/refund against the running Next.js app.

  It signs in as the customer, POSTs { bookingId } with the customer's Supabase access token as a
  Bearer header (the auth model in lib/api-auth.ts), prints the HTTP status + JSON response, then
  reads back the booking's payment_status and the payment_transactions status(es) for that booking
  using the service-role key.

  This does NOT simulate Razorpay — a fresh refund on a 'held' booking will hit the real refund
  path in the route, so point it at a booking whose escrow you actually want returned (or one that
  is already 'refunded' to exercise the idempotent no-op).

  Usage (from repo root, with the dev server running):
    BOOKING_ID=<uuid> \
    CUSTOMER_EMAIL=test1@gmail.com CUSTOMER_PASSWORD=test1@9271 \
    node scripts/refund-test.mjs
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
const REFUND_URL = env.REFUND_URL || process.env.REFUND_URL || 'http://localhost:3000/api/payments/refund';

const bookingId = process.env.BOOKING_ID;
const email = process.env.CUSTOMER_EMAIL;
const password = process.env.CUSTOMER_PASSWORD;

if (!bookingId) {
  console.log('Cannot run: set BOOKING_ID=<uuid>.');
  process.exit(1);
}
if (!email || !password) {
  console.log('Cannot run: set CUSTOMER_EMAIL and CUSTOMER_PASSWORD (the booking\'s customer).');
  process.exit(1);
}
if (!SERVICE) {
  console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY is not in .env.local (needed to read back state).');
  process.exit(1);
}

const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

// ---- sign in as the customer and grab the access token to send as Bearer ----
const customer = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: signIn, error: signInErr } = await customer.auth.signInWithPassword({ email, password });
if (signInErr || !signIn?.session?.access_token) {
  console.log('Cannot run: customer sign-in failed:', signInErr?.message ?? 'no session returned');
  process.exit(1);
}
const accessToken = signIn.session.access_token;
console.log('Refund URL :', REFUND_URL);
console.log('Customer   :', signIn.user.id, `(${email})`);
console.log('Booking    :', bookingId, '\n');

// ---- POST the refund ----
let res, json = null;
try {
  res = await fetch(REFUND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ bookingId }),
  });
} catch (e) {
  console.log(`Cannot reach the refund route at ${REFUND_URL} (${e.message}). Start the app (npm run dev) and retry.`);
  process.exit(1);
}
try { json = await res.json(); } catch { /* non-JSON body */ }
console.log(`HTTP ${res.status}`);
console.log('Response:', JSON.stringify(json, null, 2));

// ---- read back the resulting state via the service-role key ----
const { data: booking } = await service
  .from('bookings').select('payment_status').eq('id', bookingId).maybeSingle();
console.log('\nbookings.payment_status:', booking?.payment_status ?? '(booking not found)');

const { data: txs } = await service
  .from('payment_transactions')
  .select('id, status, amount, razorpay_payment_id')
  .eq('booking_id', bookingId);
if (!txs || txs.length === 0) {
  console.log('payment_transactions   : (none for this booking)');
} else {
  for (const t of txs) {
    console.log(
      `payment_transactions[${t.id.slice(0, 8)}]: status=${t.status}` +
      ` amount=${t.amount} razorpay_payment_id=${t.razorpay_payment_id ?? 'null'}`,
    );
  }
}
