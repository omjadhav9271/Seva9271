/*
  Verifies the Step-1 security invariants against the LIVE Supabase DB using only the
  public anon key (i.e. exactly what a browser client can do). Run it AFTER applying:
    - 20260622131542_seva_initial_schema.sql
    - 20260627130547_seva_indian_services_expansion.sql
    - 20260710120000_seva_security_hardening.sql
    - 20260710121000_seva_demo_providers_seed.sql

  Usage (from repo root):
    node scripts/verify-hardening.mjs

  Auth-dependent checks need a logged-in user. This script signs up a throwaway user.
  If your project has "Confirm email" ON, signup won't return a session — either turn it
  off temporarily, or pass a pre-confirmed test account:
    TEST_EMAIL=you@example.com TEST_PASSWORD=secret node scripts/verify-hardening.mjs
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
const userClient = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

console.log('DB:', URL, '\n');

// ---- establish an authenticated session ----
let userId = null;
{
  const email = process.env.TEST_EMAIL ?? `verify+${Date.now()}@seva.test`;
  const password = process.env.TEST_PASSWORD ?? randomUUID();
  if (process.env.TEST_EMAIL) {
    const { data, error } = await userClient.auth.signInWithPassword({ email, password });
    if (error) console.log('signIn error:', error.message);
    userId = data?.user?.id ?? null;
  } else {
    const { data, error } = await userClient.auth.signUp({ email, password, options: { data: { full_name: 'Verify Bot' } } });
    if (error) console.log('signUp error:', error.message);
    userId = data?.session ? data.user.id : null;
    if (!data?.session && data?.user) console.log('(signup created a user but returned no session — likely email-confirmation is ON)');
  }
}
const authed = !!userId;
console.log('authenticated:', authed ? `yes (${userId})` : 'NO — auth-dependent checks will be skipped', '\n');

// ---- 1) DB reachable + real providers present ----
console.log('[reads]');
{
  const { data, error } = await anon
    .from('service_providers').select('id, business_name, city').eq('status', 'approved');
  if (error) no('read approved providers: ' + error.message);
  else if (data.length >= 3) ok(`approved providers visible to anon: ${data.length} (${data.map((p) => p.business_name).join(', ')})`);
  else no(`expected >=3 approved providers, got ${data.length} (apply the seed migration)`);
}

// ---- 2) anon cannot read phone from profiles ----
console.log('\n[privacy: no PII to anon]');
{
  const { data, error } = await anon.from('profiles').select('id, phone').limit(5);
  if (error) ok('anon SELECT on profiles is denied: ' + error.message);
  else if (data.length === 0) ok('anon SELECT on profiles returns 0 rows (blanket anon policy dropped)');
  else no(`anon read ${data.length} profile row(s) incl phone — hardening item 6 NOT applied`);

  const { data: v, error: vErr } = await anon.from('public_profiles').select('*').limit(1);
  if (vErr) no('public_profiles view missing/denied: ' + vErr.message);
  else if (v.length && Object.prototype.hasOwnProperty.call(v[0], 'phone')) no('public_profiles exposes phone!');
  else ok('public_profiles view present and exposes no phone column');
}

// ---- auth-dependent negative writes ----
console.log('\n[money + reputation are server-only]');
if (!authed) {
  sk('wallet insert blocked (no session)');
  sk('wallet_balance self-set blocked (no session)');
  sk('provider rating/is_verified self-set blocked (no session)');
  sk('review without completed booking blocked (no session)');
} else {
  // 3) cannot insert into wallet ledger
  {
    const { error } = await userClient.from('wallet_transactions')
      .insert({ user_id: userId, type: 'credit', amount: 500 });
    if (error) ok('wallet_transactions insert denied: ' + error.message);
    else no('wallet_transactions insert SUCCEEDED — user can mint money');
  }
  // 4) cannot set own wallet_balance
  {
    const { error } = await userClient.from('profiles')
      .update({ wallet_balance: 999999 }).eq('id', userId);
    const { data: after } = await userClient.from('profiles').select('wallet_balance').eq('id', userId).maybeSingle();
    if (error && Number(after?.wallet_balance ?? 0) === 0) ok('profiles.wallet_balance update denied (col grant): ' + error.message);
    else if (!error && Number(after?.wallet_balance ?? 0) === 0) ok('profiles.wallet_balance unchanged (silently ignored)');
    else no('profiles.wallet_balance was writable — now ' + after?.wallet_balance);
  }
  // 5) cannot self-set provider rating / is_verified
  {
    const providerId = randomUUID();
    const { error: insErr } = await userClient.from('service_providers').insert({
      id: providerId, user_id: userId, business_name: 'Verify Bot Svc', hourly_rate: 100,
      city: 'Mumbai', state: 'Maharashtra', status: 'pending',
    });
    if (insErr) { sk('provider rating self-set (could not create own provider row: ' + insErr.message + ')'); }
    else {
      const { error } = await userClient.from('service_providers')
        .update({ rating: 5, is_verified: true, status: 'approved' }).eq('id', providerId);
      const { data: after } = await userClient.from('service_providers')
        .select('rating, is_verified, status').eq('id', providerId).maybeSingle();
      const unchanged = Number(after?.rating) === 0 && after?.is_verified === false && after?.status === 'pending';
      if (unchanged) ok('service_providers rating/is_verified/status not self-settable (' + (error ? error.message : 'columns not granted') + ')');
      else no('provider self-set protected columns! rating=' + after?.rating + ' verified=' + after?.is_verified + ' status=' + after?.status);
      // 6) cannot review without a completed booking: make a pending booking, try to review it
      const { data: bk, error: bkErr } = await userClient.from('bookings').insert({
        customer_id: userId, provider_id: providerId, service_type: 'one-time',
        hourly_rate: 100, total_amount: 200, payment_method: 'cod',
      }).select('id').maybeSingle();
      if (bkErr || !bk) sk('review-gate (could not create test booking: ' + (bkErr?.message ?? 'none') + ')');
      else {
        const { error: rvErr } = await userClient.from('reviews')
          .insert({ booking_id: bk.id, customer_id: userId, provider_id: providerId, rating: 5, comment: 'x' });
        if (rvErr) ok('review insert denied for non-completed booking: ' + rvErr.message);
        else no('review insert SUCCEEDED without a completed booking');
        await userClient.from('bookings').delete().eq('id', bk.id);
      }
      await userClient.from('service_providers').delete().eq('id', providerId);
    }
  }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
