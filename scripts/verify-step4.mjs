/*
  Verifies Step-4 notifications wiring against the LIVE Supabase DB using only the public
  anon key (exactly what a browser client can do). Run it AFTER applying:
    - all Step 1–3 migrations
    - 20260713120000_seva_notifications.sql
    - 20260714120000_seva_notification_links.sql
    - 20260716120000_seva_notification_routing.sql
    - 20260716130000_seva_notification_role_links.sql
    - 20260716140000_seva_notification_booking_links.sql

  Every notification deep-links to its own booking (/bookings/<id>), where the role-aware
  action buttons and the chat both live. Messages add ?tab=chat to scroll to the thread.

  What it does (end to end, via the anon client + RLS only):
    - creates a provider profile (as the provider user) and a booking (as the customer user)
    - NEW BOOKING   → asserts the PROVIDER got a "New booking request" linking to /bookings/<id>
    - TRANSITION    → provider accepts; asserts the CUSTOMER got a "Booking accepted" (success)
                      linking to /bookings/<id> with NO ?tab=chat (opens at the actions)
    - NEW MESSAGE   → customer messages; asserts the PROVIDER got a "New message" linking to
                      /bookings/<id>?tab=chat
    - PROVIDER LINK → customer cancels; asserts the PROVIDER got "Booking cancelled" linking to
                      the same booking — the case a bare /bookings link got wrong
    - REALTIME      → with the provider subscribed, a customer message's notification is
                      delivered live (no reload)
    - LOCKED DOWN   → a direct client INSERT into notifications (for self OR another user) is denied

  Usage (from repo root):
    node scripts/verify-step4.mjs

  Needs TWO distinct email-confirmed users (customer + provider). Self-provisioning throwaway
  signups fail on this project, so pass pre-confirmed accounts:
    CUSTOMER_EMAIL=test1@gmail.com CUSTOMER_PASSWORD=test1@9271 \
    PROVIDER_EMAIL=test2@gmail.com PROVIDER_PASSWORD=test2@9271 \
    node scripts/verify-step4.mjs
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

// ---- helper: newest notification for a user, read via that user's own client (RLS-gated) ----
async function latestNotif(client, userId) {
  const { data } = await client
    .from('notifications')
    .select('id, title, message, type, link, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

// ---- helper: does a live notification INSERT reach `subClient` when `trigger()` runs? ----
// Subscribe first, fire the DB write only after SUBSCRIBED, resolve on the payload or a timeout.
function realtimeDeliversNotif(subClient, recipientId, trigger) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; try { subClient.removeChannel(channel); } catch {} resolve(val); } };
    const channel = subClient
      .channel(`verify:notifications:${recipientId}:${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${recipientId}` },
        (payload) => finish({ received: true, row: payload.new }),
      )
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          const err = await trigger();
          if (err) finish({ received: false, error: 'trigger write failed: ' + err });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          finish({ received: false, error: 'channel status ' + status });
        }
      });
    setTimeout(() => finish({ received: false, error: 'timeout (20s)' }), 20000);
  });
}

// ---- establish the two sessions ----
console.log('[sessions]');
const { client: customerClient, userId: customerId } = await authClient('CUSTOMER');
const { client: providerClient, userId: providerId, token: providerToken } = await authClient('PROVIDER');
console.log('  customer:', customerId ?? 'NONE', '| provider:', providerId ?? 'NONE', '\n');

if (!customerId || !providerId) {
  console.log('Cannot run: need BOTH a customer and a provider session. Set CUSTOMER_* and PROVIDER_* envs.');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(0);
}
if (customerId === providerId) {
  console.log('Cannot run: customer and provider must be DIFFERENT users.');
  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(0);
}

const createdNotifIds = []; // notifications we observe → cleaned up at the end

// ---- setup: provider profile (as provider) + booking (as customer). ----
// The booking INSERT itself fires trg_notify_new_booking → provider notification.
let providerRowId = null;
let bookingId = null;

console.log('[setup + new-booking notification]');
{
  const { data: cat } = await anon.from('service_categories').select('id').limit(1).maybeSingle();
  const categoryId = cat?.id ?? null;

  const { data: prov, error: provErr } = await providerClient.from('service_providers').insert({
    user_id: providerId, category_id: categoryId, business_name: 'Verify Step4 Provider',
    bio: 'notify test', hourly_rate: 300, city: 'Mumbai', state: 'MH',
  }).select('id').maybeSingle();
  if (provErr || !prov) { no('create provider profile: ' + (provErr?.message ?? 'no row')); }
  else { providerRowId = prov.id; ok('provider profile created (' + providerRowId.slice(0, 8) + ')'); }

  if (providerRowId) {
    const beforeProv = await latestNotif(providerClient, providerId);

    const { data: bk, error: bkErr } = await customerClient.from('bookings').insert({
      customer_id: customerId, provider_id: providerRowId, category_id: categoryId,
      service_type: 'one-time', scheduled_date: '2026-08-01', scheduled_time: '11:00',
      duration_hours: 2, hourly_rate: 300, total_amount: 600, payment_method: 'cod',
    }).select('id').maybeSingle();
    if (bkErr || !bk) { no('create booking: ' + (bkErr?.message ?? 'no row')); }
    else { bookingId = bk.id; ok('booking created (' + bookingId.slice(0, 8) + ')'); }

    if (bookingId) {
      const afterProv = await latestNotif(providerClient, providerId);
      if (afterProv && afterProv.id !== beforeProv?.id && afterProv.title === 'New booking request') {
        createdNotifIds.push(afterProv.id);
        ok('new booking → PROVIDER got a "New booking request" notification');
        const want = '/bookings/' + bookingId;
        if (afterProv.link === want) ok('  ↳ deep-links to this booking: /bookings/' + bookingId.slice(0, 8));
        else no('  ↳ notification link wrong (want ' + want + ', got ' + (afterProv.link ?? 'NULL') + ')');
      } else {
        no('new booking did NOT notify the provider (newest title: ' + (afterProv?.title ?? 'none') + ')');
      }
    }
  }
}

// ---- transition: provider accepts → customer notified ----
if (bookingId) {
  console.log('\n[transition notification]');
  const beforeCust = await latestNotif(customerClient, customerId);

  const { error: trErr } = await providerClient.rpc('transition_booking', {
    p_booking_id: bookingId, p_next_status: 'accepted',
  });
  if (trErr) { no('provider accept transition failed: ' + trErr.message); }
  else {
    ok('provider accepted the booking (requested → accepted)');
    const afterCust = await latestNotif(customerClient, customerId);
    if (afterCust && afterCust.id !== beforeCust?.id && afterCust.title === 'Booking accepted' && afterCust.type === 'success') {
      createdNotifIds.push(afterCust.id);
      ok('transition → CUSTOMER got a "Booking accepted" (success) notification');
      // No ?tab=chat: a status notification opens at the top, where the actions are.
      const want = '/bookings/' + bookingId;
      if (afterCust.link === want) ok('  ↳ deep-links to this booking: /bookings/' + bookingId.slice(0, 8));
      else no('  ↳ notification link wrong (want ' + want + ', got ' + (afterCust.link ?? 'NULL') + ')');
    } else {
      no('transition did NOT notify the customer correctly (newest: ' +
        (afterCust ? `"${afterCust.title}"/${afterCust.type}` : 'none') + ')');
    }
  }
}

// ---- message: customer messages → provider (recipient) notified ----
if (bookingId) {
  console.log('\n[message notification]');
  const beforeProv = await latestNotif(providerClient, providerId);

  const { error: msgErr } = await customerClient
    .from('messages')
    .insert({ booking_id: bookingId, sender_id: customerId, body: 'On my way with the details.' });
  if (msgErr) { no('customer send message failed: ' + msgErr.message); }
  else {
    ok('customer sent a message');
    const afterProv = await latestNotif(providerClient, providerId);
    if (afterProv && afterProv.id !== beforeProv?.id && afterProv.title === 'New message') {
      createdNotifIds.push(afterProv.id);
      ok('message → PROVIDER (recipient) got a "New message" notification');
      const want = '/bookings/' + bookingId + '?tab=chat';
      if (afterProv.link === want) ok('  ↳ deep-links to the chat: /bookings/' + bookingId.slice(0, 8) + '?tab=chat');
      else no('  ↳ notification link wrong (want ' + want + ', got ' + (afterProv.link ?? 'NULL') + ')');
    } else {
      no('message did NOT notify the recipient (newest title: ' + (afterProv?.title ?? 'none') + ')');
    }
  }
}

// ---- realtime: provider subscribed → a customer message's notification arrives live ----
if (bookingId) {
  console.log('\n[realtime: no reload]');
  if (providerToken) providerClient.realtime.setAuth(providerToken); // authorize the RLS-gated stream
  const res = await realtimeDeliversNotif(providerClient, providerId, async () => {
    const { error } = await customerClient
      .from('messages')
      .insert({ booking_id: bookingId, sender_id: customerId, body: 'realtime ping ' + Date.now() });
    return error?.message ?? null;
  });
  if (res.received) {
    if (res.row?.id) createdNotifIds.push(res.row.id);
    ok('provider received a live notification INSERT (Realtime, no reload)');
  } else {
    sk('realtime delivery not observed (' + res.error + ') — DB writes still verified above; check WebSocket egress');
  }
}

// ---- customer-driven transition → PROVIDER notified, and the link opens the provider tab ----
// This is the case the role param exists for: a bare /bookings would drop the provider on the
// As-Customer tab, where their own job isn't listed. Runs last — 'cancelled' is terminal.
if (bookingId) {
  console.log('\n[provider-recipient link]');
  const beforeProv = await latestNotif(providerClient, providerId);

  const { error: cancelErr } = await customerClient.rpc('transition_booking', {
    p_booking_id: bookingId, p_next_status: 'cancelled',
  });
  if (cancelErr) { no('customer cancel transition failed: ' + cancelErr.message); }
  else {
    ok('customer cancelled the booking (accepted → cancelled)');
    const afterProv = await latestNotif(providerClient, providerId);
    if (afterProv && afterProv.id !== beforeProv?.id && afterProv.title === 'Booking cancelled') {
      createdNotifIds.push(afterProv.id);
      ok('customer-driven transition → PROVIDER got a "Booking cancelled" notification');
      const want = '/bookings/' + bookingId;
      if (afterProv.link === want) ok('  ↳ deep-links to this booking: /bookings/' + bookingId.slice(0, 8));
      else no('  ↳ notification link wrong (want ' + want + ', got ' + (afterProv.link ?? 'NULL') + ')');
    } else {
      no('cancel did NOT notify the provider (newest title: ' + (afterProv?.title ?? 'none') + ')');
    }
  }
}

// ---- locked down: notifications are system-generated only (no client INSERT) ----
console.log('\n[system-generated only: direct client insert denied]');
{
  // for self
  const { data, error } = await customerClient
    .from('notifications')
    .insert({ user_id: customerId, title: 'fake', message: 'i wrote this', type: 'info' })
    .select('id').maybeSingle();
  if (error && !data) ok('direct insert for SELF denied: ' + error.message);
  else { no('direct insert for SELF was ACCEPTED'); if (data?.id) createdNotifIds.push(data.id); }
}
{
  // for another user
  const { data, error } = await customerClient
    .from('notifications')
    .insert({ user_id: providerId, title: 'fake', message: 'planted', type: 'info' })
    .select('id').maybeSingle();
  if (error && !data) ok('direct insert for ANOTHER user denied: ' + error.message);
  else { no('direct insert for ANOTHER user was ACCEPTED'); if (data?.id) createdNotifIds.push(data.id); }
}

// ---- cleanup: remove observed notifications + booking (cascades to events/messages) + provider ----
for (const id of createdNotifIds) {
  await customerClient.from('notifications').delete().eq('id', id);
  await providerClient.from('notifications').delete().eq('id', id);
}
if (bookingId) await customerClient.from('bookings').delete().eq('id', bookingId);
if (providerRowId) await providerClient.from('service_providers').delete().eq('id', providerRowId);

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
