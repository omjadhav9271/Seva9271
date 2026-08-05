/*
  Browser check for the dispute-clarity pass — drives a REAL Chrome over the DevTools Protocol.

  ui-check-step8.mjs already proves the dispute MACHINERY through the UI (raise → queue → evidence
  bundle → resolve → money moves). It cannot see the four things this pass added, every one of
  which is a rendering concern that a green SQL suite would happily miss:

    1. IDENTIFICATION — both parties' cards name WHO raised it, against WHOM, about WHICH booking,
       and quote the complaint. The old banner said "Raised by the customer" and nothing else.
    2. ADMIN NOTIFICATION — raise_dispute now notifies every admin at /admin/disputes/<id>, and
       that link has to actually land on the case.
    3. LIVE RESOLUTION — the party's open page must flip to resolved WITHOUT a reload when the
       admin decides. This is the one that needs a browser: it is a WebSocket delivery, not a query.
    4. SETTLEMENT SUMMARY — the money breakdown, on the hardest branch: escrow ALREADY released,
       resolved for the customer, so the refund is a CLAWBACK and the provider ends at −₹fee.

  The booking is seeded 'paid'/'released' (a real payout event + the wallet credit behind it) and
  torn down at the end, wallet and reputations restored.

  Usage (needs `npm run dev` on :3000, and CUSTOMER_/PROVIDER_/ADMIN_ credentials in .env.local —
  see .env.example):
    node scripts/ui-check-dispute-clarity.mjs
*/
import { spawn } from 'node:child_process';
import { requireAccounts } from './lib/creds.mjs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const APP = 'http://localhost:3000';
const { CUSTOMER, PROVIDER, ADMIN } = requireAccounts(['CUSTOMER', 'PROVIDER', ['ADMIN', 'STRANGER']]);
const { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD } = CUSTOMER;
const { email: PROVIDER_EMAIL, password: PROVIDER_PASSWORD } = PROVIDER;
const { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } = ADMIN;

const TAG = 'DISPUTE-CLARITY-UI-CHECK';
const AMOUNT = 800;
const REASON = 'poor_quality';
const REASON_LABEL_PARTY = 'Poor quality of work';   // customer-side label (lib/disputes)
const REASON_LABEL_SHORT = 'Poor quality';           // admin-side label
const COMPLAINT = 'The tap still leaks and the tiles were left cracked. Filed by the clarity UI check.';

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
// the settlement card prints a real minus sign (U+2212); accept either
const MINUS = '[−-]';

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

// A rendered page, not a blank/404 one. Every section below asserts this BEFORE trusting a match —
// the recurring false-pass in this project is a green probe against a page that never rendered.
const rendered = (marker) => waitFor(
  `document.body && document.body.innerText.length > 200 && /${marker}/i.test(document.body.innerText)`,
  { label: `a rendered page containing /${marker}/i`, timeout: 40000 },
);

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

// Hydration race: fill, read the values BACK, and only submit once they survive a re-render.
async function signInAs(email, password, label) {
  let lastState = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    await evaluate("localStorage.clear()").catch(() => {});
    await send('Page.navigate', { url: `${APP}/auth/signin` });
    await waitFor("!!document.querySelector('input[type=password]')", { label: 'the sign-in form', timeout: 60000 });
    await sleep(2500);

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
    catch { lastState = (await text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200); }
  }
  throw new Error(`could not sign in as ${label} after 4 attempts — last page state: ${lastState}`);
}

// ---------------------------------------------------------------- run
let chrome = null, bookingId = null, disputeId = null;
let customerId = null, providerUserId = null, adminId = null, providerId = null;
let customerName = null, businessName = null;
let customerNameOriginal = null, customerNameSeeded = false;
let FEE = 0, PAYOUT = 0;

try {
  if (!CHROME) { console.log('Cannot run: Chrome not found.'); process.exit(0); }
  try {
    const r = await fetch(APP, { signal: AbortSignal.timeout(45000) });
    if (!r.ok && r.status >= 500) throw new Error('bad status');
  } catch { console.log('Cannot run: dev server not answering on :3000 — start `npm run dev`.'); process.exit(0); }

  // ---- accounts ----
  const { data: { users } } = await service.auth.admin.listUsers({ perPage: 200 });
  customerId = users.find((u) => u.email === CUSTOMER_EMAIL)?.id;
  providerUserId = users.find((u) => u.email === PROVIDER_EMAIL)?.id;
  adminId = users.find((u) => u.email === ADMIN_EMAIL)?.id;
  if (!customerId || !providerUserId || !adminId) { console.log('Cannot run: test accounts not found.'); process.exit(1); }

  const { data: adminProfile } = await service.from('profiles').select('role').eq('id', adminId).maybeSingle();
  if (adminProfile?.role !== 'admin') {
    console.log(`Cannot run: ${ADMIN_EMAIL} is not role='admin' (found ${adminProfile?.role}).`); process.exit(1);
  }
  // The identification claims are about NAMES. All three live test profiles carry full_name=NULL,
  // so the card would render its "the customer" fallback and an assertion against it would pass
  // for the wrong reason. Give the customer a name for the duration of the run and put the
  // original back in cleanup — the harness must leave the project exactly as it found it.
  const { data: custProfile } = await service.from('profiles').select('full_name').eq('id', customerId).maybeSingle();
  customerNameOriginal = custProfile?.full_name ?? null;
  customerName = customerNameOriginal?.trim() || '';
  if (!customerName) {
    customerName = 'Ananya Iyer';
    const { error } = await service.from('profiles').update({ full_name: customerName }).eq('id', customerId);
    if (error) { console.log('Cannot run: could not set a display name on the customer — ' + error.message); process.exit(1); }
    customerNameSeeded = true;
    console.log(`note: the customer profile had no full_name; using "${customerName}" for this run (restored at the end).`);
  }

  const { data: sp } = await service.from('service_providers')
    .select('id, business_name').eq('user_id', providerUserId).eq('status', 'approved').maybeSingle();
  if (!sp) { console.log('Cannot run: the provider account owns no approved provider row.'); process.exit(1); }
  providerId = sp.id;
  businessName = sp.business_name ?? '';

  // an admin session, to resolve the case from OUTSIDE the browser while a party page stays open
  const adminClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  {
    const { error } = await adminClient.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    if (error) { console.log('Cannot run: admin sign-in failed — ' + error.message); process.exit(1); }
  }

  const { data: feeRow } = await service.rpc('platform_fee_pct');
  FEE = Math.round(AMOUNT * Number(feeRow ?? 0.01) * 100) / 100;
  PAYOUT = AMOUNT - FEE;

  // ---- seed: escrow ALREADY RELEASED, so resolving for the customer must claw back ----
  const { data: cat } = await service.from('service_categories').select('id, name').limit(1).maybeSingle();
  const { data: bk, error: bkErr } = await service.from('bookings').insert({
    customer_id: customerId, provider_id: providerId, category_id: cat?.id ?? null,
    service_type: 'one-time', scheduled_date: '2026-08-02', scheduled_time: '10:00',
    duration_hours: 2, hourly_rate: 400, total_amount: AMOUNT, price_agreed: AMOUNT, price_charged: AMOUNT,
    payment_method: 'upi', status: 'paid', payment_status: 'released', notes: TAG,
  }).select('id').single();
  if (bkErr) throw new Error('seed booking insert: ' + bkErr.message);
  bookingId = bk.id;

  await service.from('payment_transactions').insert({
    booking_id: bookingId, razorpay_order_id: 'order_clarity_' + Date.now(),
    razorpay_payment_id: 'pay_clarity_' + Date.now(), amount: AMOUNT * 100,
    status: 'released', provider_amount: PAYOUT, platform_fee: FEE,
  });

  // Timeline. NEVER insert a 'confirmed' event: trg_release_escrow fires on exactly that and would
  // pay the provider a second time. The system 'paid' event carries meta.payout — the fact the
  // settlement card reads to know the escrow was already out (i.e. a refund is a CLAWBACK).
  const t = (min) => new Date(Date.now() - min * 60000).toISOString();
  for (const e of [
    { from_status: null, to_status: 'requested', actor_id: customerId, actor_role: 'customer', created_at: t(240), meta: {} },
    { from_status: 'requested', to_status: 'accepted', actor_id: providerUserId, actor_role: 'provider', created_at: t(220), meta: {} },
    { from_status: 'accepted', to_status: 'en_route', actor_id: providerUserId, actor_role: 'provider', created_at: t(150), meta: {} },
    { from_status: 'en_route', to_status: 'arrived', actor_id: providerUserId, actor_role: 'provider', created_at: t(120), meta: {} },
    { from_status: 'arrived', to_status: 'in_progress', actor_id: providerUserId, actor_role: 'provider', created_at: t(110), meta: {} },
    { from_status: 'in_progress', to_status: 'completed', actor_id: providerUserId, actor_role: 'provider', created_at: t(70), meta: {} },
    { from_status: 'confirmed', to_status: 'paid', actor_id: null, actor_role: 'system', created_at: t(60), meta: { payout: PAYOUT, fee: FEE } },
  ]) await service.from('booking_events').insert({ booking_id: bookingId, ...e });

  await service.from('messages').insert([
    { booking_id: bookingId, sender_id: providerUserId, body: 'Finished the bathroom, thanks!', created_at: t(72) },
    { booking_id: bookingId, sender_id: customerId, body: 'The tap is still dripping.', created_at: t(40) },
  ]);

  // the payout the provider actually banked, so the clawback has something to pull back
  await service.rpc('credit_wallet', {
    p_user_id: providerUserId, p_amount: PAYOUT, p_type: 'credit',
    p_description: 'Payout for booking ' + bookingId, p_reference_id: bookingId,
  });

  // ---- pre-warm every route this run touches (next dev compiles on first request) ----
  const warm = async (path) => {
    const started = Date.now();
    try { await fetch(APP + path, { signal: AbortSignal.timeout(180000) }); } catch { /* compiling is the point */ }
    return Math.round((Date.now() - started) / 100) / 10;
  };
  const warmed = [];
  for (const p of ['/auth/signin', `/bookings/${bookingId}`, '/notifications', '/admin/disputes',
                   '/admin/disputes/00000000-0000-0000-0000-000000000000', '/api/admin/dispute-contacts']) {
    warmed.push(`${p.replace(bookingId, '<id>')} ${await warm(p)}s`);
  }
  console.log('pre-warmed routes: ' + warmed.join(' · '));

  // ---- browser ----
  const profile = mkdtempSync(join(tmpdir(), 'seva-cdp-clarity-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9226', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:9226/json/list')).json();
      target = list.find((x) => x.type === 'page');
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
  console.log(`seeded booking ${bookingId} — ₹${AMOUNT} ALREADY PAID OUT (₹${PAYOUT} in the provider's wallet, ₹${FEE} fee)\n`);

  // ================= 1) the customer files it =================
  console.log('[customer: files the complaint]');
  await signInAs(CUSTOMER_EMAIL, CUSTOMER_PASSWORD, 'the customer');
  await evaluate(`window.location.assign('/bookings/${bookingId}')`);
  await rendered('Report a problem with this booking');
  ok('the settled booking still offers "Report a problem with this booking"');

  await clickContaining('Report a problem with this booking');
  await sleep(600);
  await selectNth(0, REASON);
  await fillTextarea(COMPLAINT);
  await sleep(300);
  if (await clickText('Raise dispute')) ok('filed the dispute through the real form');
  else no('no "Raise dispute" button');

  await waitFor("/Dispute open/i.test(document.body.innerText)", { label: 'the dispute card', timeout: 25000 });
  const asCustomer = await text();

  const { data: raised } = await service.from('disputes')
    .select('id, status, reason, raiser_role, description').eq('booking_id', bookingId).maybeSingle();
  disputeId = raised?.id ?? null;
  if (raised?.status === 'open' && raised?.reason === REASON && raised?.raiser_role === 'customer')
    ok('a real open dispute row exists, attributed to the customer');
  else no('dispute row wrong or missing: ' + JSON.stringify(raised));

  // ---- IDENTIFICATION, raiser's side ----
  if (/Raised by you \(customer\)/i.test(asCustomer)) ok('the card says "Raised by you (customer)"');
  else no('raiser attribution missing: ' + (asCustomer.match(/Raised by[^\n]*/)?.[0] ?? 'absent'));
  if (businessName && new RegExp(`against ${businessName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(provider\\)`, 'i').test(asCustomer))
    ok(`...and names the other party — "against ${businessName} (provider)"`);
  else no('the other party is not named: ' + (asCustomer.match(/against[^\n]*/)?.[0] ?? 'absent'));
  if (new RegExp(REASON_LABEL_PARTY, 'i').test(asCustomer)) ok(`...and the reason in plain words ("${REASON_LABEL_PARTY}")`);
  else no('the reason label is missing');
  if (asCustomer.includes(COMPLAINT.slice(0, 40))) ok('...and quotes the complaint back under "What you reported"');
  else no('the filed message is not shown back to the raiser');
  if (/#[0-9a-f]{8}/i.test(asCustomer) && new RegExp(`booking #${bookingId.slice(0, 8)}`, 'i').test(asCustomer.replace(/\s+/g, ' ')))
    ok('...and identifies WHICH booking (service + booking id)');
  else no('the booking is not identified on the card');
  if (/evidence each side attaches/i.test(asCustomer) && /Funds stay protected/i.test(asCustomer))
    ok('the copy names the evidence + message as things the team reviews, and reassures on funds');
  else no('the reviewing copy was not updated: ' + (asCustomer.match(/Our team is reviewing[^\n]*/)?.[0] ?? 'absent'));

  // ================= 2) the accused party's view =================
  console.log('\n[provider: knows who is complaining, and about what]');
  await signInAs(PROVIDER_EMAIL, PROVIDER_PASSWORD, 'the provider');
  await evaluate(`window.location.assign('/bookings/${bookingId}')`);
  await rendered('Dispute open');
  const asProvider = await text();

  const nameRe = customerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`Raised by ${nameRe} \\(customer\\)`, 'i').test(asProvider))
    ok(`the accused party sees the raiser BY NAME — "Raised by ${customerName} (customer)"`);
  else no('the raiser is not named to the provider: ' + (asProvider.match(/Raised by[^\n]*/)?.[0] ?? 'absent'));
  if (/against you \(provider\)/i.test(asProvider)) ok('...and that it is against them ("against you (provider)")');
  else no('the accused party is not identified: ' + (asProvider.match(/against[^\n]*/)?.[0] ?? 'absent'));
  if (asProvider.includes(COMPLAINT.slice(0, 40))) ok('...and reads the actual complaint they must answer');
  else no('the complaint is not shown to the accused party');
  if (/What the customer reported/i.test(asProvider)) ok('...labelled "What the customer reported"');
  else no('the complaint is not labelled by side');
  if (/Attach anything that supports your side/i.test(asProvider)) ok('...and is prompted to attach supporting evidence');
  else no('the evidence prompt is missing');

  // ================= 3) LIVE resolution — no reload =================
  // The provider's page STAYS OPEN. The admin resolves from outside the browser entirely; if the
  // realtime subscription works, this page changes on its own.
  console.log('\n[live: the admin resolves while the provider watches — no reload]');
  const beforeResolve = await evaluate('location.href');
  const { error: resolveErr } = await adminClient.rpc('resolve_dispute', {
    p_dispute_id: disputeId,
    p_outcome: 'favor_customer',
    p_fault: 'provider',
    p_notes: 'Photos and chat confirm the leak was not fixed. Refunding the customer in full. (clarity UI check)',
    p_refund_amount: null,
  });
  if (resolveErr) throw new Error('resolve_dispute failed: ' + resolveErr.message);

  let liveOk = false;
  try {
    await waitFor("/Dispute resolved/i.test(document.body.innerText)", { label: 'the resolved card, live', timeout: 25000 });
    liveOk = true;
  } catch { /* asserted below */ }
  const stillSamePage = (await evaluate('location.href')) === beforeResolve;
  if (liveOk && stillSamePage) ok('🔴 the open page flipped to "Dispute resolved" with NO reload and no navigation');
  else if (liveOk) no('the page did show the resolution, but the URL changed — not a live update');
  else no('the open page never updated — realtime did not deliver the dispute change');

  await sleep(1500); // the settlement card fetches the ledger after the dispute state lands
  const settled = await text();

  if (/Resolved in the customer’s favour|Resolved in the customer's favour/i.test(settled))
    ok('...naming the outcome in plain words');
  else no('the outcome text is missing: ' + (settled.match(/Dispute resolved[^\n]*/)?.[0] ?? 'absent'));
  if (/found you at fault/i.test(settled)) ok('...and telling the at-fault party it is them, in the second person');
  else no('the fault line is missing/impersonal: ' + (settled.match(/found[^\n]*/)?.[0] ?? 'absent'));
  if (/clarity UI check/.test(settled)) ok("...with the admin's decision notes");
  else no('the resolution notes were not surfaced');

  // ================= 4) the settlement summary (clawback branch) =================
  console.log('\n[settlement: every number labelled, on the clawback branch]');
  if (/Settlement summary/i.test(settled)) ok('the settlement summary is shown to the party');
  else no('no settlement summary on the resolved card');

  // A line renders as: label / optional hint / amount. The hints run to ~65 chars (the clawback
  // one is the longest), so the window between label and amount has to clear them — but stay well
  // short of the NEXT line's amount, or every assertion would match its neighbour's number.
  const lineIn = (hay, label, amount, sign = '') =>
    new RegExp(`${label}[\\s\\S]{0,160}?${sign}₹${money(amount)}`, 'i').test(hay);
  const line = (label, amount, sign = '') => lineIn(settled, label, amount, sign);

  if (line('The customer paid', AMOUNT)) ok(`"The customer paid" ₹${money(AMOUNT)}`);
  else no('the amount paid is wrong/absent: ' + (settled.match(/customer paid[^\n]*/i)?.[0] ?? 'absent'));
  if (line('Platform fee', FEE)) ok(`"Platform fee" ₹${money(FEE)}`);
  else no('the platform fee is wrong/absent: ' + (settled.match(/Platform fee[^\n]*/i)?.[0] ?? 'absent'));
  if (line('Paid into your wallet', PAYOUT)) ok(`"Paid into your wallet" ₹${money(PAYOUT)} — what the provider had received`);
  else no('the provider payout is wrong/absent: ' + (settled.match(/Paid into your wallet[^\n]*/i)?.[0] ?? 'absent'));
  if (line('Refunded to the customer', AMOUNT)) ok(`"Refunded to the customer" ₹${money(AMOUNT)}`);
  else no('the refund line is wrong/absent: ' + (settled.match(/Refunded[^\n]*/i)?.[0] ?? 'absent'));
  if (line('Clawed back from your wallet', AMOUNT, MINUS))
    ok(`🔴 "Clawed back from your wallet" −₹${money(AMOUNT)} — the escrow was already out, and the card says so`);
  else no('the clawback line is wrong/absent: ' + (settled.match(/Clawed back[^\n]*/i)?.[0] ?? 'absent'));
  if (line('You keep', FEE, MINUS)) ok(`"You keep" −₹${money(FEE)} — the provider ends below zero by exactly the fee already taken`);
  else no('the provider net is wrong/absent: ' + (settled.match(/You keep[^\n]*/i)?.[0] ?? 'absent'));
  if (line('The customer finally paid', 0)) ok('"The customer finally paid" ₹0');
  else no('the customer net is wrong/absent: ' + (settled.match(/finally paid[^\n]*/i)?.[0] ?? 'absent'));

  // the DB agrees with what the screen claims
  const { data: wt } = await service.from('wallet_transactions')
    .select('type, amount').eq('reference_id', bookingId).eq('user_id', providerUserId);
  const debit = (wt ?? []).find((r) => r.type === 'debit');
  if (debit && Math.abs(Number(debit.amount) - AMOUNT) < 0.01)
    ok(`...and the ledger agrees: a real ₹${money(AMOUNT)} debit was written against the provider`);
  else no('no matching clawback debit in wallet_transactions: ' + JSON.stringify(wt));

  // ================= 5) the admin was told, and the link lands =================
  console.log('\n[admin: notified on raise, straight to the case]');
  const { data: adminNote } = await service.from('notifications')
    .select('title, link').eq('user_id', adminId).eq('link', `/admin/disputes/${disputeId}`).maybeSingle();
  if (adminNote) ok(`raise_dispute notified the admin — "${adminNote.title}" → ${adminNote.link}`);
  else no('no admin notification row for this dispute');

  await signInAs(ADMIN_EMAIL, ADMIN_PASSWORD, 'the admin');
  await evaluate(`window.location.assign('/notifications')`);
  await rendered('Notifications');
  const notes = await text();
  if (/New dispute to review/i.test(notes)) ok('it appears in the admin\'s notification list');
  else no('the admin notification is not listed: ' + notes.replace(/\s+/g, ' ').slice(0, 300));

  if (await clickContaining('New dispute to review')) ok('clicked it');
  else no('could not click the admin notification');
  await rendered('Resolve|Settled|chat thread');
  const landedOn = await evaluate('location.pathname');
  if (landedOn === `/admin/disputes/${disputeId}`) ok(`...and it lands on the case itself (${landedOn})`);
  else no(`the notification went to ${landedOn}, expected /admin/disputes/${disputeId}`);

  // ================= 6) identification + contacts on the admin case =================
  console.log('\n[admin: the case names both parties]');
  // The settlement card fetches the ledger on mount, so the page has a "Loading the settlement…"
  // beat after the rest of the bundle is up. Read only once it has landed, or the assertions below
  // are timing, not behaviour.
  let settlementLanded = true;
  try {
    await waitFor("!/Loading the settlement/i.test(document.body.innerText)",
      { label: 'the admin settlement card to finish loading', timeout: 20000 });
  } catch { settlementLanded = false; }
  await sleep(500);
  const bundle = await text();
  if (!settlementLanded) no('the admin settlement card never finished loading (stuck on "Loading the settlement…")');
  if (new RegExp(`Raised by ${nameRe} \\(customer\\)`, 'i').test(bundle)) ok('the case header names the raiser');
  else no('the admin header does not name the raiser: ' + (bundle.match(/Raised by[^\n]*/)?.[0] ?? 'absent'));
  if (businessName && new RegExp(`against ${businessName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(provider\\)`, 'i').test(bundle))
    ok('...and the party it is against');
  else no('the admin header does not name the accused: ' + (bundle.match(/against[^\n]*/)?.[0] ?? 'absent'));
  if (bundle.includes(COMPLAINT.slice(0, 40))) ok('...and shows the complaint under "What the customer reported"');
  else no('the complaint is not on the admin case');
  if (/raised this dispute/i.test(bundle) && /responding party/i.test(bundle))
    ok('the contact cards mark which side raised it');
  else no('the contact cards do not mark the sides');
  if (cat?.name && new RegExp(`Service: ${cat.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(bundle))
    ok(`...and carry the service category ("Service: ${cat.name}")`);
  else no('the contact cards do not show the service category');
  if (!/Contact details unavailable/.test(bundle) && /Visible to admins only/i.test(bundle))
    ok('...with both parties\' contact details resolved, labelled admin-only');
  else no('contact details did not load');
  // Same card, neutral labels: the admin is neither party, so it reads "the provider" rather than
  // "you". Assert the NUMBERS, not just the heading — a card that renders with the wrong figures
  // is worse than one that is missing.
  if (/Settled/i.test(bundle) && lineIn(bundle, "Recovered from the provider['’]s wallet", AMOUNT, MINUS)
      && lineIn(bundle, 'The provider keeps', FEE, MINUS))
    ok(`the admin sees the same settlement, in third person: recovered −₹${money(AMOUNT)}, provider keeps −₹${money(FEE)}`);
  else no('the admin settlement card is missing/wrong: '
    + (bundle.match(/Recovered from[^\n]*|The provider keeps[^\n]*/g)?.join(' | ') ?? 'no lines')
    + ' | heading=' + /Settled/i.test(bundle)
    + ' | says-no-payment=' + /No online payment was captured/i.test(bundle));

  // ================= 7) the queue reads like a human wrote it =================
  console.log('\n[admin: the queue]');
  await evaluate(`window.location.assign('/admin/disputes')`);
  await rendered('Dispute Queue');
  await waitFor("!document.body.innerText.includes('Loading disputes…')", { label: 'the queue to load', timeout: 25000 });
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().toLowerCase().startsWith('resolved')); if (b) b.click(); })()`);
  await sleep(800);
  const queue = await text();
  if (new RegExp(`raised by ${nameRe} \\(customer\\)`, 'i').test(queue))
    ok('the queue row names the raiser instead of "raised by the customer"');
  else no('the queue row is still impersonal: ' + (queue.match(/raised by[^\n]*/i)?.[0] ?? 'absent'));
  if (new RegExp(REASON_LABEL_SHORT, 'i').test(queue)) ok(`...tagged "${REASON_LABEL_SHORT}"`);
  else no('the reason is missing from the queue row');
  if (queue.includes(COMPLAINT.slice(0, 30))) ok('...and previews the complaint');
  else no('the queue row does not preview the complaint');

  if (!pageExceptions.length) ok('no uncaught page exceptions during the flow');
  else no('uncaught page exceptions: ' + JSON.stringify(pageExceptions.slice(0, 3)));
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
} finally {
  console.log('\n[cleanup]');
  try {
    if (bookingId) {
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
      if (disputeId) await service.from('notifications').delete().like('link', `/admin/disputes/${disputeId}%`);
      await service.from('bookings').delete().eq('id', bookingId); // cascades dispute/paytx/messages/events
      console.log('  seeded booking, dispute, chat, events and ledger rows removed');
      if (providerId) await service.rpc('compute_reputation', { p_subject_type: 'provider', p_subject_id: providerId });
      if (customerId) await service.rpc('compute_reputation', { p_subject_type: 'customer', p_subject_id: customerId });
      console.log('  reputations recomputed');
    }
    if (customerNameSeeded && customerId) {
      await service.from('profiles').update({ full_name: customerNameOriginal }).eq('id', customerId);
      console.log(`  customer full_name restored to ${JSON.stringify(customerNameOriginal)}`);
    }
  } catch (e) { console.log('  cleanup problem: ' + (e?.message ?? e)); }
  try { ws?.close(); } catch {}
  try { chrome?.kill(); } catch {}
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
