/*
  Step-10 UI smoke test — drives a REAL Chrome over the DevTools Protocol.

  Why this exists: verify-step10.mjs proves the bargaining RULES in the database. It cannot prove
  the three pieces of UI the step is actually judged on, and a runtime error in any of them would
  leave the feature dead on arrival with every SQL check still green:

    1. the provider's Pricing card on /become-provider — including the PRIVATE floor input;
    2. "Make an offer" sitting BESIDE "Book at ₹X" on /providers/[id], never replacing it;
    3. the negotiation panel on /bookings/[id] — round history, whose turn, accept/counter/decline.

  It also asserts the floor never reaches the customer's browser: not in the page text, and not in
  any JSON the page fetched.

  No new dependencies: Chrome is launched directly and driven with Node's built-in WebSocket.
  The harness (CDP plumbing, React-aware input filling, the hydration-safe sign-in) is the one
  from ui-check-step9.mjs.

  Usage (needs `npm run dev` on :3000, and CUSTOMER_/PROVIDER_ credentials in .env.local — see
  .env.example):
    node scripts/ui-check-step10.mjs
*/
import { spawn } from 'node:child_process';
import { requireAccounts } from './lib/creds.mjs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const APP = 'http://localhost:3000';
const { PROVIDER, CUSTOMER } = requireAccounts(['PROVIDER', 'CUSTOMER']);
const { email: PROVIDER_EMAIL, password: PROVIDER_PASSWORD } = PROVIDER;
const { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD } = CUSTOMER;

const LIST = 600, FLOOR = 400, THRESHOLD = 550, OFFER = 450;   // OFFER sits between floor and threshold

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

const REACT_SET = `
function reactSet(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}`;

// Fill the input that follows a given <label>, matched on its visible text.
async function fillByLabel(labelText, value) {
  const expr = `(() => {
    ${REACT_SET}
    const label = [...document.querySelectorAll('label')].find(l => l.textContent.trim().startsWith(${JSON.stringify(labelText)}));
    if (!label) return 'no label';
    const field = label.parentElement.querySelector('input, textarea');
    if (!field) return 'no field';
    reactSet(field, ${JSON.stringify(String(value))});
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

const clickContaining = (t) => evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(t)}));
  if (!el) return false;
  el.click(); return true;
})()`);

const SESSION = "!!localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sb-')) || '')";

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

// Record every response body the page receives, so we can prove the floor is in none of them.
const responses = [];
function watchNetwork() {
  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Network.responseReceived' && /supabase|localhost/.test(msg.params?.response?.url ?? '')) {
      responses.push(msg.params.requestId);
    }
  });
}

// ---------------------------------------------------------------- run
let chrome = null, providerId = null, providerUser = null, customerId = null, original = null;
const bookingIds = [];
try {
  if (!CHROME) { console.log('Cannot run: Chrome not found.'); process.exit(0); }
  try {
    // generous: a cold dev server compiles the route on first hit (measured ~7s)
    const r = await fetch(APP, { signal: AbortSignal.timeout(45000) });
    if (!r.ok && r.status >= 500) throw new Error('bad status');
  } catch { console.log('Cannot run: dev server not answering on :3000 — start `npm run dev`.'); process.exit(0); }

  const { data: { users } } = await service.auth.admin.listUsers({ perPage: 200 });
  providerUser = users.find((u) => u.email === PROVIDER_EMAIL)?.id;
  customerId = users.find((u) => u.email === CUSTOMER_EMAIL)?.id;
  if (!providerUser || !customerId) { console.log('Cannot run: test accounts not found.'); process.exit(1); }

  const { data: sp } = await service.from('service_providers')
    .select('id, pricing_mode, list_price, floor_price, auto_accept_threshold, max_counter_rounds, hourly_rate, status')
    .eq('user_id', providerUser).eq('status', 'approved').maybeSingle();
  if (!sp) { console.log('Cannot run: the provider account owns no approved provider row.'); process.exit(1); }
  providerId = sp.id;
  original = { pricing_mode: sp.pricing_mode, list_price: sp.list_price, floor_price: sp.floor_price,
               auto_accept_threshold: sp.auto_accept_threshold, max_counter_rounds: sp.max_counter_rounds };

  // start from 'fixed', so the "Make an offer" button appearing later is caused by the UI edit
  await service.from('service_providers')
    .update({ pricing_mode: 'fixed', list_price: LIST, floor_price: null, auto_accept_threshold: null })
    .eq('id', providerId);
  // clear the anti-probe cap so the offer below is not rate-limited by earlier runs
  const clearNegotiations = async () => {
    const { data } = await service.from('bookings').select('id')
      .eq('customer_id', customerId).eq('provider_id', providerId).in('status', ['negotiating', 'expired']);
    for (const b of data ?? []) {
      await service.from('booking_events').delete().eq('booking_id', b.id);
      await service.from('bookings').delete().eq('id', b.id);
    }
  };
  await clearNegotiations();

  const profile = mkdtempSync(join(tmpdir(), 'seva-cdp10-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9223', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
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
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  watchNetwork();
  console.log('driving real Chrome (headless) against ' + APP + '\n');

  // ================= 1) the provider sets their pricing =================
  console.log('[provider: the Pricing card]');
  await signInAs(PROVIDER_EMAIL, PROVIDER_PASSWORD, 'the provider');
  ok('signed in as the provider through the real form');

  await evaluate(`window.location.assign('/become-provider')`);
  await waitFor("document.body.innerText.includes('Your pricing')", { label: 'the Pricing card', timeout: 25000 });
  await sleep(2000);   // let fetchMyPricing resolve
  ok('the approved provider sees a "Your pricing" card');

  const before = await text();
  // NB case-insensitive: the buttons carry Tailwind's `capitalize`, so innerText reads back
  // "Open To Offers" even though the DOM text is "Open to offers".
  if (/Open to offers/i.test(before) && /Fixed price/i.test(before)) ok('...offering both "Fixed price" and "Open to offers"');
  else no('pricing mode buttons missing: ' + before.slice(0, 300));

  // switching to negotiable must reveal the private-floor controls
  if (await clickText('Open to offers')) ok('clicked "Open to offers"');
  else no('could not click "Open to offers"');
  await sleep(400);
  const negotiableText = await text();
  if (/never shown to anyone/i.test(negotiableText))
    ok('the floor input is labelled as private ("never shown to anyone")');
  else no('the private-floor labelling is missing: ' + negotiableText.slice(0, 400));

  await fillByLabel('Your listed price', LIST);
  await fillByLabel('Accept instantly at or above', THRESHOLD);
  await fillByLabel('Your minimum', FLOOR);
  if (await clickText('Save pricing')) ok('submitted the pricing form');
  else no('no "Save pricing" button');
  await sleep(2500);

  const { data: saved } = await service.from('service_providers')
    .select('pricing_mode, list_price, floor_price, auto_accept_threshold').eq('id', providerId).maybeSingle();
  if (saved.pricing_mode === 'negotiable' && Number(saved.list_price) === LIST
      && Number(saved.floor_price) === FLOOR && Number(saved.auto_accept_threshold) === THRESHOLD)
    ok(`the UI wrote pricing through to the DB (list ₹${saved.list_price}, floor ₹${saved.floor_price}, instant ₹${saved.auto_accept_threshold})`);
  else no('pricing did not save: ' + JSON.stringify(saved));

  // ================= 2) the customer's offer path =================
  console.log('\n[customer: "Make an offer" beside "Book at ₹X"]');
  await signInAs(CUSTOMER_EMAIL, CUSTOMER_PASSWORD, 'the customer');
  ok('signed in as the customer');

  await evaluate(`window.location.assign('/providers/${providerId}')`);
  await waitFor("document.body.innerText.includes('Make an offer')", { label: 'the offer button', timeout: 25000 });
  await sleep(1200);
  const providerPage = await text();

  if (/Book at ₹/.test(providerPage)) ok('the one-tap "Book at ₹X" path is still the default');
  else no('"Book at ₹X" is missing — the hurried customer lost the default path');
  if (/Make an offer/.test(providerPage)) ok('..."Make an offer" sits beside it');
  else no('"Make an offer" missing for a negotiable provider');

  // 🔴 the floor must not be anywhere in what the customer's browser received
  if (!new RegExp(`\\b${FLOOR}\\b`).test(providerPage)) ok(`the floor (₹${FLOOR}) appears nowhere in the page text`);
  else no(`🔴 the floor ₹${FLOOR} is visible on the provider page`);

  const leakedInState = await evaluate(`(() => {
    const hay = JSON.stringify(window.__NEXT_DATA__ ?? {}) + document.documentElement.innerHTML;
    return /floor_price/.test(hay);
  })()`);
  if (!leakedInState) ok('...and "floor_price" appears in no serialized page state');
  else no('🔴 floor_price is present in the page payload');

  // make the offer
  if (await clickContaining('Make an offer')) ok('opened the offer sheet');
  else no('could not open the offer sheet');
  await sleep(600);
  await evaluate(`(() => {
    ${REACT_SET}
    const input = [...document.querySelectorAll('input[type=number]')].pop();
    if (!input) return false;
    reactSet(input, '${OFFER}');
    return true;
  })()`);
  await sleep(300);
  if (await clickText('Send offer')) ok(`sent an offer of ₹${OFFER}`);
  else no('no "Send offer" button');

  // ================= 3) the negotiation panel =================
  console.log('\n[both: the negotiation panel on the booking]');
  await waitFor("location.pathname.startsWith('/bookings/')", { label: 'the booking page', timeout: 25000 });
  await sleep(2500);
  const bookingPath = await evaluate('location.pathname');
  const bookingId = bookingPath.split('/').pop();
  bookingIds.push(bookingId);
  ok('the offer landed the customer on their booking: ' + bookingPath);

  const panel = await text();
  if (/Price under negotiation/i.test(panel)) ok('the negotiation panel is shown');
  else no('no negotiation panel: ' + panel.slice(0, 400));
  if (new RegExp(`Round 1`).test(panel) && new RegExp(`₹${OFFER}`).test(panel))
    ok(`the round history shows "Round 1 … ₹${OFFER}"`);
  else no('round history missing: ' + panel.slice(0, 400));
  if (/Waiting on the provider/i.test(panel)) ok('...and it says whose turn it is (waiting on the provider)');
  else no('turn indicator missing/wrong: ' + panel.slice(0, 400));
  if (/expires in \d+h/i.test(panel)) ok('...and shows the expiry countdown');
  else no('expiry countdown missing');

  // the customer must NOT be able to answer their own offer
  const customerButtons = await evaluate(`[...document.querySelectorAll('button')].map(b => b.textContent.trim())`);
  if (!customerButtons.some((b) => /^Accept ₹/.test(b))) ok('the customer is not offered an Accept button on their own offer');
  else no('the customer can accept their own offer in the UI');

  // now the provider's side: the buttons must be live
  console.log('\n[provider: it is their turn]');
  await signInAs(PROVIDER_EMAIL, PROVIDER_PASSWORD, 'the provider');
  await evaluate(`window.location.assign('/bookings/${bookingId}')`);
  await waitFor("document.body.innerText.includes('Price under negotiation')", { label: 'the panel as provider', timeout: 25000 });
  await sleep(1500);
  const provPanel = await text();
  if (/Your move/i.test(provPanel)) ok('the provider is told it is their move');
  else no('provider turn indicator missing: ' + provPanel.slice(0, 300));

  const provButtons = await evaluate(`[...document.querySelectorAll('button')].map(b => b.textContent.trim())`);
  const hasAccept = provButtons.some((b) => new RegExp(`Accept ₹${OFFER}`).test(b));
  const hasCounter = provButtons.some((b) => /^Counter$/.test(b));
  const hasDecline = provButtons.some((b) => /^Decline$/.test(b));
  if (hasAccept && hasCounter && hasDecline) ok('accept / counter / decline are all offered — structured buttons, no price chat');
  else no(`the three actions are not all present: ${JSON.stringify(provButtons)}`);

  // 🔴 the floor must not reach the provider's OWN booking page either (it is not needed there)
  if (!new RegExp(`\\b${FLOOR}\\b`).test(provPanel)) ok(`the floor (₹${FLOOR}) is not printed on the booking page`);
  else no(`the floor ₹${FLOOR} leaked onto the booking page`);

  // accept, and confirm the price locks in the UI
  if (await clickContaining(`Accept ₹${OFFER}`)) ok('provider clicked Accept');
  else no('could not click Accept');
  await sleep(3000);
  const { data: settled } = await service.from('bookings')
    .select('status, price_agreed').eq('id', bookingId).maybeSingle();
  if (settled.status === 'accepted' && Number(settled.price_agreed) === OFFER)
    ok(`accepting in the UI locked the price server-side (₹${settled.price_agreed}, status ${settled.status})`);
  else no('the accept did not settle the booking: ' + JSON.stringify(settled));

  // ================= 4) a fixed-price provider shows no offer path =================
  console.log('\n[a fixed-price provider offers no haggling]');
  await service.from('service_providers').update({ pricing_mode: 'fixed' }).eq('id', providerId);
  await signInAs(CUSTOMER_EMAIL, CUSTOMER_PASSWORD, 'the customer');
  await evaluate(`window.location.assign('/providers/${providerId}')`);
  await waitFor("document.body.innerText.includes('Book at ₹')", { label: 'the booking card', timeout: 25000 });
  await sleep(1500);
  const fixedPage = await text();
  if (!/Make an offer/.test(fixedPage)) ok('no "Make an offer" button for a fixed-price provider');
  else no('a fixed-price provider still shows "Make an offer"');

  const pageErrors = await evaluate(`window.__seva_errors ? window.__seva_errors.length : 0`);
  if (!pageErrors) ok('no uncaught page errors during the flow');
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
} finally {
  console.log('\n[cleanup]');
  for (const id of bookingIds) {
    await service.from('notifications').delete().like('link', `/bookings/${id}%`);
    await service.from('booking_events').delete().eq('booking_id', id);
    await service.from('bookings').delete().eq('id', id);
  }
  if (providerId) {
    const { data } = await service.from('bookings').select('id')
      .eq('customer_id', customerId).eq('provider_id', providerId).in('status', ['negotiating', 'expired']);
    for (const b of data ?? []) {
      await service.from('booking_events').delete().eq('booking_id', b.id);
      await service.from('bookings').delete().eq('id', b.id);
    }
    await service.from('notifications').delete().eq('user_id', customerId).like('link', `/providers/${providerId}%`);
    if (original) await service.from('service_providers').update(original).eq('id', providerId);
    console.log('  negotiations removed; the provider\'s original pricing restored.');
  }
  try { ws?.close(); } catch {}
  try { chrome?.kill(); } catch {}
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
