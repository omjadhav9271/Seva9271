/*
  Verifies the provider-PII hardening against the LIVE Supabase DB.
  Run it AFTER applying 20260727120000_seva_provider_pii_hardening.sql (supabase db push).

  What it checks:
    (a) SENSITIVE columns are server-only: anon AND authenticated get permission denied (42501)
        selecting phone / address / work_address / latitude / longitude / documents — and on
        select('*'), since PostgREST expands * to all columns
    (b) the public CATALOG still works signed-out: the exact column lists used by the providers
        list page and the provider detail page return rows for anon
    (c) OWN-ROW access: a provider reads their own full row (incl. phone) via my_provider_profile;
        a user with no provider rows gets zero rows; anon is denied outright
    (d) REGRESSION: the RLS policies that subquery service_providers.user_id still evaluate —
        a provider can still see their own bookings, and the ownsProviderSide-style filtered
        select (id + user_id) still works

  Usage (from repo root) — roles match the live-DB mapping (provider=test1, customer=test2):
    CUSTOMER_EMAIL=test2@gmail.com CUSTOMER_PASSWORD=test2@9271 \
    PROVIDER_EMAIL=test1@gmail.com PROVIDER_PASSWORD=test1@9271 \
    STRANGER_EMAIL=test3@gmail.com STRANGER_PASSWORD=test3@9271 \
    node scripts/verify-provider-pii.mjs
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
const denied = (e) => e && (e.code === '42501' || /permission denied/i.test(e.message));

console.log('DB:', URL, '\n');
if (!SERVICE) { console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY not in .env.local.'); process.exit(0); }

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

console.log('[sessions]');
const { client: customerClient, userId: customerId } = await authClient('CUSTOMER');
const { client: providerClient, userId: providerId } = await authClient('PROVIDER');
console.log('  customer:', customerId ?? 'NONE', '| provider:', providerId ?? 'NONE', '\n');
if (!customerId || !providerId || customerId === providerId) {
  console.log('Cannot run: need distinct CUSTOMER_* and PROVIDER_* sessions.');
  process.exit(0);
}

// ================= (a) sensitive columns are server-only =================
console.log('[a) phone / addresses / coordinates / documents denied to anon AND authenticated]');
{
  const SENSITIVE = ['phone', 'address', 'work_address', 'latitude', 'longitude', 'documents'];
  for (const [label, client] of [['anon', anon], ['authenticated', customerClient]]) {
    let allDenied = true, leaked = [];
    for (const col of SENSITIVE) {
      const r = await client.from('service_providers').select(col).limit(1);
      if (!denied(r.error)) { allDenied = false; leaked.push(col); }
    }
    if (allDenied) ok(`${label}: all ${SENSITIVE.length} sensitive columns denied (42501)`);
    else no(`${label}: sensitive columns NOT denied: ${leaked.join(', ')}`);

    const star = await client.from('service_providers').select('*').limit(1);
    if (denied(star.error)) ok(`${label}: select('*') denied (partial grants make * fail closed)`);
    else no(`${label}: select('*') was allowed: ` + JSON.stringify(star.error ?? star.data?.[0]));
  }

  // the service role must still see everything (webhook route, admin jobs)
  const svc = await service.from('service_providers').select('phone').not('phone', 'is', null).limit(1);
  if (!svc.error) ok('service role still reads phone (server paths unaffected)');
  else no('service role read failed: ' + svc.error.message);
}

// ================= (b) the public catalog still works signed-out =================
console.log('\n[b) public catalog columns still readable by anon (the app\'s exact selects)]');
{
  // exact select from app/providers/page.tsx + app/services/page.tsx
  const list = await anon.from('service_providers')
    .select('id, business_name, bio, rating, total_reviews, hourly_rate, experience_years, city, is_verified, is_available, service_categories(name, slug)')
    .eq('status', 'approved').limit(3);
  if (!list.error && (list.data ?? []).length > 0) ok(`providers-list select works signed-out (${list.data.length} rows)`);
  else no('providers-list select broke: ' + (list.error?.message ?? 'no rows'));

  // exact select from app/providers/[id]/page.tsx (incl. Step-7 reputation_score)
  const { data: anyProv } = await service.from('service_providers').select('id').eq('status', 'approved').limit(1).maybeSingle();
  const detail = await anon.from('service_providers')
    .select('id, category_id, business_name, bio, experience_years, hourly_rate, rating, total_reviews, total_bookings, reputation_score, is_verified, is_available, city, state, service_categories(name, slug)')
    .eq('id', anyProv.id).maybeSingle();
  if (!detail.error && detail.data && 'reputation_score' in detail.data) ok('provider-detail select works signed-out (incl. reputation_score)');
  else no('provider-detail select broke: ' + (detail.error?.message ?? JSON.stringify(detail.data)));
}

// ================= (c) own-row access via my_provider_profile =================
console.log('\n[c) my_provider_profile: owner sees own full row; others see nothing]');
{
  const own = await providerClient.from('my_provider_profile').select('id, business_name, phone, documents');
  if (!own.error && (own.data ?? []).length >= 1 && 'phone' in own.data[0])
    ok(`provider reads their OWN full row(s) via the view (${own.data.length} rows, phone key present)`);
  else no('provider cannot read own row via my_provider_profile: ' + (own.error?.message ?? JSON.stringify(own.data)));

  const none = await customerClient.from('my_provider_profile').select('id');
  if (!none.error && (none.data ?? []).length === 0) ok('user with no provider rows gets ZERO rows (not an error)');
  else no('non-provider view read not as expected: ' + (none.error?.message ?? JSON.stringify(none.data)));

  const anonView = await anon.from('my_provider_profile').select('id');
  if (denied(anonView.error)) ok('anon denied on my_provider_profile: ' + anonView.error.message);
  else no('anon my_provider_profile not denied: ' + JSON.stringify(anonView.error ?? anonView.data));
}

// ================= (d) regression: user_id-subquery policies + filtered selects still work =================
console.log('\n[d) regression: RLS subqueries on user_id and filtered selects still evaluate]');
let seededBooking = null;
{
  // ownsProviderSide-style query (lib/bookings.ts): filter on id + user_id, select id
  const { data: provRow } = await service.from('service_providers')
    .select('id').eq('user_id', providerId).limit(1).maybeSingle();
  if (!provRow) { sk('provider account owns no service_providers row — cannot run (d)'); }
  else {
    const owns = await providerClient.from('service_providers')
      .select('id').eq('id', provRow.id).eq('user_id', providerId).maybeSingle();
    if (!owns.error && owns.data?.id === provRow.id) ok('ownsProviderSide-style select (filter on user_id) still works');
    else no('ownsProviderSide-style select broke: ' + (owns.error?.message ?? JSON.stringify(owns.data)));

    // seed one booking (service role) and confirm the PROVIDER still sees it — this exercises the
    // bookings SELECT policy's `auth.uid() IN (SELECT user_id FROM service_providers …)` subquery
    const { data: cat } = await anon.from('service_categories').select('id').limit(1).maybeSingle();
    const { data: bk, error: bkErr } = await service.from('bookings').insert({
      customer_id: customerId, provider_id: provRow.id, category_id: cat?.id ?? null,
      service_type: 'one-time', scheduled_date: '2026-09-25', scheduled_time: '11:00',
      duration_hours: 2, hourly_rate: 300, total_amount: 600, payment_method: 'upi',
    }).select('id').single();
    if (bkErr) no('seed booking failed: ' + bkErr.message);
    else {
      seededBooking = bk.id;
      const seen = await providerClient.from('bookings').select('id').eq('id', bk.id).maybeSingle();
      if (!seen.error && seen.data?.id === bk.id) ok('provider still sees their bookings (user_id policy subquery evaluates)');
      else no('provider CANNOT see their booking — policy subquery broke: ' + (seen.error?.message ?? 'no row'));
    }
  }
}

// ================= cleanup =================
console.log('\n[cleanup]');
{
  if (seededBooking) await service.from('bookings').delete().eq('id', seededBooking);
  console.log('  removed seeded booking.');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
