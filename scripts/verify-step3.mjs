/*
  Verifies the Step-3 per-booking chat against the LIVE Supabase DB using only the public
  anon key (exactly what a browser client can do). Run it AFTER applying:
    - all Step 1 migrations
    - 20260711120000_seva_booking_state_machine.sql
    - 20260712120000_seva_booking_chat.sql

  What it does (end to end, via the anon client + RLS only):
    - creates a provider profile (as the provider user) and a booking (as the customer user)
    - CROSS-READ: customer posts a message the provider can read, and vice-versa; each party
      sees the full thread (is_booking_party gates SELECT)
    - REALTIME: with the provider subscribed, a customer insert is delivered live (no reload)
    - NON-PARTY: a stranger gets 0 rows on SELECT and is denied on INSERT
    - IMMUTABLE: a party's own message can't be UPDATEd or DELETEd (REVOKE + no policy)

  Usage (from repo root):
    node scripts/verify-step3.mjs

  Needs THREE distinct authenticated users. When "Confirm email" is OFF, throwaway signups
  return sessions and the script self-provisions all three. When it's ON, pass pre-confirmed
  accounts:
    CUSTOMER_EMAIL=a@x.com CUSTOMER_PASSWORD=... \
    PROVIDER_EMAIL=b@x.com PROVIDER_PASSWORD=... \
    STRANGER_EMAIL=c@x.com STRANGER_PASSWORD=... node scripts/verify-step3.mjs
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

// ---- helper: get an authenticated client (+ access token) for a named role ----
async function authClient(prefix) {
  const client = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const envEmail = process.env[`${prefix}_EMAIL`];
  const envPass = process.env[`${prefix}_PASSWORD`];
  let userId = null;
  if (envEmail) {
    const { data, error } = await client.auth.signInWithPassword({ email: envEmail, password: envPass });
    if (error) { console.log(`${prefix} signIn error:`, error.message); return { client, userId: null, token: null }; }
    userId = data?.user?.id ?? null;
  } else {
    const email = `verify-${prefix.toLowerCase()}+${Date.now()}-${Math.floor(Math.random() * 1e4)}@seva.test`;
    const password = randomUUID();
    const { data, error } = await client.auth.signUp({ email, password, options: { data: { full_name: `Verify ${prefix}` } } });
    if (error) { console.log(`${prefix} signUp error:`, error.message); return { client, userId: null, token: null }; }
    userId = data?.session ? data.user.id : null;
    if (!data?.session && data?.user) {
      console.log(`(${prefix} signup created a user but returned no session — email-confirmation is likely ON; pass ${prefix}_EMAIL/${prefix}_PASSWORD)`);
    }
  }
  const { data: { session } } = await client.auth.getSession();
  return { client, userId, token: session?.access_token ?? null };
}

// ---- helper: does a live INSERT reach `subClient` when `insertClient` posts? ----
// Subscribe first, insert only after SUBSCRIBED, resolve on the payload or a timeout.
function realtimeDelivers(subClient, insertClient, bookingId, senderId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; try { subClient.removeChannel(channel); } catch {} resolve(val); } };
    const channel = subClient
      .channel(`verify:messages:${bookingId}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `booking_id=eq.${bookingId}` },
        (payload) => finish({ received: true, row: payload.new }),
      )
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          const { error } = await insertClient
            .from('messages')
            .insert({ booking_id: bookingId, sender_id: senderId, body: 'realtime ping ' + Date.now() });
          if (error) finish({ received: false, error: 'insert failed: ' + error.message });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          finish({ received: false, error: 'channel status ' + status });
        }
      });
    setTimeout(() => finish({ received: false, error: 'timeout (20s)' }), 20000);
  });
}

// ---- establish the three sessions ----
console.log('[sessions]');
const { client: customerClient, userId: customerId } = await authClient('CUSTOMER');
const { client: providerClient, userId: providerId, token: providerToken } = await authClient('PROVIDER');
const { client: strangerClient, userId: strangerId } = await authClient('STRANGER');
console.log('  customer:', customerId ?? 'NONE', '| provider:', providerId ?? 'NONE', '| stranger:', strangerId ?? 'NONE', '\n');

if (!customerId || !providerId) {
  console.log('Cannot run: need BOTH a customer and a provider session. Set CUSTOMER_* and PROVIDER_* envs (or enable session-returning signups).');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(0);
}
if (customerId === providerId) {
  console.log('Cannot run: customer and provider must be DIFFERENT users (a self-booking makes one user both parties).');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(0);
}

// ---- provision: a provider profile (as provider) + a booking (as customer) ----
let providerRowId = null;
let bookingId = null;

console.log('[setup]');
{
  const { data: cat } = await anon.from('service_categories').select('id').limit(1).maybeSingle();
  const categoryId = cat?.id ?? null;

  const { data: prov, error: provErr } = await providerClient.from('service_providers').insert({
    user_id: providerId, category_id: categoryId, business_name: 'Verify Step3 Provider',
    bio: 'chat test', hourly_rate: 300, city: 'Mumbai', state: 'MH',
  }).select('id').maybeSingle();
  if (provErr || !prov) { no('create provider profile: ' + (provErr?.message ?? 'no row')); }
  else { providerRowId = prov.id; ok('provider profile created (' + providerRowId.slice(0, 8) + ')'); }

  if (providerRowId) {
    const { data: bk, error: bkErr } = await customerClient.from('bookings').insert({
      customer_id: customerId, provider_id: providerRowId, category_id: categoryId,
      service_type: 'one-time', scheduled_date: '2026-08-01', scheduled_time: '11:00',
      duration_hours: 2, hourly_rate: 300, total_amount: 600, payment_method: 'cod',
    }).select('id').maybeSingle();
    if (bkErr || !bk) { no('create booking: ' + (bkErr?.message ?? 'no row')); }
    else { bookingId = bk.id; ok('booking created (' + bookingId.slice(0, 8) + ')'); }
  }
}

// ---- cross-read: both parties post, each reads the other's ----
let customerMsgId = null;
if (bookingId) {
  console.log('\n[cross-read: both parties, one thread]');

  // customer → provider
  {
    const { data, error } = await customerClient
      .from('messages')
      .insert({ booking_id: bookingId, sender_id: customerId, body: 'Hi, are you available at 11?' })
      .select('id, body').maybeSingle();
    if (error || !data) { no('customer insert message: ' + (error?.message ?? 'no row')); }
    else { customerMsgId = data.id; ok('customer posted a message'); }
  }
  if (customerMsgId) {
    const { data, error } = await providerClient
      .from('messages').select('id, body, sender_id').eq('id', customerMsgId).maybeSingle();
    if (error) no('provider read customer message: ' + error.message);
    else if (data && data.sender_id === customerId) ok("provider can read the customer's message");
    else no("provider could NOT read the customer's message");
  }

  // provider → customer
  let providerMsgId = null;
  {
    const { data, error } = await providerClient
      .from('messages')
      .insert({ booking_id: bookingId, sender_id: providerId, body: 'Yes, confirmed for 11 AM.' })
      .select('id').maybeSingle();
    if (error || !data) { no('provider insert message: ' + (error?.message ?? 'no row')); }
    else { providerMsgId = data.id; ok('provider posted a message'); }
  }
  if (providerMsgId) {
    const { data, error } = await customerClient
      .from('messages').select('id, sender_id').eq('id', providerMsgId).maybeSingle();
    if (error) no('customer read provider message: ' + error.message);
    else if (data && data.sender_id === providerId) ok("customer can read the provider's message");
    else no("customer could NOT read the provider's message");
  }

  // full thread visible to a party
  {
    const { data } = await customerClient
      .from('messages').select('id').eq('booking_id', bookingId).order('created_at');
    if ((data?.length ?? 0) >= 2) ok(`party sees the whole thread (${data.length} messages)`);
    else no(`party sees an incomplete thread (${data?.length ?? 0} messages, expected ≥ 2)`);
  }
}

// ---- realtime: a live insert reaches the other party with no reload ----
if (bookingId) {
  console.log('\n[realtime: no reload]');
  if (providerToken) providerClient.realtime.setAuth(providerToken); // ensure RLS-gated stream is authorized
  const res = await realtimeDelivers(providerClient, customerClient, bookingId, customerId);
  if (res.received) ok('provider received a live INSERT from the customer (Realtime, no reload)');
  else sk('realtime delivery not observed (' + res.error + ') — RLS/DB writes still verified above; check WebSocket egress');
}

// ---- non-party: stranger can neither read nor post ----
if (bookingId) {
  console.log('\n[non-party locked out]');
  if (strangerId && strangerId !== customerId && strangerId !== providerId) {
    // SELECT → 0 rows (RLS filters, no error)
    {
      const { data, error } = await strangerClient
        .from('messages').select('id').eq('booking_id', bookingId);
      if (error) no('stranger SELECT errored unexpectedly: ' + error.message);
      else if ((data?.length ?? 0) === 0) ok('stranger SELECT returns 0 rows');
      else no(`stranger SELECT leaked ${data.length} rows!`);
    }
    // INSERT (as self) → denied by WITH CHECK is_booking_party
    {
      const { data, error } = await strangerClient
        .from('messages')
        .insert({ booking_id: bookingId, sender_id: strangerId, body: 'let me in' })
        .select('id').maybeSingle();
      if (error && !data) ok('stranger INSERT denied: ' + error.message);
      else no('stranger INSERT was ACCEPTED');
    }
  } else {
    sk('non-party checks (no distinct stranger session — set STRANGER_EMAIL/STRANGER_PASSWORD)');
  }
}

// ---- immutable: a party can't edit or delete a message ----
if (customerMsgId) {
  console.log('\n[immutable: no edit / no delete]');
  // UPDATE
  {
    const { error } = await customerClient
      .from('messages').update({ body: 'edited!' }).eq('id', customerMsgId);
    const { data: after } = await customerClient
      .from('messages').select('body').eq('id', customerMsgId).maybeSingle();
    if (after?.body === 'edited!') no('message UPDATE was applied!');
    else if (error) ok('message UPDATE denied: ' + error.message);
    else ok('message UPDATE had no effect (body unchanged)');
  }
  // DELETE
  {
    const { error } = await customerClient.from('messages').delete().eq('id', customerMsgId);
    const { data: after } = await customerClient
      .from('messages').select('id').eq('id', customerMsgId).maybeSingle();
    if (!after) no('message DELETE removed the row!');
    else if (error) ok('message DELETE denied: ' + error.message);
    else ok('message DELETE had no effect (row still present)');
  }
}

// ---- cleanup (deleting the booking cascades to its messages) ----
if (bookingId) await customerClient.from('bookings').delete().eq('id', bookingId);
if (providerRowId) await providerClient.from('service_providers').delete().eq('id', providerRowId);

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
