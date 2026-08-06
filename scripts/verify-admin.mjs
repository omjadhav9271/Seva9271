/*
  Verifies the admin cleanup pass against the LIVE DB.
  Run AFTER `supabase db push` of 20260813120000 and 20260814120000.

  Account mapping (same as the rest of the suite):
    CUSTOMER_EMAIL = test2 → a signed-in NON-admin, the one who must be refused
    PROVIDER_EMAIL = test1 → a provider, used to prove trust_tier is not self-writable
    STRANGER_EMAIL = test3 → the ADMIN

  What it checks:
    (a) CATEGORIES ARE READ-PUBLIC, WRITE-ADMIN-ONLY — anon still reads the catalog; a signed-in
        non-admin is refused at the table AND at the RPC. Both matter: the table grant is the
        defence in depth, the is_admin() inside the RPC is the actual boundary.
    (b) THE ADMIN CAN ACTUALLY DO IT — create round-trips, the slug is normalised server-side,
        duplicates are refused, and a category still in use is refused with a message naming what
        holds it. That last one is the point of the check: the FKs disagree (service_providers and
        bookings block, provider_services CASCADEs), so an unguarded delete would silently drop
        the listings of providers who offer the category without listing it as their primary one.
    (c) TRUST TIER IS READABLE BUT SERVER-ONLY — Step 9.5 added the column and never granted
        SELECT on it, so every client got 42501 and the tier was surfaceable nowhere. It must now
        read, and must still refuse a write from the provider who owns the row (invariant #1).

  The document-expiry sweep being scheduled is asserted in verify-hardening.mjs, alongside the
  other two cron jobs.

  Usage — credentials come from .env.local (see .env.example):
    node scripts/verify-admin.mjs
*/
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { cred } from './lib/creds.mjs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };
const errMsg = (e) => (e && (e.message || JSON.stringify(e))) || '';
const denied = (e) => e && (e.code === '42501' || /permission denied|row-level security|violates|admin only|not authorized/i.test(errMsg(e)));

console.log('DB:', URL, '\n');
if (!SERVICE) { console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY not in .env.local.'); process.exit(0); }
const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

async function authClient(prefix) {
  const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = cred(`${prefix}_EMAIL`), password = cred(`${prefix}_PASSWORD`);
  if (!email) return { client, userId: null };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) { console.log(`${prefix} signIn error:`, error.message); return { client, userId: null }; }
  return { client, userId: data?.user?.id ?? null };
}

console.log('[sessions]');
const { client: outsider, userId: outsiderId } = await authClient('CUSTOMER');
const { client: providerClient, userId: providerUserId } = await authClient('PROVIDER');
const { client: adminClient, userId: adminId } = await authClient('STRANGER');
if (!outsiderId || !adminId) { console.log('Cannot run: could not sign in the test accounts.'); process.exit(0); }

// The whole suite is meaningless if these two are the same role, so assert the premise.
const roleOf = async (id) => (await service.from('profiles').select('role').eq('id', id).maybeSingle()).data?.role;
const outsiderRole = await roleOf(outsiderId), adminRole = await roleOf(adminId);
if (adminRole !== 'admin') { console.log(`Cannot run: STRANGER/ADMIN account is role='${adminRole}', not 'admin'.`); process.exit(0); }
if (outsiderRole === 'admin') { console.log('Cannot run: the CUSTOMER account is an admin, so the refusal tests prove nothing.'); process.exit(0); }
ok(`signed in: non-admin (role='${outsiderRole}') and admin (role='admin')`);

// Stamped so a crashed run that skipped its cleanup cannot collide with the next one on the
// unique slug — the failure would look like "duplicate slug refused", which is a PASS elsewhere.
const stamp = Date.now();
const TEST_NAME = `ZZ Verify Category ${stamp}`;
const TEST_SLUG = `zz-verify-category-${stamp}`;
let createdId = null;

// ─────────────────────────────────────────────────────────────── a) writes are admin-only
console.log('\n[a) categories: public to read, admin-only to write]');
{
  const { data: pub, error: pubErr } = await anon.from('service_categories').select('id, name, slug').limit(5);
  if (!pubErr && (pub ?? []).length > 0) ok(`anon still reads the catalog (${pub.length} categories)`);
  else no('anon can no longer read service_categories — the catalog must stay public: ' + errMsg(pubErr));

  // Direct table writes: defence in depth behind the RPC.
  const { error: insErr } = await outsider.from('service_categories')
    .insert({ name: `Rogue ${stamp}`, slug: `rogue-${stamp}` });
  if (denied(insErr)) ok('non-admin INSERT on service_categories is refused: ' + errMsg(insErr).slice(0, 60));
  else no('a non-admin INSERTED a category directly — the table grant is open');

  const victim = (await service.from('service_categories').select('id, name').limit(1)).data?.[0];
  if (victim) {
    const { error: updErr } = await outsider.from('service_categories')
      .update({ name: 'Renamed by a stranger' }).eq('id', victim.id);
    // PostgREST reports a no-op update as success when RLS hides the row, so confirm by re-reading.
    const after = (await service.from('service_categories').select('name').eq('id', victim.id).maybeSingle()).data;
    if (denied(updErr) || after?.name === victim.name) ok('non-admin UPDATE does not change a category');
    else no(`a non-admin RENAMED a category to '${after?.name}'`);

    const { error: delErr } = await outsider.from('service_categories').delete().eq('id', victim.id);
    const stillThere = (await service.from('service_categories').select('id').eq('id', victim.id).maybeSingle()).data;
    if (denied(delErr) || stillThere) ok('non-admin DELETE does not remove a category');
    else no('a non-admin DELETED a category');
  } else {
    sk('no category to attempt an update/delete against');
  }

  // The RPCs are the real boundary — is_admin() inside, not the hidden button.
  const { error: rpcCreate } = await outsider.rpc('admin_create_category',
    { p_name: `Rogue RPC ${stamp}`, p_slug: null, p_description: null, p_icon: null, p_color: null, p_bg_color: null });
  if (denied(rpcCreate)) ok('non-admin admin_create_category is refused: ' + errMsg(rpcCreate).slice(0, 40));
  else no('a non-admin CREATED a category through admin_create_category');

  if (victim) {
    const { error: rpcDelete } = await outsider.rpc('admin_delete_category', { p_id: victim.id });
    if (denied(rpcDelete)) ok('non-admin admin_delete_category is refused: ' + errMsg(rpcDelete).slice(0, 40));
    else no('a non-admin DELETED a category through admin_delete_category');
  }

  // category_usage counts bookings per category, and bookings RLS shows a user only their own.
  const { error: usageErr } = await outsider.rpc('category_usage');
  if (denied(usageErr)) ok('non-admin category_usage is refused: ' + errMsg(usageErr).slice(0, 40));
  else no('a non-admin read category_usage — it aggregates bookings past RLS (20260814120000)');
}

// ─────────────────────────────────────────────────────────────── b) the admin can, and is guarded
console.log('\n[b) the admin can manage categories, and is stopped from breaking one]');
{
  // Slug deliberately messy: it is what /services routes on, so it must come back normalised.
  const { data: created, error: createErr } = await adminClient.rpc('admin_create_category',
    { p_name: TEST_NAME, p_slug: `  ZZ Verify   Category!! ${stamp} `, p_description: 'temporary — verify-admin.mjs',
      p_icon: null, p_color: null, p_bg_color: null });
  if (createErr) {
    no('the admin could NOT create a category: ' + errMsg(createErr));
  } else {
    createdId = created?.id ?? null;
    ok(`the admin created a category (${created?.name})`);
    // Leading/trailing space, doubled space, punctuation and case all have to come out the other
    // side as one clean slug — it is what /services and the category pages route on.
    if (created?.slug === TEST_SLUG) ok(`the slug was normalised server-side → '${created.slug}'`);
    else no(`the slug was not normalised: got '${created?.slug}', expected '${TEST_SLUG}'`);

    // Step 9.5's trigger seeds the base KYC requirements on INSERT; the RPC must not have bypassed it.
    const { data: seeded } = await service.from('category_kyc_requirements')
      .select('doc_code').eq('category_id', createdId);
    const codes = (seeded ?? []).map((r) => r.doc_code).sort();
    if (codes.length > 0) ok(`the new category inherited its base KYC requirements (${codes.join(', ')})`);
    else no('the new category has NO KYC requirements — the seed trigger did not fire');

    const { error: dupErr } = await adminClient.rpc('admin_create_category',
      { p_name: 'Something Else', p_slug: created.slug, p_description: null, p_icon: null, p_color: null, p_bg_color: null });
    if (dupErr) ok('a duplicate slug is refused: ' + errMsg(dupErr).slice(0, 60));
    else no('a SECOND category was created on the same slug — the URL is now ambiguous');
  }

  const { error: blankErr } = await adminClient.rpc('admin_create_category',
    { p_name: '   ', p_slug: null, p_description: null, p_icon: null, p_color: null, p_bg_color: null });
  if (blankErr) ok('a blank name is refused: ' + errMsg(blankErr).slice(0, 50));
  else no('a category was created with a blank name');

  // The one that matters: a category with providers/bookings/listings behind it must not vanish.
  const { data: usage, error: usageErr } = await adminClient.rpc('category_usage');
  if (usageErr) {
    no('the admin could not read category_usage: ' + errMsg(usageErr));
  } else {
    ok(`the admin reads category_usage (${(usage ?? []).length} categories)`);
    const busy = (usage ?? []).find((u) => (u.providers + u.bookings + u.offered) > 0);
    if (!busy) {
      sk('no category is currently in use, so the in-use refusal could not be exercised');
    } else {
      const { error: refusal } = await adminClient.rpc('admin_delete_category', { p_id: busy.category_id });
      const survived = (await service.from('service_categories').select('id').eq('id', busy.category_id).maybeSingle()).data;
      if (refusal && survived) ok('deleting an in-use category is refused: ' + errMsg(refusal).slice(0, 90));
      else if (!survived) no('an IN-USE category was deleted — provider_services rows cascaded away with it');
      else no('the delete reported success but the category is still there');
    }
  }

  const { error: missingErr } = await adminClient.rpc('admin_delete_category',
    { p_id: '00000000-0000-0000-0000-000000000000' });
  if (missingErr) ok('deleting a category that does not exist is refused: ' + errMsg(missingErr).slice(0, 50));
  else no('deleting a non-existent category reported success');

  if (createdId) {
    const { error: delErr } = await adminClient.rpc('admin_delete_category', { p_id: createdId });
    const gone = !(await service.from('service_categories').select('id').eq('id', createdId).maybeSingle()).data;
    if (!delErr && gone) { ok('the admin deleted the unused category again (round trip)'); createdId = null; }
    else no('the admin could not delete an unused category: ' + errMsg(delErr));
  }
}

// ─────────────────────────────────────────────────────────────── c) trust_tier: readable, server-only
console.log('\n[c) trust_tier is readable by clients and writable by none]');
{
  // The bug this pass fixed: Step 9.5 added the column, the Step-7 PII hardening had already
  // replaced blanket table access with an explicit column list, and Step 9.5 never joined it.
  const { data: pubTier, error: tierErr } = await anon
    .from('service_providers').select('id, business_name, trust_tier').eq('status', 'approved').limit(3);
  if (tierErr) no('anon cannot SELECT trust_tier (' + errMsg(tierErr) + ') — the badge cannot render');
  else if ((pubTier ?? []).length === 0) sk('no approved provider to read a trust_tier from');
  else if (pubTier.every((p) => typeof p.trust_tier === 'number'))
    ok(`anon reads trust_tier on approved providers (tiers: ${pubTier.map((p) => p.trust_tier).join(', ')})`);
  else no('trust_tier came back non-numeric: ' + JSON.stringify(pubTier));

  const { error: authTierErr } = await outsider
    .from('service_providers').select('id, trust_tier').eq('status', 'approved').limit(1);
  if (authTierErr) no('a signed-in user cannot SELECT trust_tier: ' + errMsg(authTierErr));
  else ok('a signed-in user reads trust_tier');

  // Invariant #1: reputation and capability are server-computed. The owner must not be able to
  // promote themselves to tier 3 and inherit a background-check badge nobody performed.
  if (!providerUserId) {
    sk('no PROVIDER account signed in, so self-promotion could not be attempted');
  } else {
    const mine = (await service.from('service_providers')
      .select('id, trust_tier').eq('user_id', providerUserId).maybeSingle()).data;
    if (!mine) {
      sk('the PROVIDER account owns no provider row to attempt self-promotion on');
    } else {
      const { error: selfErr } = await providerClient
        .from('service_providers').update({ trust_tier: 3 }).eq('id', mine.id);
      const after = (await service.from('service_providers')
        .select('trust_tier').eq('id', mine.id).maybeSingle()).data;
      if (after?.trust_tier === mine.trust_tier) ok(`a provider cannot raise their own trust_tier (still ${after?.trust_tier})`);
      else no(`a provider SELF-PROMOTED from tier ${mine.trust_tier} to ${after?.trust_tier}`);
      if (selfErr) ok('the self-promotion was rejected outright: ' + errMsg(selfErr).slice(0, 50));
    }
  }

  // The sweep that demotes on expiry is service-role only; a client must not be able to run it.
  const { error: sweepErr } = await outsider.rpc('expire_provider_documents');
  if (denied(sweepErr) || sweepErr) ok('a client cannot run expire_provider_documents(): ' + errMsg(sweepErr).slice(0, 45));
  else no('a signed-in user ran the document-expiry sweep');

  /* The admin DETAIL route must actually SELECT trust_tier.

     This assertion exists because the obvious one is worthless. ProviderApplicationDetail extends
     ProviderApplicationRow, which declares `trust_tier`, so TypeScript is satisfied whether or not
     the route's column list includes it — and TrustTierBadge falls back to tier 1 for a missing
     value. Every provider in this database is genuinely tier 1, so "a Tier N badge rendered" and
     even "it says Tier 1" both pass with the field absent. Only the presence of the KEY in the
     payload separates a real answer from the default. */
  const { data: { session: adminSession } } = await adminClient.auth.getSession();
  const token = adminSession?.access_token;
  const APP = process.env.APP_URL ?? 'http://localhost:3000';
  let listJson = null;
  try {
    const r = await fetch(`${APP}/api/admin/provider-applications`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45000) });
    listJson = r.ok ? await r.json() : null;
  } catch { /* dev server down */ }

  if (!listJson) {
    sk('admin detail route returns trust_tier (dev server not answering on :3000)');
  } else {
    const first = (listJson.applications ?? [])[0];
    if (!first) {
      sk('no application to fetch a detail payload for');
    } else {
      const r = await fetch(`${APP}/api/admin/provider-applications?id=${encodeURIComponent(first.id)}`,
        { headers: { Authorization: `Bearer ${token}` } });
      const detail = r.ok ? await r.json() : null;
      const app = detail?.application ?? {};
      if (Object.prototype.hasOwnProperty.call(app, 'trust_tier') && typeof app.trust_tier === 'number')
        ok(`the admin detail route returns trust_tier (${app.trust_tier}) — the badge is reading a real value, not its tier-1 default`);
      else no('the admin detail route omits trust_tier — the decision page shows tier 1 for EVERY applicant');
      // The list route feeds the queue's per-row badge; same failure mode, same check.
      if (typeof first.trust_tier === 'number') ok('the admin list route returns trust_tier');
      else no('the admin list route omits trust_tier');
    }
  }
}

// ─────────────────────────────────────────────────────────────── cleanup
if (createdId) {
  await service.from('category_kyc_requirements').delete().eq('category_id', createdId);
  await service.from('service_categories').delete().eq('id', createdId);
  console.log('\n  cleaned up the temp category left behind by a failed round trip.');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
