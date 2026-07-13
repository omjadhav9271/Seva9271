/*
  Verifies the Step-2 Booking state machine against the LIVE Supabase DB using only the
  public anon key (exactly what a browser client can do). Run it AFTER applying:
    - all Step 1 migrations
    - 20260711120000_seva_booking_state_machine.sql

  What it does (end to end, via the transition_booking RPC only):
    - creates a provider profile (as the provider user) and a booking (as the customer user)
    - walks requested → accepted → en_route → arrived → in_progress → completed → confirmed → paid,
      with the PROVIDER driving up to `completed` and the CUSTOMER doing `confirmed`/`paid`
    - asserts exactly one booking_events row per transition (from/to/actor_role)
    - asserts price_charged is set (from price_agreed) on customer-confirm
    - asserts the negatives: a direct bookings.update({status}), an illegal jump, a wrong-role
      call, and a stranger's call are ALL rejected

  Usage (from repo root):
    node scripts/verify-step2.mjs

  This needs THREE distinct authenticated users: a customer, a provider, and (for the stranger
  check) a third party. When "Confirm email" is OFF, throwaway signups return sessions and the
  script self-provisions all three. When it's ON, pass pre-confirmed accounts:
    CUSTOMER_EMAIL=a@x.com CUSTOMER_PASSWORD=... \
    PROVIDER_EMAIL=b@x.com PROVIDER_PASSWORD=... \
    STRANGER_EMAIL=c@x.com STRANGER_PASSWORD=... node scripts/verify-step2.mjs
*/
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };

const anon = createClient(URL, KEY);
console.log('DB:', URL, '\n');

// ---- helper: get an authenticated client for a named role ----
async function authClient(prefix) {
  const client = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const envEmail = process.env[`${prefix}_EMAIL`];
  const envPass = process.env[`${prefix}_PASSWORD`];
  if (envEmail) {
    const { data, error } = await client.auth.signInWithPassword({ email: envEmail, password: envPass });
    if (error) { console.log(`${prefix} signIn error:`, error.message); return { client, userId: null }; }
    return { client, userId: data?.user?.id ?? null };
  }
  const email = `verify-${prefix.toLowerCase()}+${Date.now()}-${Math.floor(Math.random() * 1e4)}@seva.test`;
  const password = randomUUID();
  const { data, error } = await client.auth.signUp({ email, password, options: { data: { full_name: `Verify ${prefix}` } } });
  if (error) { console.log(`${prefix} signUp error:`, error.message); return { client, userId: null }; }
  const userId = data?.session ? data.user.id : null;
  if (!data?.session && data?.user) {
    console.log(`(${prefix} signup created a user but returned no session — email-confirmation is likely ON; pass ${prefix}_EMAIL/${prefix}_PASSWORD)`);
  }
  return { client, userId };
}

// ---- helper: read the event log for a booking (either party may SELECT it) ----
async function events(client, bookingId) {
  const { data, error } = await client
    .from('booking_events')
    .select('from_status, to_status, actor_role, created_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true });
  return { rows: data ?? [], error };
}

// ---- establish the three sessions ----
console.log('[sessions]');
const { client: customerClient, userId: customerId } = await authClient('CUSTOMER');
const { client: providerClient, userId: providerId } = await authClient('PROVIDER');
const { client: strangerClient, userId: strangerId } = await authClient('STRANGER');
console.log('  customer:', customerId ?? 'NONE', '| provider:', providerId ?? 'NONE', '| stranger:', strangerId ?? 'NONE', '\n');

if (!customerId || !providerId) {
  console.log('Cannot run: need BOTH a customer and a provider session. Set CUSTOMER_* and PROVIDER_* envs (or enable session-returning signups).');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(0);
}
if (customerId === providerId) {
  console.log('Cannot run: customer and provider must be DIFFERENT users (the RPC classifies a self-booking caller as the customer).');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(0);
}

// ---- provision: a provider profile (as provider) + a booking (as customer) ----
let providerRowId = null;
let bookingId = null;
let bk2Id = null;
let agreedPrice = 600;

console.log('[setup]');
{
  const { data: cat } = await anon.from('service_categories').select('id').limit(1).maybeSingle();
  const categoryId = cat?.id ?? null;

  const { data: prov, error: provErr } = await providerClient.from('service_providers').insert({
    user_id: providerId, category_id: categoryId, business_name: 'Verify Step2 Provider',
    bio: 'state-machine test', hourly_rate: 300, city: 'Mumbai', state: 'MH',
  }).select('id').maybeSingle();
  if (provErr || !prov) { no('create provider profile: ' + (provErr?.message ?? 'no row')); }
  else { providerRowId = prov.id; ok('provider profile created (' + providerRowId.slice(0, 8) + ')'); }

  if (providerRowId) {
    const { data: bk, error: bkErr } = await customerClient.from('bookings').insert({
      customer_id: customerId, provider_id: providerRowId, category_id: categoryId,
      service_type: 'one-time', scheduled_date: '2026-08-01', scheduled_time: '11:00',
      duration_hours: 2, hourly_rate: 300, total_amount: 600, payment_method: 'cod',
    }).select('id, status, price_agreed').maybeSingle();
    if (bkErr || !bk) { no('create booking: ' + (bkErr?.message ?? 'no row')); }
    else {
      bookingId = bk.id;
      agreedPrice = Number(bk.price_agreed ?? 600);
      if (bk.status === 'requested') ok('booking created with default status=requested');
      else no(`booking default status is '${bk.status}', expected 'requested'`);
      if (bk.price_agreed != null && Number(bk.price_agreed) === 600) ok(`price_agreed set by trigger: ₹${bk.price_agreed}`);
      else no(`price_agreed not set by trigger (got ${bk.price_agreed})`);
    }
  }
}

// ---- walk the happy path, asserting one event per transition ----
if (bookingId) {
  console.log('\n[happy path — only via transition_booking]');
  const steps = [
    { who: 'provider', next: 'accepted' },
    { who: 'provider', next: 'en_route' },
    { who: 'provider', next: 'arrived' },
    { who: 'provider', next: 'in_progress' },
    { who: 'provider', next: 'completed' },
    { who: 'customer', next: 'confirmed' },
    { who: 'customer', next: 'paid' },
  ];

  // baseline: no events yet
  {
    const { rows } = await events(customerClient, bookingId);
    if (rows.length === 0) ok('no booking_events before any transition');
    else no(`expected 0 events at start, found ${rows.length}`);
  }

  let prev = 'requested';
  let n = 0;
  for (const step of steps) {
    n++;
    const client = step.who === 'provider' ? providerClient : customerClient;
    const { data, error } = await client.rpc('transition_booking', { p_booking_id: bookingId, p_next_status: step.next });
    if (error) { no(`transition ${prev} → ${step.next} by ${step.who}: ${error.message}`); break; }
    if (data?.status !== step.next) { no(`transition ${prev} → ${step.next}: row status came back '${data?.status}'`); break; }
    ok(`transition ${prev} → ${step.next} by ${step.who}`);

    // price_charged must be set from price_agreed on customer-confirm
    if (step.next === 'confirmed') {
      if (data.price_charged != null && Number(data.price_charged) === agreedPrice) ok(`price_charged set on confirm: ₹${data.price_charged} (== price_agreed)`);
      else no(`price_charged wrong on confirm: charged=${data?.price_charged}, agreed=${agreedPrice}`);
    }
    if (step.next === 'paid' && data.payment_status === 'paid') ok('payment_status flipped to paid');

    // exactly one new event, matching from/to/actor_role
    const { rows, error: evErr } = await events(customerClient, bookingId);
    if (evErr) { no(`read booking_events after ${step.next}: ${evErr.message}`); }
    else {
      const match = rows.find((r) => r.from_status === prev && r.to_status === step.next && r.actor_role === step.who);
      if (rows.length === n && match) ok(`booking_events row ${prev} → ${step.next} (actor_role=${step.who}); total=${rows.length}`);
      else if (match) no(`event present but count off: expected ${n}, got ${rows.length}`);
      else no(`no matching event row for ${prev} → ${step.next} by ${step.who} (${rows.length} rows total)`);
    }
    prev = step.next;
  }
  if (prev === 'paid') ok('reached terminal state paid via 7 RPC transitions');
}

// ---- negative: a direct status write from the browser must be denied ----
if (bookingId) {
  console.log('\n[locked down: no direct status writes]');
  const { error } = await customerClient.from('bookings').update({ status: 'requested' }).eq('id', bookingId);
  const { data: after } = await customerClient.from('bookings').select('status').eq('id', bookingId).maybeSingle();
  if (error && after?.status === 'paid') ok('direct bookings.update({status}) denied (column grant): ' + error.message);
  else if (!error && after?.status === 'paid') ok('direct bookings.update({status}) had no effect (status still paid)');
  else no(`direct status update was accepted! status is now '${after?.status}'`);
}

// ---- negatives on a fresh booking: illegal jump, wrong role, stranger ----
if (providerRowId) {
  console.log('\n[rejections: illegal / wrong-role / stranger]');
  const { data: bk2 } = await customerClient.from('bookings').insert({
    customer_id: customerId, provider_id: providerRowId, service_type: 'one-time',
    hourly_rate: 300, total_amount: 600, payment_method: 'cod',
  }).select('id').maybeSingle();
  bk2Id = bk2?.id ?? null;

  if (!bk2Id) {
    sk('illegal/wrong-role/stranger checks (could not create a second booking)');
  } else {
    // illegal jump: provider tries requested → completed (skips the lifecycle)
    {
      const { error } = await providerClient.rpc('transition_booking', { p_booking_id: bk2Id, p_next_status: 'completed' });
      if (error) ok('illegal jump requested → completed rejected: ' + error.message);
      else no('illegal jump requested → completed was ACCEPTED');
    }
    // wrong role: customer tries to accept (only a provider may)
    {
      const { error } = await customerClient.rpc('transition_booking', { p_booking_id: bk2Id, p_next_status: 'accepted' });
      if (error) ok('wrong-role customer→accept rejected: ' + error.message);
      else no('wrong-role customer→accept was ACCEPTED');
    }
    // stranger: a third party who is neither customer nor provider
    if (strangerId && strangerId !== customerId && strangerId !== providerId) {
      const { error } = await strangerClient.rpc('transition_booking', { p_booking_id: bk2Id, p_next_status: 'accepted' });
      if (error) ok('stranger RPC call rejected: ' + error.message);
      else no('stranger RPC call was ACCEPTED');
    } else {
      sk('stranger rejection (no distinct stranger session — set STRANGER_EMAIL/STRANGER_PASSWORD)');
    }
  }
}

// ---- cleanup ----
if (bookingId) await customerClient.from('bookings').delete().eq('id', bookingId);
if (bk2Id) await customerClient.from('bookings').delete().eq('id', bk2Id);
if (providerRowId) await providerClient.from('service_providers').delete().eq('id', providerRowId);

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
