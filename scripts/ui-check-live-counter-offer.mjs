/*
  Item 19, the half I had not proven: a COUNTER-OFFER reaching the other party's OPEN page with no
  refresh.

  ui-check-dispute-clarity proves the realtime mechanism end-to-end, but through the `disputes`
  table. The counter-offer path is genuinely different and is the one that was broken: respond_offer's
  counter branch writes ONLY to `offers` — it never touches `bookings` — so the page-level bookings
  subscription could not see it, and the other side sat on the previous round until they reloaded.
  Proving the dispute stream works does NOT prove this one; only a real counter does.

  It needs TWO independent browser sessions (localStorage is per-profile), so this spawns TWO Chrome
  instances on separate ports and user-data-dirs, signs the customer into one and the provider into
  the other, parks both on the same booking, then counters FROM THE UI in one window and watches the
  other change on its own.

  Usage (needs `npm run dev` on :3000, credentials in .env.local — see .env.example):
    node scripts/ui-check-live-counter-offer.mjs
*/
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { requireAccounts } from './lib/creds.mjs';

const APP = 'http://localhost:3000';
const { CUSTOMER, PROVIDER } = requireAccounts(['CUSTOMER', 'PROVIDER']);

const LIST = 900, FLOOR = 400, THRESHOLD = 850;   // OPEN and COUNTER must sit between floor and threshold
const OPEN_OFFER = 500;    // the customer's opening offer: above floor, below instant-accept
const COUNTER = 700;       // the provider's counter
const TAG = 'LIVE-COUNTER-UI-CHECK';

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

const REACT_SET = `
function reactSet(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}`;

/* ---------------------------------------------------------------- one browser, self-contained.
   The single-connection globals the other checks use cannot drive two browsers at once, so each
   window owns its own socket, id counter and pending map. */
async function openBrowser(port, label) {
  const profile = mkdtempSync(join(tmpdir(), `seva-cdp-live-${port}-`));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error(`${label}: Chrome did not expose a debugging target on ${port}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`${label}: ws failed`)); });

  let msgId = 0;
  const pending = new Map();
  const exceptions = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      const desc = d?.exception?.description ?? d?.text ?? '';
      if (!/ResizeObserver|Failed to load resource/i.test(desc)) exceptions.push(desc.split('\n')[0]);
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };

  const send = (method, params = {}) => {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, 30000);
    });
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page JS error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result?.value;
  };
  const waitFor = async (expression, { timeout = 20000, lbl = expression } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await evaluate(expression)) return true; } catch { /* mid-navigation */ }
      await sleep(300);
    }
    throw new Error(`${label}: timed out waiting for ${lbl}`);
  };
  const text = () => evaluate('document.body ? document.body.innerText : ""');

  await send('Page.enable'); await send('Runtime.enable');

  const SESSION = "!!localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sb-')) || '')";
  const signIn = async (email, password) => {
    let lastState = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      await evaluate("localStorage.clear()").catch(() => {});
      await send('Page.navigate', { url: `${APP}/auth/signin` });
      await waitFor("!!document.querySelector('input[type=password]')", { lbl: 'the sign-in form', timeout: 60000 });
      await sleep(2500); // hydration: a value set before React attaches is wiped on re-render
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
      if (!filled) { lastState = 'form never accepted a value (not hydrated)'; continue; }
      await evaluate(`(() => { const f = document.querySelector('form'); if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); return true; }
        const b = [...document.querySelectorAll('button')].find(x => /sign in/i.test(x.textContent)); if (b) { b.click(); return true; } return false; })()`);
      try { await waitFor(SESSION, { lbl: 'a stored Supabase session', timeout: 30000 }); return; }
      catch { lastState = (await text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200); }
    }
    throw new Error(`${label}: could not sign in as ${email} — ${lastState}`);
  };

  return {
    label, evaluate, waitFor, text, signIn, exceptions,
    goto: (path) => evaluate(`window.location.assign(${JSON.stringify(path)})`),
    close: () => { try { ws.close(); } catch {} try { proc.kill(); } catch {} },
  };
}

// ---------------------------------------------------------------- run
let customerWin = null, providerWin = null, bookingId = null, providerId = null;
let originalPricing = null;

try {
  if (!CHROME) { console.log('Cannot run: Chrome not found.'); process.exit(0); }
  try {
    const r = await fetch(APP, { signal: AbortSignal.timeout(45000) });
    if (!r.ok && r.status >= 500) throw new Error('bad status');
  } catch { console.log('Cannot run: dev server not answering on :3000 — start `npm run dev`.'); process.exit(0); }

  const { data: { users } } = await service.auth.admin.listUsers({ perPage: 200 });
  const customerId = users.find((u) => u.email === CUSTOMER.email)?.id;
  const providerUserId = users.find((u) => u.email === PROVIDER.email)?.id;
  if (!customerId || !providerUserId) { console.log('Cannot run: test accounts not found.'); process.exit(1); }

  const { data: sp } = await service.from('service_providers')
    .select('id, pricing_mode, list_price, floor_price, auto_accept_threshold, max_counter_rounds')
    .eq('user_id', providerUserId).eq('status', 'approved').maybeSingle();
  if (!sp) { console.log('Cannot run: the provider account owns no approved provider row.'); process.exit(1); }
  providerId = sp.id;
  originalPricing = {
    pricing_mode: sp.pricing_mode, list_price: sp.list_price, floor_price: sp.floor_price,
    auto_accept_threshold: sp.auto_accept_threshold, max_counter_rounds: sp.max_counter_rounds,
  };

  // negotiable, with room for a counter between floor and instant-accept
  await service.from('service_providers').update({
    pricing_mode: 'negotiable', list_price: LIST, floor_price: FLOOR,
    auto_accept_threshold: THRESHOLD, max_counter_rounds: 3,
  }).eq('id', providerId);

  // clear any negotiation left over from a previous run (one open per pair)
  await service.from('bookings').delete()
    .eq('customer_id', customerId).eq('provider_id', providerId).in('status', ['negotiating', 'expired']);

  // Open the negotiation as the CUSTOMER through the real RPC, so the booking is born the way the
  // app makes it (start_negotiation is the only entrance).
  const custClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  {
    const { error } = await custClient.auth.signInWithPassword({ email: CUSTOMER.email, password: CUSTOMER.password });
    if (error) throw new Error('customer sign-in (node): ' + error.message);
  }
  const { data: offerRow, error: offErr } = await custClient.rpc('start_negotiation', {
    p_provider_id: providerId, p_amount: OPEN_OFFER, p_service_type: 'one-time',
    p_scheduled_date: '2026-09-10', p_scheduled_time: '11:00', p_duration_hours: 2,
    p_notes: TAG, p_address: 'Bandra, Mumbai',
  });
  if (offErr) throw new Error('start_negotiation: ' + offErr.message);
  const offer = Array.isArray(offerRow) ? offerRow[0] : offerRow;
  bookingId = offer?.booking_id;
  if (!bookingId) throw new Error('start_negotiation returned no booking');
  if (offer.status !== 'pending') {
    throw new Error(`opening offer came back '${offer.status}' — expected pending (₹${OPEN_OFFER} must sit between floor ₹${FLOOR} and instant-accept ₹${THRESHOLD})`);
  }

  // pre-warm (next dev compiles per route on first hit)
  for (const p of ['/auth/signin', `/bookings/${bookingId}`]) {
    try { await fetch(APP + p, { signal: AbortSignal.timeout(180000) }); } catch { /* compiling is the point */ }
  }

  console.log(`seeded negotiation on booking ${bookingId} — customer opened at ₹${money(OPEN_OFFER)}\n`);

  // ---- two independent browsers ----
  console.log('[two windows, two sessions]');
  [customerWin, providerWin] = await Promise.all([
    openBrowser(9231, 'customer-window'),
    openBrowser(9232, 'provider-window'),
  ]);
  await customerWin.signIn(CUSTOMER.email, CUSTOMER.password);
  await providerWin.signIn(PROVIDER.email, PROVIDER.password);
  ok('signed the customer and the provider into two separate browsers');

  await Promise.all([customerWin.goto(`/bookings/${bookingId}`), providerWin.goto(`/bookings/${bookingId}`)]);
  await Promise.all([
    customerWin.waitFor("/Price under negotiation/i.test(document.body.innerText)", { lbl: 'the negotiation panel (customer)', timeout: 40000 }),
    providerWin.waitFor("/Price under negotiation/i.test(document.body.innerText)", { lbl: 'the negotiation panel (provider)', timeout: 40000 }),
  ]);
  ok('both windows are parked on the same booking, negotiation panel open');

  const custBefore = await customerWin.text();
  if (new RegExp(`Round 1[\\s\\S]{0,80}₹${money(OPEN_OFFER)}`).test(custBefore)) ok(`the customer sees their round-1 offer of ₹${money(OPEN_OFFER)}`);
  else no('round 1 is not shown to the customer: ' + (custBefore.match(/Round 1[^\n]*/)?.[0] ?? 'absent'));
  if (/Waiting on the provider/i.test(custBefore)) ok('...and that it is the provider\'s move');
  else no('turn indicator wrong for the customer: ' + (custBefore.match(/(Your move|Waiting on)[^\n]*/)?.[0] ?? 'absent'));

  const provBefore = await providerWin.text();
  if (/Your move/i.test(provBefore)) ok('the provider is told it is their move');
  else no('turn indicator wrong for the provider');
  if (!new RegExp(`Round 2`).test(provBefore)) ok('neither window shows a round 2 yet');
  else no('a round 2 exists before the counter was made');

  // remember the customer's page identity, to prove no navigation happened
  const custHrefBefore = await customerWin.evaluate('location.href');
  const custMarker = await customerWin.evaluate(
    "(() => { window.__liveMarker = window.__liveMarker || Math.random().toString(36).slice(2); return window.__liveMarker; })()");

  // ================= THE TEST: provider counters in their window, customer's window must move =====
  console.log('\n[the provider counters — the customer never touches their browser]');
  await providerWin.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Counter');
    if (b) b.click(); return !!b;
  })()`);
  await sleep(700);
  const typed = await providerWin.evaluate(`(() => {
    ${REACT_SET}
    const el = document.querySelector('input[type=number]');
    if (!el) return 'no counter input';
    reactSet(el, '${COUNTER}');
    return el.value;
  })()`);
  if (String(typed) === String(COUNTER)) ok(`the provider typed a ₹${money(COUNTER)} counter into the real form`);
  else no('could not enter the counter amount: ' + typed);

  await providerWin.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Send counter/i.test(x.textContent));
    if (b) b.click(); return !!b;
  })()`);

  // the provider's own window should settle first (it refetches after the RPC)
  try {
    await providerWin.waitFor(`/Round 2/.test(document.body.innerText)`, { lbl: 'round 2 in the provider window', timeout: 20000 });
    ok('the counter was accepted — the provider window shows round 2');
  } catch (e) {
    no('the counter never went through: ' + e.message);
  }

  // 🔴 the actual claim: the CUSTOMER's untouched window updates by itself
  let liveOk = false;
  try {
    await customerWin.waitFor(
      `/Round 2/.test(document.body.innerText) && document.body.innerText.includes('₹${money(COUNTER)}')`,
      { lbl: 'round 2 appearing in the customer window with no reload', timeout: 25000 });
    liveOk = true;
  } catch { /* asserted below */ }

  const custHrefAfter = await customerWin.evaluate('location.href');
  const custMarkerAfter = await customerWin.evaluate('window.__liveMarker');
  const sameDocument = custHrefAfter === custHrefBefore && custMarkerAfter === custMarker;

  if (liveOk && sameDocument)
    ok(`🔴 the customer's OPEN page showed the ₹${money(COUNTER)} counter with no reload — same document, same URL`);
  else if (liveOk && !sameDocument)
    no('the customer window did update, but the document was replaced — that is a reload, not a live update');
  else
    no('the customer window never showed the counter — realtime did not deliver the offer change');

  const custAfter = await customerWin.text();
  if (/Your move/i.test(custAfter)) ok('...and the turn indicator flipped to the customer, live');
  else no('the turn indicator did not flip: ' + (custAfter.match(/(Your move|Waiting on)[^\n]*/)?.[0] ?? 'absent'));
  if (new RegExp(`Accept ₹${money(COUNTER)}`).test(custAfter)) ok(`...offering "Accept ₹${money(COUNTER)}" without a refresh`);
  else no('the accept button did not appear live: ' + (custAfter.match(/Accept[^\n]*/)?.[0] ?? 'absent'));

  // the DB agrees with the screen
  const { data: offers } = await service.from('offers')
    .select('round, amount, status, actor_role').eq('booking_id', bookingId).order('round');
  const r2 = (offers ?? []).find((o) => o.round === 2);
  if (r2 && Number(r2.amount) === COUNTER && r2.actor_role === 'provider' && r2.status === 'pending')
    ok(`the ledger agrees: round 2 = ₹${money(COUNTER)} from the provider, pending`);
  else no('offers table does not match the screen: ' + JSON.stringify(offers));

  // notification lands on CURRENT state, not stale (the item-19 wording)
  const { data: note } = await service.from('notifications')
    .select('title, link').eq('user_id', customerId).like('link', `/bookings/${bookingId}%`)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (note?.link === `/bookings/${bookingId}`)
    ok(`the customer's notification points at the booking ("${note.title}") — which now renders the current round`);
  else no('no counter notification for the customer: ' + JSON.stringify(note));

  const allExceptions = [...customerWin.exceptions, ...providerWin.exceptions];
  if (!allExceptions.length) ok('no uncaught page exceptions in either window');
  else no('uncaught page exceptions: ' + JSON.stringify(allExceptions.slice(0, 3)));
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
} finally {
  console.log('\n[cleanup]');
  try {
    if (bookingId) {
      await service.from('notifications').delete().like('link', `/bookings/${bookingId}%`);
      await service.from('bookings').delete().eq('id', bookingId);  // cascades offers + events
      console.log('  seeded negotiation removed');
    }
    if (providerId && originalPricing) {
      await service.from('service_providers').update(originalPricing).eq('id', providerId);
      console.log('  provider pricing restored');
    }
  } catch (e) { console.log('  cleanup problem: ' + (e?.message ?? e)); }
  customerWin?.close();
  providerWin?.close();
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
