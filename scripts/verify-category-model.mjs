/*
  Verifies the per-category engagement model against the LIVE Supabase DB.
  Run AFTER `supabase db push` of 20260828120000_seva_category_engagement_model.sql.

  Account mapping:
    ADMIN_EMAIL    = test3 → the only account that may set a model or edit a category
    CUSTOMER_EMAIL = test2 → a signed-in non-admin; must be refused by every write RPC
    (anon)                 → must not even hold EXECUTE

  What it checks:
    (a) THE COLUMNS ARE READABLE. anon and authenticated can select engagement_model /
        model_decided_at. This is the trust_tier trap from 20260813120000 — a column added without
        a matching grant reads as 42501 and the feature renders nowhere.
    (b) 🔴 THE RPCs ARE ADMIN-ONLY, and refused for a signed-in NON-ADMIN specifically — not just
        for anon. Those are different policies, and "anon is blocked" says nothing about a logged-in
        stranger (the lesson from verify-step10's outsider gap).
    (c) A REFUSAL IS A REFUSAL, not a write that happened to match no row. Every denial below is
        checked against the row afterwards, because "it wrote nothing" and "it refused" are not the
        same thing and a test that accepts any error cannot tell them apart (20260818130000).
    (d) THE ADMIN CAN SET, CHANGE and CLEAR a model, and model_decided_at tracks it in all three
        directions — the trigger owns that column, so it cannot drift even if a caller lies.
    (e) A BOGUS MODEL IS REJECTED by the RPC *and* by the CHECK constraint underneath it.
    (f) A NEW CATEGORY IS BORN UNDECIDED. Grey by default is the whole premise of the board.
    (g) admin_update_category: renaming does NOT move the slug (URLs survive a rename), an explicit
        slug is normalised, a duplicate slug is refused, and a blank description clears.

  Everything it creates, it removes — the temporary category is deleted at the end, and the models
  of the real 25 are restored to whatever they were when the run started.

  Usage — credentials come from .env.local (see .env.example):
    node scripts/verify-category-model.mjs
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
// 'admin only' is this family's refusal. 42501 covers a missing EXECUTE grant, which is also a
// refusal — but a generic "any error passes" would let a typo'd RPC name count as security.
const refused = (e) => e && (e.code === '42501' || /admin only|permission denied|not authorized|could not find the function/i.test(errMsg(e)));

console.log('DB:', URL, '\n');
if (!SERVICE) { console.log('Cannot run: SUPABASE_SERVICE_ROLE_KEY not in .env.local.'); process.exit(0); }
const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

async function signIn(prefix) {
  const email = cred(`${prefix}_EMAIL`), password = cred(`${prefix}_PASSWORD`);
  if (!email || !password) return null;
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) { console.log(`  (could not sign in ${prefix}: ${error.message})`); return null; }
  return { client: c, userId: data.user.id };
}

const modelOf = async (id) => {
  const { data } = await service.from('service_categories')
    .select('engagement_model, model_decided_at, name, slug, description').eq('id', id).single();
  return data;
};

const main = async () => {
  const admin = await signIn('ADMIN');
  const customer = await signIn('CUSTOMER');
  if (!admin) { console.log('Cannot run: no ADMIN_* credentials.'); process.exit(0); }

  // A real category to experiment on, and its original model so the run leaves no trace.
  const { data: victim } = await service.from('service_categories')
    .select('id, name, slug, engagement_model').order('name').limit(1).single();
  const original = victim.engagement_model;

  // ───────────────────────────────────────────────────────────────────────────
  console.log('(a) the new columns are readable');
  {
    const { error: aErr } = await anon.from('service_categories').select('engagement_model, model_decided_at').limit(1);
    aErr ? no(`anon cannot read engagement_model — ${errMsg(aErr)}`) : ok('anon reads engagement_model + model_decided_at');

    if (customer) {
      const { error: cErr } = await customer.client.from('service_categories').select('engagement_model, model_decided_at').limit(1);
      cErr ? no(`authenticated cannot read engagement_model — ${errMsg(cErr)}`) : ok('a signed-in user reads them too');
    } else sk('no CUSTOMER_* credentials — authenticated read UNTESTED');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n(b/c) the write path is admin-only, and a refusal really refuses');
  {
    const before = await modelOf(victim.id);

    const { error: anonSet } = await anon.rpc('admin_set_category_model', { p_id: victim.id, p_model: 'lead' });
    refused(anonSet) ? ok(`anon cannot set a model (${anonSet.code || 'admin only'})`)
                     : no(`anon set a model or failed oddly — ${errMsg(anonSet) || 'NO ERROR AT ALL'}`);

    if (customer) {
      const { error: custSet } = await customer.client.rpc('admin_set_category_model', { p_id: victim.id, p_model: 'lead' });
      refused(custSet) ? ok('a signed-in NON-ADMIN cannot set a model')
                       : no(`a signed-in non-admin set a model — ${errMsg(custSet) || 'NO ERROR AT ALL'}`);

      const { error: custUpd } = await customer.client.rpc('admin_update_category', { p_id: victim.id, p_name: 'Hijacked' });
      refused(custUpd) ? ok('a signed-in NON-ADMIN cannot edit a category')
                       : no(`a signed-in non-admin edited a category — ${errMsg(custUpd) || 'NO ERROR AT ALL'}`);
    } else sk('no CUSTOMER_* credentials — the signed-in-non-admin case is UNTESTED');

    // The half that matters: nothing above actually changed anything.
    const after = await modelOf(victim.id);
    (after.engagement_model === before.engagement_model && after.name === before.name)
      ? ok('and the row is untouched — those were refusals, not silent no-ops')
      : no(`the row CHANGED despite the errors: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n(d) the admin sets, changes and clears — and the trigger stamps all three');
  {
    await admin.client.rpc('admin_set_category_model', { p_id: victim.id, p_model: 'escrow' });
    let r = await modelOf(victim.id);
    r.engagement_model === 'escrow' ? ok('admin set escrow') : no(`set escrow failed — got ${r.engagement_model}`);
    r.model_decided_at ? ok('model_decided_at stamped on set') : no('model_decided_at is NULL after a set');
    const firstStamp = r.model_decided_at;

    await new Promise((res) => setTimeout(res, 1100)); // so a re-stamp is distinguishable
    await admin.client.rpc('admin_set_category_model', { p_id: victim.id, p_model: 'placement' });
    r = await modelOf(victim.id);
    r.engagement_model === 'placement' ? ok('admin changed it to placement') : no(`change failed — got ${r.engagement_model}`);
    (r.model_decided_at && r.model_decided_at !== firstStamp)
      ? ok('model_decided_at RE-stamped on a change')
      : no('model_decided_at did not move when the model changed');

    // Same model again must NOT re-stamp — the trigger keys on IS DISTINCT FROM, and a decision
    // that did not change is not a decision that was re-made.
    const stamp2 = r.model_decided_at;
    await admin.client.rpc('admin_set_category_model', { p_id: victim.id, p_model: 'placement' });
    r = await modelOf(victim.id);
    r.model_decided_at === stamp2 ? ok('setting the SAME model does not re-stamp the date')
                                  : no('an unchanged model moved model_decided_at');

    await admin.client.rpc('admin_set_category_model', { p_id: victim.id, p_model: null });
    r = await modelOf(victim.id);
    r.engagement_model === null ? ok('admin cleared it back to undecided (the board walks backwards)')
                                : no(`clear failed — got ${r.engagement_model}`);
    r.model_decided_at === null ? ok('model_decided_at cleared with it — no orphan date on a grey row')
                                : no(`model_decided_at survived the clear: ${r.model_decided_at}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n(e) a bogus model is rejected at BOTH layers');
  {
    const { error } = await admin.client.rpc('admin_set_category_model', { p_id: victim.id, p_model: 'freemium' });
    /is not an engagement model/i.test(errMsg(error)) ? ok('the RPC names the four valid models back')
                                                      : no(`bogus model not rejected by the RPC — ${errMsg(error) || 'NO ERROR'}`);

    // And underneath it, with the RPC bypassed entirely (service role writes the table directly).
    const { error: chk } = await service.from('service_categories')
      .update({ engagement_model: 'freemium' }).eq('id', victim.id);
    /check constraint|violates/i.test(errMsg(chk)) ? ok('the CHECK constraint refuses it even past the RPC')
                                                   : no(`the raw column accepted 'freemium' — ${errMsg(chk) || 'NO ERROR'}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n(f/g) a new category is born undecided; editing it keeps its URL');
  let tempId = null;
  {
    const slug = `zz-verify-${Date.now()}`;
    const { data: made, error: mkErr } = await admin.client.rpc('admin_create_category', {
      p_name: 'ZZ Verify Temp', p_slug: slug, p_description: 'temporary — delete me',
      p_icon: null, p_color: null, p_bg_color: null,
    });
    if (mkErr) { no(`could not create the temp category — ${errMsg(mkErr)}`); }
    else {
      tempId = made.id;
      made.engagement_model === null ? ok('a brand-new category is UNDECIDED (grey by default)')
                                     : no(`a new category arrived with a model: ${made.engagement_model}`);
      made.model_decided_at === null ? ok('and carries no decided-at date') : no('a new category has a decided-at date');

      // The load-bearing one: a rename must not move the slug.
      await admin.client.rpc('admin_update_category', { p_id: tempId, p_name: 'ZZ Verify Renamed', p_slug: null, p_description: 'still here' });
      let r = await modelOf(tempId);
      r.name === 'ZZ Verify Renamed' ? ok('the rename applied') : no(`rename failed — got ${r.name}`);
      r.slug === slug ? ok('🔴 and the SLUG DID NOT MOVE — existing /services/<slug> links survive a rename')
                      : no(`the rename changed the slug ${slug} → ${r.slug}, breaking every link to it`);

      // An explicit slug is normalised the same way create normalises one.
      await admin.client.rpc('admin_update_category', { p_id: tempId, p_name: 'ZZ Verify Renamed', p_slug: '  ZZ Verify  Slug!! ', p_description: 'still here' });
      r = await modelOf(tempId);
      r.slug === 'zz-verify-slug' ? ok(`an explicit slug is normalised (→ ${r.slug})`)
                                  : no(`slug normalisation differs from create's — got ${r.slug}`);

      // A duplicate slug is refused (against a real, existing category).
      const { error: dupErr } = await admin.client.rpc('admin_update_category', { p_id: tempId, p_name: 'ZZ Verify Renamed', p_slug: victim.slug ?? 'beauty' });
      /already exists/i.test(errMsg(dupErr)) ? ok('a duplicate slug is refused')
                                             : no(`a duplicate slug was accepted — ${errMsg(dupErr) || 'NO ERROR'}`);

      // A blank description clears (documented asymmetry with the slug).
      await admin.client.rpc('admin_update_category', { p_id: tempId, p_name: 'ZZ Verify Renamed', p_slug: null, p_description: '   ' });
      r = await modelOf(tempId);
      r.description === null ? ok('a blank description clears it (unlike a blank slug, which keeps)')
                             : no(`a blank description did not clear — got ${JSON.stringify(r.description)}`);

      const { error: delErr } = await admin.client.rpc('admin_delete_category', { p_id: tempId });
      if (delErr) no(`could not clean up the temp category — ${errMsg(delErr)}`);
      else { ok('temp category removed — the run leaves nothing behind'); tempId = null; }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Restore. The victim was a REAL category; it must end the run exactly as it started.
  await service.from('service_categories').update({ engagement_model: original }).eq('id', victim.id);
  const restored = await modelOf(victim.id);
  restored.engagement_model === original
    ? ok(`\n"${victim.name}" restored to ${original ?? 'undecided'}`)
    : no(`\ncould not restore "${victim.name}" — it is now ${restored.engagement_model}, was ${original}`);
  if (tempId) console.log(`  ⚠ leftover temp category ${tempId} — delete it by hand.`);

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail > 0 ? 1 : 0);
};

main().catch((e) => { console.error(e); process.exit(1); });
