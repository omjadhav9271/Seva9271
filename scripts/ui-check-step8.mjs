/*
  Step-8 UI smoke test — drives a REAL Chrome over the DevTools Protocol.

  Why this exists: verify-step8.mjs proves the dispute RULES in the database (who may raise, who
  may resolve, where the money lands). It cannot prove the three screens the step is actually
  judged on, and a runtime error in any of them would leave disputes unusable with every SQL
  check still green:

    1. "Report a problem with this booking" on /bookings/[id] — the only way into 'disputed';
    2. /admin/disputes — the queue, and that a NON-admin party never reaches it;
    3. /admin/disputes/[id] — the evidence bundle (timeline, chat, ledger, both parties'
       contacts) and the resolution panel that moves real money.

  It also asserts the 🔴 invariant Step 8 exists to protect: the reputation penalty follows
  FAULT, not the mere existence of a dispute — resolving against the CUSTOMER must leave the
  provider's score unharmed.

  The booking is seeded and torn down by this script (wallet movement reversed, reputations
  recomputed), so it leaves the project exactly as it found it. Same harness as
  ui-check-step9/10: no new dependencies, Chrome driven with Node's built-in WebSocket.

  Usage (needs `npm run dev` on :3000, and CUSTOMER_/PROVIDER_/ADMIN_ credentials in .env.local —
  see .env.example):
    node scripts/ui-check-step8.mjs
*/
import { spawn } from 'node:child_process';
import { requireAccounts, listAllUsers } from './lib/creds.mjs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const APP = 'http://localhost:3000';
const { CUSTOMER, PROVIDER, ADMIN } = requireAccounts(['CUSTOMER', 'PROVIDER', ['ADMIN', 'STRANGER']]);
const { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD } = CUSTOMER;
const { email: PROVIDER_EMAIL, password: PROVIDER_PASSWORD } = PROVIDER;
const { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } = ADMIN;

const TAG = 'STEP8-UI-CHECK';
const AMOUNT = 800;              // ₹ charged and held in escrow
const REASON = 'work_not_done';
const REASON_LABEL = 'Work not done';         // admin-side label (lib/admin REASON_LABELS)
const REASON_LABEL_PARTY = 'Work was not done'; // customer-side label (booking page)

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
const money = (n) => Number(n).toLocaleString('en-IN');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => { try { readFileSync(p); return true; } catch { return false; } });

// ---------------------------------------------------------------- CDP plumbing
let ws = null, msgId = 0;
const pending = new Map();
const pageExceptions = [];

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
}
function reactSelect(el, value) {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}`;

// Set the Nth <select> on the page (React-aware). Returns the value it ended up holding.
async function selectNth(index, value) {
  const r = await evaluate(`(() => {
    ${REACT_SET}
    const el = document.querySelectorAll('select')[${index}];
    if (!el) return 'no select';
    if (![...el.options].some(o => o.value === ${JSON.stringify(value)})) return 'no option ' + ${JSON.stringify(value)};
    reactSelect(el, ${JSON.stringify(value)});
    return 'ok';
  })()`);
  if (r !== 'ok') throw new Error(`could not select "${value}" on select #${index}: ${r}`);
}

const selectValue = (index) => evaluate(`(() => {
  const el = document.querySelectorAll('select')[${index}];
  return el ? el.value : null;
})()`);

async function fillTextarea(value) {
  const r = await evaluate(`(() => {
    ${REACT_SET}
    const el = document.querySelector('textarea');
    if (!el) return 'no textarea';
    reactSet(el, ${JSON.stringify(value)});
    return 'ok';
  })()`);
  if (r !== 'ok') throw new Error('could not fill the textarea: ' + r);
}

const clickText = (t) => evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)});
  if (!el) return false;
  el.click(); return true;
})()`);

const clickContaining = (t) => evaluate(`(() => {
  const el = [...document.querySelectorAll('button, a')].find(b => b.textContent.includes(${JSON.stringify(t)}));
  if (!el) return false;
  el.click(); return true;
})()`);

const SESSION = "!!localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sb-')) || '')";

async function signInAs(email, password, label) {
  let lastState = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    await evaluate("localStorage.clear()").catch(() => {});
    await send('Page.navigate', { url: `${APP}/auth/signin` });
    await waitFor("!!document.querySelector('input[type=password]')", { label: 'the sign-in form', timeout: 60000 });
    await sleep(2500); // let React hydrate and attach its handlers

    // Fill, then read the values BACK. Before hydration the native setter writes the DOM but React
    // holds no state, and re-rendering wipes it — so a value that survives is the hydration proof.
    let filled = false;
    for (let i = 0; i < 12 && !filled; i++) {
      filled = await evaluate(`(() => {
        ${REACT_SET}
        const em = document.querySelector('input[type=email]') || document.querySelectorAll('input')[0];
        const pw = document.querySelector('input[type=password]');
        if (!em || !pw) return false;
        reactSet(em, ${JSON.stringify(email)});
        reactSet(pw, ${JSON.stringify(password)});
        return em.value === ${JSON.stringify(email)} && pw.value === ${JSON.stringify(password)};
      })()`).catch(() => false);
      if (!filled) await sleep(1000);
    }
    if (!filled) { lastState = 'the form never accepted a value (not hydrated)'; continue; }

    await evaluate(`(() => { const f = document.querySelector('form'); if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); return true; }
      const b = [...document.querySelectorAll('button')].find(x => /sign in/i.test(x.textContent)); if (b) { b.click(); return true; } return false; })()`);
    try { await waitFor(SESSION, { label: 'a stored Supabase session', timeout: 30000 }); return true; }
    catch {
      lastState = (await text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    }
  }
  throw new Error(`could not sign in as ${label} after 4 attempts — last page state: ${lastState}`);
}

// ---------------------------------------------------------------- run
let chrome = null, bookingId = null, disputeId = null;
let customerId = null, providerUserId = null, adminId = null, providerId = null;
let walletBefore = 0, provRepBefore = 0;

try {
  if (!CHROME) { console.log('Cannot run: Chrome not found.'); process.exit(0); }
  try {
    // generous: a cold dev server compiles the route on first hit (measured ~7s)
    const r = await fetch(APP, { signal: AbortSignal.timeout(45000) });
    if (!r.ok && r.status >= 500) throw new Error('bad status');
  } catch { console.log('Cannot run: dev server not answering on :3000 — start `npm run dev`.'); process.exit(0); }

  // ---- accounts ----
  const users = await listAllUsers(service);
  customerId = users.find((u) => u.email === CUSTOMER_EMAIL)?.id;
  providerUserId = users.find((u) => u.email === PROVIDER_EMAIL)?.id;
  adminId = users.find((u) => u.email === ADMIN_EMAIL)?.id;
  if (!customerId || !providerUserId || !adminId) { console.log('Cannot run: test accounts not found.'); process.exit(1); }

  const { data: adminProfile } = await service.from('profiles').select('role').eq('id', adminId).maybeSingle();
  if (adminProfile?.role !== 'admin') {
    console.log(`Cannot run: ${ADMIN_EMAIL} is not role='admin' (found ${adminProfile?.role}).`); process.exit(1);
  }

  const { data: sp } = await service.from('service_providers')
    .select('id, business_name, reputation_score').eq('user_id', providerUserId).eq('status', 'approved').maybeSingle();
  if (!sp) { console.log('Cannot run: the provider account owns no approved provider row.'); process.exit(1); }
  providerId = sp.id;
  provRepBefore = Number(sp.reputation_score ?? 0);

  const { data: wallet } = await service.from('profiles').select('wallet_balance').eq('id', providerUserId).maybeSingle();
  walletBefore = Number(wallet?.wallet_balance ?? 0);

  const { data: feeRow } = await service.rpc('platform_fee_pct');
  const FEE_PCT = Number(feeRow ?? 0.01);
  const expectedFee = Math.round(AMOUNT * FEE_PCT * 100) / 100;
  const expectedPayout = AMOUNT - expectedFee;

  // ---- seed a disputable booking: in_progress + escrow HELD, with real evidence to show ----
  const { data: cat } = await service.from('service_categories').select('id').limit(1).maybeSingle();
  const { data: bk, error: bkErr } = await service.from('bookings').insert({
    customer_id: customerId, provider_id: providerId, category_id: cat?.id ?? null,
    service_type: 'one-time', scheduled_date: '2026-07-30', scheduled_time: '15:00',
    duration_hours: 2, hourly_rate: 400, total_amount: AMOUNT, price_agreed: AMOUNT, price_charged: AMOUNT,
    payment_method: 'upi', status: 'in_progress', payment_status: 'held', notes: TAG,
  }).select('id').single();
  if (bkErr) throw new Error('seed booking insert: ' + bkErr.message);
  bookingId = bk.id;

  await service.from('payment_transactions').insert({
    booking_id: bookingId, razorpay_order_id: 'order_s8ui_' + Date.now(),
    razorpay_payment_id: 'pay_s8ui_' + Date.now(), amount: AMOUNT * 100, status: 'captured',
  });

  const t = (min) => new Date(Date.now() - min * 60000).toISOString();
  for (const e of [
    { from_status: null, to_status: 'requested', actor_id: customerId, actor_role: 'customer', created_at: t(180) },
    { from_status: 'requested', to_status: 'accepted', actor_id: providerUserId, actor_role: 'provider', created_at: t(160) },
    { from_status: 'accepted', to_status: 'en_route', actor_id: providerUserId, actor_role: 'provider', created_at: t(90) },
    { from_status: 'en_route', to_status: 'arrived', actor_id: providerUserId, actor_role: 'provider', created_at: t(60) },
    { from_status: 'arrived', to_status: 'in_progress', actor_id: providerUserId, actor_role: 'provider', created_at: t(45) },
  ]) await service.from('booking_events').insert({ booking_id: bookingId, meta: {}, ...e });

  await service.from('messages').insert([
    { booking_id: bookingId, sender_id: providerUserId, body: 'On my way, will reach by 3pm.', created_at: t(95) },
    { booking_id: bookingId, sender_id: customerId, body: 'Ok. Please bring the tools for the sink.', created_at: t(92) },
    { booking_id: bookingId, sender_id: customerId, body: 'You started but left without finishing the job.', created_at: t(20) },
  ]);

  // ---- pre-warm every route this run touches ----
  // `next dev` compiles a route on its FIRST request, and the evidence bundle blocks its render on
  // /api/admin/dispute-contacts — so a cold API route stalls the whole page behind "Loading
  // evidence…". Paying that cost here (from Node, unauthenticated: a 401 compiles it just as well)
  // keeps the in-browser waits honest measurements of the UI rather than of webpack.
  const warm = async (path) => {
    const started = Date.now();
    try { await fetch(APP + path, { signal: AbortSignal.timeout(180000) }); }
    catch { /* status doesn't matter — compiling it does */ }
    return Math.round((Date.now() - started) / 100) / 10;
  };
  const warmed = [];
  for (const p of ['/auth/signin', `/bookings/${bookingId}`, '/admin/disputes',
                   '/admin/disputes/00000000-0000-0000-0000-000000000000',
                   '/api/admin/dispute-contacts']) {
    warmed.push(`${p.replace(bookingId, '<id>')} ${await warm(p)}s`);
  }
  console.log('pre-warmed routes: ' + warmed.join(' · '));

  // ---- browser ----
  const profile = mkdtempSync(join(tmpdir(), 'seva-cdp8-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9224', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:9224/json/list')).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome did not expose a debugging target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      const desc = d?.exception?.description ?? d?.text ?? '';
      if (!/ResizeObserver|Failed to load resource/i.test(desc)) pageExceptions.push(desc.split('\n')[0]);
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
  console.log('driving real Chrome (headless) against ' + APP);
  console.log(`seeded booking ${bookingId} — ₹${AMOUNT} held in escrow, in_progress\n`);

  // ================= 1) the customer reports a problem =================
  console.log('[customer: "Report a problem with this booking"]');
  await signInAs(CUSTOMER_EMAIL, CUSTOMER_PASSWORD, 'the customer');
  ok('signed in as the customer through the real form');

  await evaluate(`window.location.assign('/bookings/${bookingId}')`);
  await waitFor("document.body.innerText.includes('Report a problem with this booking')",
    { label: 'the report-a-problem entry point', timeout: 30000 });
  ok('a disputable booking offers "Report a problem with this booking"');

  if (await clickContaining('Report a problem with this booking')) ok('opened the dispute form');
  else no('could not open the dispute form');
  await sleep(600);

  const formText = await text();
  if (/What went wrong\?/i.test(formText)) ok('the form asks "What went wrong?"');
  else no('dispute form did not open: ' + formText.slice(0, 300));
  if (/Money stays protected until it/i.test(formText))
    ok('...and tells the customer money stays protected while it is reviewed');
  else no('the escrow-protection copy is missing');

  // the submit must stay disabled until a reason is chosen
  const disabledBefore = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Raise dispute');
    return b ? b.disabled : null;
  })()`);
  if (disabledBefore === true) ok('"Raise dispute" is disabled until a reason is picked');
  else no('"Raise dispute" was submittable with no reason: ' + disabledBefore);

  await selectNth(0, REASON);
  await fillTextarea('He started the sink and left without finishing. Reported from the UI check.');
  await sleep(300);
  if (await clickText('Raise dispute')) ok(`submitted a "${REASON_LABEL_PARTY}" dispute`);
  else no('no "Raise dispute" button');

  await waitFor("/Dispute open/i.test(document.body.innerText)", { label: 'the dispute banner', timeout: 20000 });
  const banner = await text();
  if (new RegExp(REASON_LABEL_PARTY, 'i').test(banner)) ok(`the banner names the reason — "${REASON_LABEL_PARTY}"`);
  else no('the banner does not name the reason: ' + banner.slice(0, 300));
  if (/Raised by you/i.test(banner)) ok('...and says the customer raised it');
  else no('the banner does not attribute the raiser');
  if (!/Report a problem with this booking/.test(banner))
    ok('...and the report entry point is gone while the dispute is live (no double-filing)');
  else no('"Report a problem" is still offered with a dispute already open');

  const { data: raised } = await service.from('disputes')
    .select('id, status, reason, raiser_role, raised_by').eq('booking_id', bookingId).maybeSingle();
  const { data: bkAfter } = await service.from('bookings').select('status').eq('id', bookingId).maybeSingle();
  disputeId = raised?.id ?? null;
  if (raised && raised.status === 'open' && raised.reason === REASON
      && raised.raiser_role === 'customer' && raised.raised_by === customerId)
    ok('the UI created a real open dispute row, attributed to the customer');
  else no('dispute row wrong or missing: ' + JSON.stringify(raised));
  if (bkAfter?.status === 'disputed') ok('...and the booking moved to \'disputed\' server-side');
  else no('booking status is ' + bkAfter?.status + ', expected disputed');

  // ================= 2) a non-admin party cannot reach the console =================
  console.log('\n[provider: the admin console is not for parties]');
  await signInAs(PROVIDER_EMAIL, PROVIDER_PASSWORD, 'the provider');
  await evaluate(`window.location.assign('/admin/disputes')`);
  await sleep(6000);   // give the guard time to resolve the profile and redirect
  const provView = await text();
  const provPath = await evaluate('location.pathname');
  if (!/Dispute Queue/.test(provView)) ok('a non-admin never sees the Dispute Queue');
  else no('🔴 the provider can read the admin dispute queue');
  if (provPath !== '/admin/disputes') ok(`...they are redirected away (landed on ${provPath})`);
  else no('the non-admin was left sitting on /admin/disputes');

  // and the detail page is closed too
  await evaluate(`window.location.assign('/admin/disputes/${disputeId}')`);
  await sleep(6000);
  const provDetail = await text();
  if (!/Resolve dispute|chat thread/i.test(provDetail)) ok('...and the evidence bundle is closed to them as well');
  else no('🔴 the provider can read another case\'s evidence bundle');

  // ================= 3) the admin queue =================
  console.log('\n[admin: the dispute queue]');
  await signInAs(ADMIN_EMAIL, ADMIN_PASSWORD, 'the admin');
  ok('signed in as the admin');

  await evaluate(`window.location.assign('/admin/disputes')`);
  await waitFor("document.body.innerText.includes('Dispute Queue')", { label: 'the queue', timeout: 30000 });
  await waitFor("!document.body.innerText.includes('Loading disputes…')", { label: 'the queue to load', timeout: 25000 });
  await sleep(800);
  const queue = await text();
  ok('the admin reaches the Dispute Queue');

  if (new RegExp(REASON_LABEL, 'i').test(queue)) ok(`the new case is in the queue as "${REASON_LABEL}"`);
  else no('the case is not listed: ' + queue.slice(0, 500));
  if (queue.includes('#' + bookingId.slice(0, 8))) ok('...tagged with its booking id');
  else no('the queue row does not show the booking id');

  // open it from the queue, the way an admin actually would
  if (await clickContaining('#' + bookingId.slice(0, 8))) ok('opened the case from the queue');
  else { no('could not click through from the queue'); await evaluate(`window.location.assign('/admin/disputes/${disputeId}')`); }

  // ================= 4) the evidence bundle =================
  console.log('\n[admin: the evidence bundle]');
  // NB every card heading here carries Tailwind's `uppercase`, so innerText reads back
  // "CHAT THREAD" / "TIMELINE" / "EVIDENCE". Match the section headings case-insensitively —
  // the same trap ui-check-step10 hit with `capitalize`.
  try {
    await waitFor("!/Loading evidence…|Checking access…/.test(document.body.innerText) && /chat thread/i.test(document.body.innerText)",
      { label: 'the evidence bundle', timeout: 45000 });
  } catch (e) {
    // Say WHY it never rendered — stuck on the guard, stuck loading, a dead case and a section
    // that threw all look the same from a bare timeout.
    const state = (await text().catch(() => '')).replace(/\s+/g, ' ');
    throw new Error(`${e.message}\n    at ${await evaluate('location.pathname')}\n    page text: ${state}\n    exceptions: ${JSON.stringify(pageExceptions)}`);
  }
  await sleep(1200);
  const bundle = await text();

  if (/Booking & money/i.test(bundle)) ok('the bundle shows Booking & money');
  else no('the money card is missing');
  if (new RegExp(`Agreed[\\s\\S]{0,40}₹${money(AMOUNT)}`).test(bundle) && new RegExp(`Charged[\\s\\S]{0,40}₹${money(AMOUNT)}`).test(bundle))
    ok(`...with agreed vs charged side by side (₹${money(AMOUNT)} / ₹${money(AMOUNT)})`);
  else no('agreed vs charged not rendered: ' + bundle.slice(0, 600));
  if (/captured/i.test(bundle)) ok('...and the captured escrow ledger row');
  else no('the payment ledger row is not shown');

  if (/chat thread/i.test(bundle) && /3 messages, immutable/.test(bundle)) ok('the chat thread is bundled (3 messages, immutable)');
  else no('the chat thread count is wrong: ' + (bundle.match(/\d+ messages, immutable/)?.[0] ?? 'absent'));
  if (/left without finishing the job/.test(bundle)) ok('...with the real message content the case turns on');
  else no('chat evidence content missing');

  if (/Timeline/i.test(bundle) && /en_route|arrived|in_progress/.test(bundle))
    ok('the state timeline is bundled — "he never arrived" is answerable from timestamps');
  else no('the timeline is missing');
  if (/in_progress → disputed/.test(bundle)) ok('...including the disputed transition itself');
  else no('the disputed event is not on the timeline');

  if (/Contact parties/i.test(bundle) && !/Contact details unavailable/.test(bundle))
    ok('both parties\' contact details resolved (admin-only route answered)');
  else no('contact details did not load — the admin cannot reach either party');
  if (/Visible to admins only/.test(bundle)) ok('...labelled admin-only');

  if (/Parties & trust/i.test(bundle) && /Trust \d/.test(bundle)) ok('both reputations are on the case');
  else no('the parties/trust card is missing');
  if (/Evidence/i.test(bundle) && /0 files|No evidence submitted/.test(bundle))
    ok('the Step-8.5 evidence panel renders (empty for this case, as seeded)');
  else no('the evidence panel did not render');

  // ================= 5) resolving moves the money =================
  console.log('\n[admin: resolve — money follows the outcome, reputation follows fault]');
  const resolveIdx = await evaluate(`(() => {
    const sels = [...document.querySelectorAll('select')];
    return sels.findIndex(s => [...s.options].some(o => o.value === 'favor_provider'));
  })()`);
  if (resolveIdx < 0) throw new Error('no outcome select on the resolution panel');

  await selectNth(resolveIdx, 'favor_provider');
  await sleep(600);
  const faultValue = await selectValue(resolveIdx + 1);
  if (faultValue === 'customer') ok('picking "Favour provider" pre-fills fault = customer');
  else no('fault did not pre-fill from the outcome: ' + faultValue);

  const preview = await text();
  if (new RegExp(`Provider receives[\\s\\S]{0,30}₹${money(expectedPayout)}`).test(preview))
    ok(`the preview shows the provider receiving ₹${money(expectedPayout)} before committing`);
  else no('the money preview is wrong/absent: ' + (preview.match(/Provider receives[^\n]*/)?.[0] ?? 'absent'));
  if (new RegExp(`Platform fee \\(1%\\)[\\s\\S]{0,30}₹${money(expectedFee)}`).test(preview))
    ok(`...and the ₹${money(expectedFee)} platform fee (1%)`);
  else no('the fee line is wrong/absent: ' + (preview.match(/Platform fee[^\n]*/)?.[0] ?? 'absent'));

  await fillTextarea('Timeline and chat show the work was done; resolved in the provider\'s favour. (UI check)');
  await sleep(300);
  if (await clickText('Resolve dispute')) ok('clicked "Resolve dispute"');
  else no('no "Resolve dispute" button');
  await sleep(6000);

  const { data: resolved } = await service.from('disputes')
    .select('status, outcome, fault_party, resolved_by, resolution_notes').eq('id', disputeId).maybeSingle();
  if (resolved?.status === 'resolved' && resolved?.outcome === 'favor_provider'
      && resolved?.fault_party === 'customer' && resolved?.resolved_by === adminId)
    ok('the dispute is resolved, stamped with the outcome, the fault party and the admin');
  else no('the dispute did not resolve correctly: ' + JSON.stringify(resolved));
  if (resolved?.resolution_notes) ok('...with the admin\'s notes recorded for both parties');

  const { data: bkFinal } = await service.from('bookings')
    .select('status, payment_status').eq('id', bookingId).maybeSingle();
  if (bkFinal?.status === 'paid' && bkFinal?.payment_status === 'released')
    ok('the booking left \'disputed\' → paid / released (no dead end)');
  else no('the booking did not exit disputed: ' + JSON.stringify(bkFinal));

  const { data: walletAfterRow } = await service.from('profiles')
    .select('wallet_balance').eq('id', providerUserId).maybeSingle();
  const delta = Number(walletAfterRow?.wallet_balance ?? 0) - walletBefore;
  if (Math.abs(delta - expectedPayout) < 0.01)
    ok(`the escrow actually moved: the provider's wallet went up ₹${money(delta)} (₹${money(AMOUNT)} − ₹${money(expectedFee)} fee)`);
  else no(`wallet moved by ₹${money(delta)}, expected ₹${money(expectedPayout)}`);

  const { data: ledger } = await service.from('payment_transactions')
    .select('status, provider_amount, platform_fee').eq('booking_id', bookingId).maybeSingle();
  if (ledger?.status === 'released' && Math.abs(Number(ledger.provider_amount) - expectedPayout) < 0.01
      && Math.abs(Number(ledger.platform_fee) - expectedFee) < 0.01)
    ok('...and the payment ledger row records the split (captured → released)');
  else no('the ledger row is wrong: ' + JSON.stringify(ledger));

  const { data: wt } = await service.from('wallet_transactions')
    .select('type, amount').eq('reference_id', bookingId);
  if ((wt ?? []).some((r) => r.type === 'credit' && Math.abs(Number(r.amount) - expectedPayout) < 0.01))
    ok('...through an append-only wallet_transactions credit, not a bare balance write');
  else no('no matching wallet ledger row: ' + JSON.stringify(wt));

  // 🔴 the invariant this step exists for
  const { data: spAfter } = await service.from('service_providers')
    .select('reputation_score').eq('id', providerId).maybeSingle();
  const repAfter = Number(spAfter?.reputation_score ?? 0);
  if (repAfter >= provRepBefore - 0.001)
    ok(`🔴 the exonerated provider took NO reputation hit (${provRepBefore.toFixed(2)} → ${repAfter.toFixed(2)}) — penalty follows fault, not the filing`);
  else no(`🔴 the provider was penalized despite being found not at fault: ${provRepBefore.toFixed(2)} → ${repAfter.toFixed(2)}`);

  // ================= 6) both parties see the outcome =================
  console.log('\n[customer: the outcome comes back to the party]');
  await signInAs(CUSTOMER_EMAIL, CUSTOMER_PASSWORD, 'the customer');
  await evaluate(`window.location.assign('/bookings/${bookingId}')`);
  await waitFor("/Dispute resolved/i.test(document.body.innerText)", { label: 'the resolved banner', timeout: 30000 });
  const closing = await text();
  ok('the customer sees "Dispute resolved" on the booking');
  if (/favour/i.test(closing)) ok('...naming the outcome in plain words');
  else no('the outcome text is missing: ' + (closing.match(/Dispute resolved[^\n]*/)?.[0] ?? ''));
  if (/UI check/.test(closing)) ok('...and the admin\'s resolution notes are shown to the party');
  else no('resolution notes were not surfaced to the party');

  const { data: notes } = await service.from('notifications')
    .select('user_id, title').eq('link', '/bookings/' + bookingId).eq('title', 'Dispute resolved');
  const notified = new Set((notes ?? []).map((n) => n.user_id));
  if (notified.has(customerId) && notified.has(providerUserId))
    ok('both parties were notified of the resolution');
  else no('resolution notifications missing: ' + JSON.stringify([...notified]));

  if (!pageExceptions.length) ok('no uncaught page exceptions during the flow');
  else no('uncaught page exceptions: ' + JSON.stringify(pageExceptions.slice(0, 3)));
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
} finally {
  console.log('\n[cleanup]');
  try {
    if (bookingId) {
      // reverse any wallet movement this run caused, then drop the ledger rows
      const { data: wt } = await service.from('wallet_transactions')
        .select('user_id, type, amount').eq('reference_id', bookingId);
      const net = {};
      for (const r of wt ?? []) {
        const d = r.type === 'debit' ? -Number(r.amount) : Number(r.amount);
        net[r.user_id] = (net[r.user_id] || 0) + d;
      }
      for (const [uid, d] of Object.entries(net)) {
        const { data: p } = await service.from('profiles').select('wallet_balance').eq('id', uid).maybeSingle();
        await service.from('profiles').update({ wallet_balance: Number(p?.wallet_balance || 0) - d }).eq('id', uid);
        console.log(`  wallet restored for ${uid}: reversed ${d >= 0 ? '+' : ''}${d}`);
      }
      await service.from('wallet_transactions').delete().eq('reference_id', bookingId);
      await service.from('notifications').delete().like('link', `/bookings/${bookingId}%`);
      // the admin's "New dispute to review" notification points at the case, not the booking
      if (disputeId) await service.from('notifications').delete().like('link', `/admin/disputes/${disputeId}%`);
      await service.from('bookings').delete().eq('id', bookingId); // cascades dispute/paytx/messages/events
      console.log('  seeded booking, dispute, chat, events and ledger rows removed');

      // recompute both reputations so the run leaves no trace in the scores
      if (providerId) await service.rpc('compute_reputation', { p_subject_type: 'provider', p_subject_id: providerId });
      if (customerId) await service.rpc('compute_reputation', { p_subject_type: 'customer', p_subject_id: customerId });
      console.log('  reputations recomputed');
    }
  } catch (e) { console.log('  cleanup problem: ' + (e?.message ?? e)); }
  try { ws?.close(); } catch {}
  try { chrome?.kill(); } catch {}
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
