/*
  Step-9 UI smoke test — drives a REAL Chrome over the DevTools Protocol.

  Why this exists: every other Step-9 check runs against the database. The application form is a
  client component (upload → RPC → status screen), so a runtime error there would leave the
  feature dead on arrival with every SQL-level test still green. This walks the actual page.

  No new dependencies: Chrome is launched directly and driven with Node's built-in WebSocket.

  It signs in as the applicant, fills the form, uploads a document, submits, and asserts the
  honest pending screen appears — then verifies the row the UI created is born pending/unverified
  and cleans it up.

  Usage (needs `npm run dev` on :3000, and credentials in .env.local — see .env.example. The
  applicant defaults to the CUSTOMER account; override with APPLICANT_EMAIL/APPLICANT_PASSWORD):
    node scripts/ui-check-step9.mjs                  # headless; asserts the camera-degradation path
    LIVE_CAMERA=1 node scripts/ui-check-step9.mjs    # headed; attempts the REAL live capture

  The camera only starts ~1 attempt in 4 on this hardware, so the live path is opt-in rather than
  the default — see the launch-flag comment further down for the measurements behind that.
*/
import { spawn } from 'node:child_process';
import { requireAccounts } from './lib/creds.mjs';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const APP = 'http://localhost:3000';
const { APPLICANT, ADMIN } = requireAccounts([['APPLICANT', 'CUSTOMER'], ['ADMIN', 'STRANGER']]);
const { email: EMAIL, password: PASSWORD } = APPLICANT;
const { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } = ADMIN;

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

function send(method, params = {}, timeout = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, timeout);
  });
}

// Evaluate in the page and return the JSON value. `timeout` is overridable for the one call that
// legitimately blocks longer than the 30s default: the camera probe awaits getUserMedia, which
// takes 10-25s here. Under the default that call intermittently killed the whole run with
// "Runtime.evaluate timed out" — it flaked inside verify-all while passing standalone, which is
// the tell for a timing bug in the harness rather than a fault in the app.
async function evaluate(expression, timeout) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeout);
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
    // generous: a cold dev server compiles the route on first hit (measured ~7s)
    const r = await fetch(APP, { signal: AbortSignal.timeout(45000) });
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
  // Bucket C (14) — the selfie is a LIVE camera capture, so this script has to decide whether a
  // camera can actually start. Measured here over ~10 probe runs (2026-08-08):
  //
  //   • The real webcam takes ~20-25s to start and manages it ROUGHLY 1 TIME IN 4. Failed
  //     attempts reject at ~10s with "AbortError: Timeout starting video source".
  //   • Chrome's synthetic camera (--use-fake-device-for-video-capture) never starts here at
  //     all, so it is deliberately not used — the headed path drives the REAL webcam.
  //   • Neither --disable-gpu nor --disable-features=MojoVideoCapture changes that. The latter
  //     is actively harmful: it caps the attempt at ~10s, below the camera's own start-up time.
  //
  // A headed run is therefore a COIN FLIP, and making `verify-all` depend on one costs ~25-90s,
  // a popup window and a webcam light for a 1-in-4 chance of extra coverage — and turns the
  // suite red for reasons that have nothing to do with the code. Default is HEADLESS, where the
  // camera deterministically cannot start and the run asserts the DEGRADATION path (message +
  // retry + fallback + meta.capture='upload_fallback'), which is the behaviour that must never
  // break: an applicant with no working camera still has to be able to finish.
  //
  //   LIVE_CAMERA=1 opts into the headed attempt when you want the live path exercised.
  //
  // Name the coverage this trades away: a default run does NOT exercise video → canvas → upload.
  // That leg is verified interactively through a real browser (claude-in-chrome), which is the
  // only place it works reliably — see the run recorded in /docs/Seva-Decisions-Log.md.
  //
  // --use-fake-ui-for-media-stream stays either way: it auto-answers the permission prompt, a
  // native browser dialog no script can click.
  const liveCamera = process.env.LIVE_CAMERA === '1';
  chrome = spawn(CHROME, [
    ...(liveCamera ? [] : ['--headless=new']),
    '--remote-debugging-port=9222', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    '--use-fake-ui-for-media-stream',
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
  console.log(`driving real Chrome (${liveCamera ? 'headed, LIVE_CAMERA=1 — a window will appear' : 'headless'}) against ${APP}\n`);

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
  // Bucket C renamed these: the primary slot names the IDs Indians actually hold, the selfie says
  // out loud that it is captured live, and there is one named optional second-ID slot.
  for (const marker of ['Proof of identity', 'Primary photo ID', 'Live selfie', 'Add a second ID']) {
    if (slots.includes(marker)) ok(`category-driven slot appears: “${marker}”`);
    else no(`slot MISSING for this category: “${marker}”`);
  }
  for (const marker of ['Aadhaar', 'Voter ID (EPIC)', 'Driving licence', 'PAN']) {
    if (slots.includes(marker)) ok(`ID option offered: “${marker}”`);
    else no(`ID option MISSING: “${marker}”`);
  }
  // "Driving licence" now also appears as a primary-ID *option*, so the old text match would fire
  // on the picker. Assert on the driver-only SLOTS instead — those are unambiguous.
  if (!/Vehicle RC|Vehicle insurance/.test(slots)) ok('...and an electrician is NOT asked for driving documents');
  else no('electrician was asked for driving documents');
  {
    const aadhaar = slots.indexOf('Aadhaar'), passport = slots.indexOf('Passport');
    if (aadhaar > -1 && passport > aadhaar) ok('...and a passport is offered last, never as the default');
    else no(`ID ordering wrong (Aadhaar at ${aadhaar}, Passport at ${passport})`);
  }

  await fillByLabel('Name customers will see', 'CDP Smoke Electricals');
  await fillByLabel('City', 'Mumbai');
  await fillByLabel('Area you cover', 'Andheri');
  await fillByLabel('Your hourly rate', '450');
  await fillByLabel('Years of experience', '7');
  await fillByLabel('A line about your work', 'Wiring, repairs and installations across the western suburbs.');
  ok('filled every field on the form');

  // Step 9.5: the slots are driven by the CATEGORY. Bucket C: the UPLOAD slots are the primary ID
  // and the optional second ID — the selfie has no file input at all any more, so it is driven
  // through the camera below.
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
  ok(`uploaded ${inputs.length} document(s) to the private bucket from the browser (primary + optional second ID)`);

  // ---- (14) the selfie is CAPTURED, not uploaded ----
  // Which branch to assert is decided by whether a camera can actually START — probed here at the
  // BROWSER level, before the app is touched. That distinction matters: keying off what the app
  // rendered would let a genuinely broken live path quietly "pass" as a degradation, which is
  // exactly the kind of green this suite exists to prevent. A machine with a working camera MUST
  // walk the full capture path or fail; a machine without one asserts the documented fallback and
  // says out loud that the live path went untested.
  // 90s, not the 30s default: a successful start takes ~25s and a failure ~10s, both of which
  // this must be allowed to OBSERVE rather than time out on. Deliberately a single attempt —
  // retrying getUserMedia inside one page does not help (measured: 4 attempts, 4 failures) and
  // leaves the renderer busy enough that the NEXT evaluate times out, converting a clean
  // degradation into a hard error.
  const cameraStarts = await evaluate(`
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then((s) => { s.getTracks().forEach((t) => t.stop()); return true; })
      .catch(() => false)`, 90000);

  if (await clickText('Open camera')) ok('the selfie slot offers a live camera, not a file picker');
  else no('no "Open camera" control on the selfie slot');

  if (cameraStarts) {
    // 60s: the page's own getUserMedia pays the same ~20-25s start-up the probe just did, so the
    // old 20s budget expired BEFORE the camera could possibly have come up — the live branch
    // could never finish even when the camera was working.
    await waitFor("(() => { const v = document.querySelector('video'); return !!v && v.videoWidth > 0; })()",
      { label: 'a live camera preview', timeout: 60000 });
    ok('getUserMedia opened a real video stream inside the page');
    if (await clickText('Take photo')) ok('captured a frame from the stream');
    else no('no "Take photo" control while the camera was live');
    await waitFor("!!document.querySelector('img[alt^=\"The selfie\"]')",
      { label: 'the captured still to review', timeout: 15000 });
    ok('...and the applicant is shown the frame before anything is sent');
    if (await clickText('Use this photo')) ok('accepted the captured photo');
    else no('no "Use this photo" control on the review step');
    await waitFor(
      `(document.body.innerText.match(/ready to submit/g) || []).length >= ${inputs.length + 1}`,
      { label: 'the live selfie to upload', timeout: 45000 });
    ok('the LIVE selfie uploaded to the private bucket — no file was ever chosen for it');
  } else {
    // No camera here. The one thing that must NOT happen is a dead end.
    console.log('  ⚠ no camera could start in this browser — asserting the DEGRADATION path;');
    console.log('    the live capture itself was NOT exercised by this run.');
    await waitFor("/camera|Camera/.test(document.body.innerText) && !!document.querySelector('input[type=file]')",
      { label: 'the camera-failure message and its fallback', timeout: 20000 });
    const body = await text();
    if (/No camera found|couldn.t be started|already in use|blocked/i.test(body))
      ok('a camera that will not start is EXPLAINED, not left silent');
    else no('camera failure produced no explanatory message');
    if (/Try the camera again/.test(body)) ok('...and a retry is offered');
    else no('no retry offered after the camera failed');

    const fallback = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Upload a recent photo instead');
      return !!b;
    })()`);
    if (fallback) ok('...and an upload fallback appears, so the applicant is never stuck');
    else no('no upload fallback after the camera failed — this is a DEAD END');

    // Drive the fallback so the application can still be submitted, and so the flag that tells
    // the reviewer this was not a live capture is proven to be written.
    const doc2 = await send('DOM.getDocument');
    const all = (await send('DOM.querySelectorAll', { nodeId: doc2.root.nodeId, selector: 'input[type=file]' })).nodeIds ?? [];
    await send('DOM.setFileInputFiles', { nodeId: all[all.length - 1], files: [pngPath] });
    await waitFor(
      `(document.body.innerText.match(/ready to submit/g) || []).length >= ${inputs.length + 1}`,
      { label: 'the fallback selfie to upload', timeout: 45000 });
    ok('the fallback photo uploaded — the application can still be completed');
  }

  const submitted = await clickText('Submit application');
  if (!submitted) throw new Error('no "Submit application" button');

  // ---- the honest status screen ----
  console.log('\n[status screen]');
  // NB: the form itself says "A person reviews every application", so waiting on the word
  // "review" matches the page we're trying to leave. Wait for the form to actually be GONE.
  await waitFor("!document.body.innerText.includes('What do you do?') && document.body.innerText.includes('Submitted')",
    { label: 'the pending status screen (form replaced)', timeout: 30000 });
  await sleep(500);
  // The three assertions below share ONE snapshot, and "Your documents" arrives from a checklist
  // fetch that can resolve after the form unmounts — so a fixed 500ms sleep raced it and this
  // failed intermittently. Wait for it specifically; swallow the timeout so a genuine absence is
  // still reported by the assertion rather than aborting the run.
  await waitFor("/Your documents/i.test(document.body.innerText)",
    { label: 'the document checklist', timeout: 15000 }).catch(() => {});
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
      .select('doc_code, verification_status, file_path, meta').eq('provider_id', providerId);
    const codes = (pdocs ?? []).map((d) => d.doc_code).sort();
    if (codes.join(',') === 'id_secondary,photo_id,selfie')
      ok('all three captures were recorded as TYPED documents (photo_id, id_secondary, selfie)');
    else no('documents not recorded as typed rows: ' + JSON.stringify(codes));
    // Bucket C (10/16): each document must say WHAT it is, or a labeled slot buys the reviewer
    // nothing. (14): the selfie must be marked as captured live, not uploaded.
    const primary = (pdocs ?? []).find((d) => d.doc_code === 'photo_id');
    const selfie = (pdocs ?? []).find((d) => d.doc_code === 'selfie');
    if (primary?.meta?.id_type) ok(`the primary ID is labeled with which ID it is (${primary.meta.id_type})`);
    else no('the primary ID carries no id_type — the reviewer sees an unlabelled file');
    // The flag must match what actually happened. Recording a fallback as 'live' would be worse
    // than not recording it at all — it would tell the reviewer someone was present when nobody was.
    const wantCapture = cameraStarts ? 'live' : 'upload_fallback';
    if (selfie?.meta?.capture === wantCapture)
      ok(`the selfie is recorded as ${wantCapture === 'live' ? 'captured LIVE' : 'an UPLOAD FALLBACK, not as live'}`);
    else no(`selfie capture flag is ${JSON.stringify(selfie?.meta)} (expected ${wantCapture})`);
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
