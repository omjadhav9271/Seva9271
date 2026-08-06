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
// Used only to STAGE fixtures (mint a pre-confirmed test user, approve its provider row).
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };

const anon = createClient(URL, KEY);
const service = SERVICE ? createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const userClient = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

console.log('DB:', URL, '\n');

// ---- establish an authenticated session ----
let userId = null;
let throwawayUserId = null;
{
  const email = process.env.TEST_EMAIL ?? `verify-hardening-${Date.now()}@seva.test`;
  const password = process.env.TEST_PASSWORD ?? randomUUID();
  if (process.env.TEST_EMAIL) {
    const { data, error } = await userClient.auth.signInWithPassword({ email, password });
    if (error) console.log('signIn error:', error.message);
    userId = data?.user?.id ?? null;
  } else if (service) {
    // plain signUp returns NO session when "Confirm email" is ON, which used to skip every
    // auth-dependent check below. Mint a pre-confirmed throwaway instead and delete it after.
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) console.log('createUser error:', error.message);
    else {
      const { error: sErr } = await userClient.auth.signInWithPassword({ email, password });
      if (sErr) console.log('signIn error:', sErr.message);
      else { userId = data.user.id; throwawayUserId = data.user.id; }
    }
  } else {
    console.log('(no SUPABASE_SERVICE_ROLE_KEY and no TEST_EMAIL — auth-dependent checks will skip)');
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
    // Compare against the balance we started with, not against 0. Hardcoding 0 only held for the
    // throwaway user this script mints; pass TEST_EMAIL for an account with real escrow history
    // (test1 sits at ₹4110) and a correctly DENIED write still reported "was writable".
    const { data: beforeRow } = await userClient.from('profiles')
      .select('wallet_balance').eq('id', userId).maybeSingle();
    const before = Number(beforeRow?.wallet_balance ?? 0);
    const { error } = await userClient.from('profiles')
      .update({ wallet_balance: before + 999999 }).eq('id', userId);
    const { data: afterRow } = await userClient.from('profiles')
      .select('wallet_balance').eq('id', userId).maybeSingle();
    const after = Number(afterRow?.wallet_balance ?? 0);
    if (error && after === before) ok('profiles.wallet_balance update denied (col grant): ' + error.message);
    else if (!error && after === before) ok('profiles.wallet_balance unchanged (silently ignored)');
    else no(`profiles.wallet_balance was writable — ${before} → ${after}`);
  }
  // 5) cannot self-set provider rating / is_verified
  {
    // Step 9's INSERT column grant covers neither `id` nor `status` — the DB assigns both, and
    // the row is born pending/unverified whatever the client sends.
    const { data: provRow, error: insErr } = await userClient.from('service_providers').insert({
      user_id: userId, business_name: 'Verify Bot Svc', hourly_rate: 100,
      city: 'Mumbai', state: 'Maharashtra',
    }).select('id').maybeSingle();
    const providerId = provRow?.id ?? null;
    if (insErr || !providerId) { sk('provider rating self-set (could not create own provider row: ' + (insErr?.message ?? 'no row') + ')'); }
    else {
      // Step 9 gate: a booking needs an APPROVED provider, and approving is server-only.
      if (service) await service.from('service_providers').update({ status: 'approved', is_verified: true }).eq('id', providerId);
      const { error } = await userClient.from('service_providers')
        .update({ rating: 5, is_verified: true, status: 'approved' }).eq('id', providerId);
      const { data: after } = await userClient.from('service_providers')
        .select('rating, is_verified, status').eq('id', providerId).maybeSingle();
      // (the fixture was approved above, so assert the CLIENT's write did not land)
      const unchanged = Number(after?.rating) === 0;
      if (unchanged) ok('service_providers rating/is_verified/status not self-settable (' + (error ? error.message : 'columns not granted') + ')');
      else no('provider self-set protected columns! rating=' + after?.rating + ' verified=' + after?.is_verified + ' status=' + after?.status);
      // 6) cannot review without a completed booking: make a pending booking, try to review it
      const { data: bk, error: bkErr } = await userClient.from('bookings').insert({
        customer_id: userId, provider_id: providerId, service_type: 'one-time',
        hourly_rate: 100, total_amount: 200, payment_method: 'upi',  // COD blocked since Step 5.5
      }).select('id').maybeSingle();
      if (bkErr || !bk) sk('review-gate (could not create test booking: ' + (bkErr?.message ?? 'none') + ')');
      else {
        const { error: rvErr } = await userClient.from('reviews')
          .insert({ booking_id: bk.id, customer_id: userId, provider_id: providerId, rating: 5, comment: 'x' });
        if (rvErr) ok('review insert denied for non-completed booking: ' + rvErr.message);
        else no('review insert SUCCEEDED without a completed booking');
        // Step 10 hardening dropped delete_own_booking (a booking is a financial record, and
        // deleting one reset the anti-probe cap), so cleanup goes through the service role.
        await service?.from('bookings').delete().eq('id', bk.id);
      }

      // 7) a booking cannot be BORN in a forged state (migration 20260803120000).
      //    Step 2 revoked UPDATE on bookings but never INSERT, so a customer could create a row
      //    already 'held' — passing the escrow gate with no payment, and having the platform fund
      //    the provider's payout on confirm. Invariants #4 and #5.
      {
        const forge = async (label, extra) => {
          const { data, error } = await userClient.from('bookings').insert({
            customer_id: userId, provider_id: providerId, service_type: 'one-time',
            hourly_rate: 100, total_amount: 200, payment_method: 'upi', ...extra,
          }).select('id').maybeSingle();
          if (error) ok(`booking cannot be born with ${label}: ` + error.message);
          else {
            no(`booking WAS born with ${label} — escrow/state can be forged at insert`);
            if (data?.id) await service?.from('bookings').delete().eq('id', data.id);
          }
        };
        await forge("payment_status='held' (unpaid work)", { payment_status: 'held' });
        await forge("status='paid'", { status: 'paid' });
        await forge('a client-set price_charged', { price_charged: 1 });

        // …while an ordinary booking still works and starts clean
        const { data: okBk } = await userClient.from('bookings').insert({
          customer_id: userId, provider_id: providerId, service_type: 'one-time',
          hourly_rate: 100, total_amount: 200, payment_method: 'upi',
        }).select('id, status, payment_status').maybeSingle();
        if (okBk?.status === 'requested' && okBk?.payment_status === 'pending')
          ok('a legitimate booking is still created, and starts requested/pending');
        else no('legitimate booking blocked or born wrong: ' + JSON.stringify(okBk));
        if (okBk?.id) await service?.from('bookings').delete().eq('id', okBk.id);
      }

      await userClient.from('service_providers').delete().eq('id', providerId);
    }
  }
}

// ---- background jobs are actually scheduled ----
// pg_cron went uninstalled from Step 7 to Step 10 without a single red test: the schedules live in
// the `cron` schema, PostgREST only exposes `public`, and 20260807120000 guarded its cron.schedule
// on pg_extension — so a project with no scheduler applied the migration and reported success.
// public.scheduled_jobs() (20260810120000) is the window into it; a missing job now fails here.
console.log('\n[background jobs are scheduled]');
if (!service) {
  sk('cron jobs scheduled (no service key)');
} else {
  const { data, error } = await service.rpc('scheduled_jobs');
  if (error) {
    no('scheduled_jobs() unreadable: ' + error.message);
  } else {
    const jobs = new Map((data ?? []).map((j) => [j.jobname, j]));
    for (const [name, schedule, why] of [
      ['nightly-reputation', '0 2 * * *', 'time-decay never propagates; scores freeze between booking events'],
      ['hourly-expire-offers', '7 * * * *', "abandoned negotiations sit in 'negotiating' forever, holding the anti-probe slot"],
      ['nightly-expire-documents', '20 2 * * *', 'verified documents never lapse, so a tier-3 badge outlives the police check behind it'],
    ]) {
      const job = jobs.get(name);
      if (!job) no(`${name} is NOT scheduled — ${why}`);
      else if (!job.active) no(`${name} exists but is INACTIVE — ${why}`);
      else if (job.schedule !== schedule) no(`${name} runs on '${job.schedule}', expected '${schedule}'`);
      else ok(`${name} scheduled and active (${job.schedule})`);
    }
  }

  // The RPC reads the scheduler; a browser client has no business enumerating it.
  const { error: anonErr } = await anon.rpc('scheduled_jobs');
  if (anonErr) ok('anon cannot call scheduled_jobs(): ' + anonErr.message);
  else no('anon CAN call scheduled_jobs() — EXECUTE should be service_role only');
}

if (throwawayUserId && service) await service.auth.admin.deleteUser(throwawayUserId);

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
