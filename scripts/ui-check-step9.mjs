/*
  Step-9 UI smoke test — drives a REAL Chrome over the DevTools Protocol.

  Why this exists: every other Step-9 check runs against the database. The application form is a
  client component (upload → RPC → status screen), so a runtime error there would leave the
  feature dead on arrival with every SQL-level test still green. This walks the actual page.

  No new dependencies: Chrome is launched directly and driven with Node's built-in WebSocket.

  It signs in as the applicant, fills the form, uploads a document, submits, and asserts the
  honest pending screen appears — then verifies the row the UI created is born pending/unverified
  and cleans it up.

  Usage (needs `npm run dev` on :3000):
    APPLICANT_EMAIL=test2@gmail.com APPLICANT_PASSWORD=test2@9271 node scripts/ui-check-step9.mjs
*/
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const APP = 'http://localhost:3000';
const EMAIL = process.env.APPLICANT_EMAIL ?? 'test2@gmail.com';
const PASSWORD = process.env.APPLICANT_PASSWORD ?? 'test2@9271';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'test3@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'test3@9271';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => { try { readFileSync(p); return true; } catch { return false; } });

// a real 1x1 PNG so the browser reports image/png and the bucket accepts it
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// ---------------------------------------------------------------- CDP plumbing
let ws = null, msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, 30000);
  });
}

// Evaluate in the page and return the JSON value.
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page JS error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
}

async function waitFor(expression, { timeout = 20000, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return true; } catch { /* mid-navigation */ }
    await sleep(300);
  }
  throw new Error('timed out waiting for: ' + label);
}

const text = () => evaluate('document.body ? document.body.innerText : ""');

// React tracks its own value on inputs; a plain .value assignment is ignored. Use the native
// setter then dispatch, which is what a real keystroke ends up doing.
const REACT_SET = `
function reactSet(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}`;

async function fillByLabel(labelText, value) {
  const expr = `(() => {
    ${REACT_SET}
    const label = [...document.querySelectorAll('label')].find(l => l.textContent.trim().startsWith(${JSON.stringify(labelText)}));
    if (!label) return 'no label';
    const field = label.parentElement.querySelector('input, textarea');
    if (!field) return 'no field';
    reactSet(field, ${JSON.stringify(value)});
    return 'ok';
  })()`;
  const r = await evaluate(expr);
  if (r !== 'ok') throw new Error(`could not fill "${labelText}": ${r}`);
}

const clickText = (t) => evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)});
  if (!el) return false;
  el.click(); return true;
})()`);

const SESSION = "!!localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sb-')) || '')";

// The inputs exist in the server-rendered HTML before React hydrates, so filling the moment they
// appear dispatches into a component with no listeners yet and the form submits empty. Settle,
// fill, submit — and retry until a session actually lands.
async function signInAs(email, password, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await evaluate("localStorage.clear()").catch(() => {});
    await send('Page.navigate', { url: `${APP}/auth/signin` });
    await waitFor("!!document.querySelector('input[type=password]')", { label: 'the sign-in form' });
    await sleep(2500); // let React hydrate and attach its handlers
    await evaluate(`(() => {
      ${REACT_SET}
      const em = document.querySelector('input[type=email]') || document.querySelectorAll('input')[0];
      const pw = document.querySelector('input[type=password]');
      reactSet(em, ${JSON.stringify(email)});
      reactSet(pw, ${JSON.stringify(password)});
      return true;
    })()`);
    await evaluate(`(() => { const f = document.querySelector('form'); if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); return true; }
      const b = [...document.querySelectorAll('button')].find(x => /sign in/i.test(x.textContent)); if (b) { b.click(); return true; } return false; })()`);
    try { await waitFor(SESSION, { label: 'a stored Supabase session', timeout: 12000 }); return true; }
    catch { /* hydration lost the race — try again */ }
  }
  throw new Error(`could not sign in as ${label} through the UI after 3 attempts`);
}

// ---------------------------------------------------------------- run
let chrome = null, providerId = null;
let docPaths = [];
try {
  if (!CHROME) { console.log('Cannot run: Chrome not found.'); process.exit(0); }
  try {
    const r = await fetch(APP, { signal: AbortSignal.timeout(5000) });
    if (!r.ok && r.status >= 500) throw new Error('bad status');
  } catch { console.log('Cannot run: dev server not answering on :3000 — start `npm run dev`.'); process.exit(0); }

  const { data: { users } } = await service.auth.admin.listUsers({ perPage: 200 });
  const applicant = users.find((u) => u.email === EMAIL);
  if (!applicant) { console.log(`Cannot run: ${EMAIL} not found.`); process.exit(1); }
  const existing = await service.from('service_providers').select('id').eq('user_id', applicant.id).maybeSingle();
  if (existing.data) {
    const { count } = await service.from('bookings').select('id', { count: 'exact', head: true }).eq('provider_id', existing.data.id);
    if (count > 0) { console.log('Cannot run: applicant already owns a provider row with bookings.'); process.exit(1); }
    await service.from('service_providers').delete().eq('id', existing.data.id);
  }

  const profile = mkdtempSync(join(tmpdir(), 'seva-cdp-'));
  const pngPath = join(profile, 'test-id.png');
  writeFileSync(pngPath, PNG);
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9222', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome did not expose a debugging target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
  console.log('driving real Chrome (headless) against ' + APP + '\n');

  // ---- sign in through the actual form ----
  console.log('[sign in]');
  await signInAs(EMAIL, PASSWORD, 'the applicant');
  ok('signed in through the real sign-in form');

  // ---- the application form ----
  console.log('\n[/become-provider renders]');
  await evaluate(`window.location.assign('/become-provider')`);
  await waitFor("document.body.innerText.includes('What do you do?')", { label: 'the application form', timeout: 25000 });
  await sleep(2500); // hydration + the categories fetch
  const body = await text();
  // Step 9.5: the document slots are category-driven, so they only appear after a category is
  // chosen — asserted below, once one is picked.
  for (const marker of ['Work for yourself', 'What do you do?', 'Name customers will see']) {
    if (body.includes(marker)) ok(`form renders: “${marker}”`);
    else no(`form is MISSING: “${marker}”`);
  }
  const catCount = await evaluate("document.querySelectorAll('button').length");
  if (catCount > 10) ok(`category chips loaded from the DB (${catCount} buttons on the page)`);
  else no(`category chips did not load (only ${catCount} buttons)`);

  // ---- fill it in ----
  console.log('\n[fill + upload + submit]');
  const picked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Electrician');
    if (!btn) return null; btn.click(); return btn.textContent.trim();
  })()`);
  if (picked) ok(`picked a category chip (${picked})`);
  else no('could not pick a category chip');

  // The requirements are fetched after the chip is clicked, so wait for an actual SLOT — the
  // "Proof of identity" heading renders instantly and would let us read an empty section.
  await waitFor("document.querySelectorAll('input[type=file]').length > 0",
    { label: 'the category\'s document slots', timeout: 20000 });
  await sleep(500);
  const slots = await text();
  for (const marker of ['Proof of identity', 'Government photo ID', 'Selfie']) {
    if (slots.includes(marker)) ok(`category-driven slot appears: “${marker}”`);
    else no(`slot MISSING for this category: “${marker}”`);
  }
  if (!/Driving licence|Vehicle RC/.test(slots)) ok('...and an electrician is NOT asked for a driving licence');
  else no('electrician was asked for driving documents');

  await fillByLabel('Name customers will see', 'CDP Smoke Electricals');
  await fillByLabel('City', 'Mumbai');
  await fillByLabel('Area you cover', 'Andheri');
  await fillByLabel('Your hourly rate', '450');
  await fillByLabel('Years of experience', '7');
  await fillByLabel('A line about your work', 'Wiring, repairs and installations across the western suburbs.');
  ok('filled every field on the form');

  // Step 9.5: the slots are driven by the CATEGORY, so there is one file input per required
  // document (an electrician needs a photo ID and a selfie). Fill every one of them.
  const doc = await send('DOM.getDocument');
  const nodes = await send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  const inputs = nodes.nodeIds ?? [];
  if (inputs.length === 0) throw new Error('no file inputs on the page');
  for (const nodeId of inputs) {
    await send('DOM.setFileInputFiles', { nodeId, files: [pngPath] });
    await sleep(1500); // each upload hits storage
  }
  await waitFor(
    `(document.body.innerText.match(/ready to submit/g) || []).length >= ${inputs.length}`,
    { label: `all ${inputs.length} documents to upload`, timeout: 45000 });
  ok(`uploaded ${inputs.length} required document(s) to the private bucket from the browser`);

  const submitted = await clickText('Submit application');
  if (!submitted) throw new Error('no "Submit application" button');

  // ---- the honest status screen ----
  console.log('\n[status screen]');
  // NB: the form itself says "A person reviews every application", so waiting on the word
  // "review" matches the page we're trying to leave. Wait for the form to actually be GONE.
  await waitFor("!document.body.innerText.includes('What do you do?') && document.body.innerText.includes('Submitted')",
    { label: 'the pending status screen (form replaced)', timeout: 30000 });
  await sleep(500);
  const after = await text();
  if (/Submitted — reviewed within 24–48 hours|reviewed within 24/i.test(after)) ok('pending screen says “Submitted — reviewed within 24–48 hours”');
  else no('pending screen copy not found. Body was:\n' + after.slice(0, 400));
  if (after.includes('CDP Smoke Electricals')) ok('the status screen reflects what was submitted');
  else no('submitted details missing from the status screen');
  if (/Your documents/i.test(after)) ok('the status screen lists the documents this category needs');
  else no('document checklist missing from the status screen');
  if (/Your work history/i.test(after)) ok('...and offers to add verifiable work history');

  // ---- and the row the UI created is born pending ----
  console.log('\n[what the UI actually wrote]');
  const { data: row } = await service.from('service_providers')
    .select('id, business_name, status, is_verified, kyc_status, kyc_documents, hourly_rate, experience_years, city, address')
    .eq('user_id', applicant.id).maybeSingle();
  if (!row) { no('the UI did not create a provider row'); }
  else {
    providerId = row.id;
    // every uploaded file, so cleanup removes them all (the form uploads one per required doc)
    docPaths = (row.kyc_documents ?? []).map((d) => d?.path).filter(Boolean);
    if (row.status === 'pending' && row.is_verified === false && row.kyc_status === 'submitted')
      ok('the row is born pending + unverified + kyc submitted — through the real UI');
    else no('row state wrong: ' + JSON.stringify(row));
    if (row.business_name === 'CDP Smoke Electricals' && Number(row.hourly_rate) === 450 && Number(row.experience_years) === 7 && row.city === 'Mumbai')
      ok('every typed field persisted correctly (name, rate, experience, city)');
    else no('fields did not persist: ' + JSON.stringify(row));
    // Step 9.5: documents are typed rows now, one per required doc_code — born unverified.
    const { data: pdocs } = await service.from('provider_documents')
      .select('doc_code, verification_status, file_path').eq('provider_id', providerId);
    const codes = (pdocs ?? []).map((d) => d.doc_code).sort();
    if (codes.join(',') === 'photo_id,selfie')
      ok('both uploads were recorded as TYPED documents (photo_id, selfie)');
    else no('documents not recorded as typed rows: ' + JSON.stringify(codes));
    if ((pdocs ?? []).every((d) => d.verification_status === 'pending'))
      ok('...and each is born pending — the browser cannot self-verify a document');
    else no('a document was not born pending: ' + JSON.stringify(pdocs));
  }

  // ---- reload: the status must survive, driven by the row ----
  await evaluate(`window.location.assign('/become-provider')`);
  await waitFor("document.body.innerText.includes('Submitted') || document.body.innerText.includes('Under review') || document.body.innerText.includes('reviewed within')",
    { label: 'the status screen after a reload', timeout: 25000 });
  ok('the status survives a full page reload (driven by the row, not local state)');

  // ---- the admin half: queue → detail → Approve, all through the real console ----
  console.log('\n[admin console]');
  await signInAs(ADMIN_EMAIL, ADMIN_PASSWORD, 'the admin');
  await evaluate(`window.location.assign('/admin/providers')`);
  await waitFor("document.body.innerText.includes('Provider Applications')", { label: 'the admin queue', timeout: 25000 });
  // the queue comes from the service-role route, which the dev server compiles on first hit
  await waitFor("!document.body.innerText.includes('Loading applications')",
    { label: 'the queue fetch to finish', timeout: 45000 });
  await sleep(500);
  const queue = await text();
  if (queue.includes('CDP Smoke Electricals')) ok('the application appears in the admin queue');
  else no('application missing from the queue. Body:\n' + queue.slice(0, 400));
  if (/To review/i.test(queue)) ok('the queue shows a “To review” tab');

  const opened = await evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find(a => a.textContent.includes('CDP Smoke Electricals'));
    if (!link) return false; link.click(); return true;
  })()`);
  if (!opened) throw new Error('could not open the application from the queue');
  await waitFor("document.body.innerText.includes('Documents for')", { label: 'the application detail page', timeout: 25000 });
  await sleep(1500);
  const detail = await text();
  for (const marker of ['CDP Smoke Electricals', 'Documents for', 'Decision']) {
    if (detail.includes(marker)) ok(`detail page shows “${marker}”`);
    else no(`detail page missing “${marker}”`);
  }
  if (detail.includes(EMAIL)) ok("the applicant's identity is shown to the admin (email)");
  const docLink = await evaluate(`[...document.querySelectorAll('a')].filter(a => /kyc-docs|supabase/.test(a.href)).length`);
  if (docLink > 0) ok('the KYC document is linked via a signed URL');
  else no('no signed document link on the detail page');

  // Step 9.5: Approve is disabled until every required document is verified.
  const blockedBefore = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Approve');
    return b ? b.disabled : null;
  })()`);
  if (blockedBefore === true) ok('Approve is DISABLED while required documents are unverified');
  else no('Approve was not gated on the documents (disabled=' + blockedBefore + ')');

  // verify each document the way an admin would
  let verifyClicks = 0;
  for (let i = 0; i < 6; i++) {
    const clicked = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Verify');
      if (!b) return false; b.click(); return true;
    })()`);
    if (!clicked) break;
    verifyClicks++;
    await sleep(2500); // the page reloads its detail after each decision
  }
  if (verifyClicks > 0) ok(`admin verified ${verifyClicks} document(s) from the console`);
  else no('no Verify buttons found on the detail page');

  await waitFor(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Approve'); return b && !b.disabled; })()`,
    { label: 'Approve to become enabled', timeout: 20000 });
  ok('...and Approve unlocks once they are all verified');

  const approved = await clickText('Approve');
  if (!approved) throw new Error('no Approve button');
  await sleep(4000);
  const { data: afterApprove } = await service.from('service_providers')
    .select('status, is_verified, kyc_status').eq('id', providerId).maybeSingle();
  if (afterApprove?.status === 'approved' && afterApprove?.is_verified === true && afterApprove?.kyc_status === 'verified')
    ok('clicking Approve in the real console made the provider approved + verified');
  else no('Approve did not flip the row: ' + JSON.stringify(afterApprove));

  // ---- and the provider now sees "You're live" ----
  console.log('\n[the provider sees the result]');
  await signInAs(EMAIL, PASSWORD, 'the applicant');
  await evaluate(`window.location.assign('/become-provider')`);
  await waitFor("!document.body.innerText.includes('What do you do?') && /You're live/i.test(document.body.innerText)",
    { label: 'the approved status screen', timeout: 25000 });
  await sleep(500);
  const liveText = await text();
  if (/You're live/i.test(liveText)) ok('the approved provider sees “You\'re live.”');
  else no('approved screen copy not found. Body:\n' + liveText.slice(0, 300));
  if (/public profile/i.test(liveText)) ok('...with a link to their public profile');

  // ---- no console errors ----
  const errs = await evaluate("(window.__sevaErrors || []).length");
  if (!errs) ok('no uncaught page errors during the flow');
} catch (e) {
  no('unexpected error: ' + (e?.message ?? e));
} finally {
  console.log('\n[cleanup]');
  if (docPaths.length) await service.storage.from('kyc-docs').remove(docPaths);
  if (providerId) {
    await service.from('service_providers').delete().eq('id', providerId);
    // approving/rejecting notifies the provider — drop what this run generated
    const { data: { users: all } } = await service.auth.admin.listUsers({ perPage: 200 });
    const uid = all.find((u) => u.email === EMAIL)?.id;
    if (uid) await service.from('notifications').delete().eq('user_id', uid).eq('link', '/become-provider');
    console.log('  removed the application, its document and its notifications');
  }
  try { ws?.close(); } catch {}
  try { chrome?.kill(); } catch {}
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
