/*
  Put a test provider's application back to PENDING so an onboarding run can actually be watched
  end to end.

  Why this exists: the test provider account is already approved, so /become-provider shows the
  "You're live" screen and there is no pending → approve journey left to drive. This is a FIXTURE
  reset, not a fix — it stages the account, it does not change any behaviour under test.

  What it does (service role, so it bypasses RLS):
    • service_providers → status 'pending', is_verified false, kyc_status 'unsubmitted',
      kyc_documents [], applied_at/reviewed_at/reviewed_by/rejection_reason cleared, trust_tier 1
    • deletes that provider's provider_documents rows (the storage objects are left alone —
      they are harmless, and deleting them is not what is being tested)

  It does NOT touch bookings, reviews, reputation or the wallet.

  The row still EXISTS afterwards, so /become-provider shows the status screen ("Not sent for
  review yet"), not a blank form. applied_at is NULL, and the admin queue selects on applied_at
  — so the application is intentionally invisible to reviewers until it is resubmitted through
  the form. That is the honest state, not a bug; the screen says so out loud.

  Usage (from the repo root):
    node scripts/reset-provider-application.mjs                  # the PROVIDER_EMAIL account
    node scripts/reset-provider-application.mjs someone@x.com
*/
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { requireAccounts } from './lib/creds.mjs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

const { PROVIDER } = requireAccounts(['PROVIDER']);
const email = process.argv[2] ?? PROVIDER.email;

const { data: { users } } = await service.auth.admin.listUsers({ perPage: 200 });
const user = users.find((u) => u.email === email);
if (!user) { console.log(`No such user: ${email}`); process.exit(1); }

const { data: sp } = await service.from('service_providers')
  .select('id, business_name, status, kyc_status').eq('user_id', user.id).maybeSingle();
if (!sp) { console.log(`${email} owns no provider row — nothing to reset.`); process.exit(0); }

const { count: docCount } = await service.from('provider_documents')
  .select('id', { count: 'exact', head: true }).eq('provider_id', sp.id);
await service.from('provider_documents').delete().eq('provider_id', sp.id);

const { error } = await service.from('service_providers').update({
  status: 'pending',
  is_verified: false,
  kyc_status: 'unsubmitted',
  kyc_documents: [],
  applied_at: null,
  reviewed_at: null,
  reviewed_by: null,
  rejection_reason: null,
  trust_tier: 1,
}).eq('id', sp.id);
if (error) { console.log('Reset failed: ' + error.message); process.exit(1); }

console.log(`Reset ${email} (${sp.business_name ?? 'unnamed'}, ${sp.id})`);
console.log(`  was: status=${sp.status} kyc=${sp.kyc_status}, ${docCount ?? 0} document row(s)`);
console.log('  now: status=pending kyc=unsubmitted applied_at=NULL, 0 document rows.');
console.log('');
console.log('  NEXT: /become-provider shows the STATUS screen ("Not sent for review yet"), not a');
console.log('  blank form — the provider row still exists, which is the point (bookings and the');
console.log('  provider id survive). To walk a full onboarding: add the documents, then click');
console.log('  "Edit my details and resubmit" → "Resubmit application". That stamps applied_at,');
console.log('  which is what the admin queue selects on — until then the application is');
console.log('  deliberately NOT in the review queue.');
