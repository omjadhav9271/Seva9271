/*
  Drives real Chrome against the admin console (the admin cleanup pass).

  Why a browser check and not just DB assertions: every defect this pass fixed was a WIRING
  defect. The provider queue was fully built and unreachable, /admin did not exist, and trust_tier
  was computed correctly but had no SELECT grant so it rendered nowhere. None of that is visible
  from the database — the DB was right the whole time. Only a browser can tell you a page is
  reachable and showing what it computed.

  What it checks:
    (a) THE ADMIN NAV IS ADMIN-SHAPED — no "Become a Provider", no wallet; the four admin
        surfaces instead. (item 17)
    (b) EVERY ADMIN PAGE RENDERS ITS OWN CONTENT — /admin, /admin/providers, /admin/categories,
        /admin/disputes, and the tab strip on each. (items 12, 15)
    (c) THE QUEUE OPENS A DECISION PAGE — the row is a link to the approve/reject screen. (item 12)
    (d) A NON-ADMIN IS UNCHANGED AND SHUT OUT — the customer still sees the normal nav, and
        /admin/categories bounces them.

  Every assertion checks for specific on-page text, and each navigation is gated on a
  not-blank/not-404 body first: a check that only greps for a string it expects to be ABSENT
  passes just as happily against a 404 page, which is how an unreachable page stays green.

  Usage — credentials come from .env.local (see .env.example):
    node scripts/ui-check-admin.mjs
*/
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { account } from './lib/creds.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const admin = account('ADMIN');
const customer = account('CUSTOMER');

let pass = 0, fail = 0, skip = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sk = (m) => { console.log('  – SKIP  ' + m); skip++; };
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
const path = () => evaluate('location.pathname');

const REACT_SET = `
function reactSet(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}`;

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

/* Navigate and refuse to proceed against a page that did not actually render.

   This is the guard that matters. `waitFor` on a marker string is not enough on its own for the
   ABSENCE checks below — "Become a Provider is not in the nav" is trivially true of a 404 page,
   an error boundary, and a blank screen. So every page is first proven to be a real, populated
   render, and only then interrogated.

   `settle` is the second half of that. Every one of these pages paints its heading immediately and
   fills in from an async fetch afterwards, so asserting on the heading alone reads an empty page
   and reports the content missing. Each caller passes the app's OWN loading marker to wait out. */
async function goto(route, marker, label, settle = null) {
  await evaluate(`window.location.assign(${JSON.stringify(route)})`);
  await sleep(600);
  await waitFor(`document.body && document.body.innerText.length > 200`, { label: `${label} to render` });
  const body = await text();
  if (/This page could not be found|404/.test(body) && !body.includes(marker)) {
    throw new Error(`${label} rendered a 404`);
  }
  await waitFor(`document.body.innerText.includes(${JSON.stringify(marker)})`,
    { label: `"${marker}" on ${label}` });
  if (settle) await waitFor(settle, { label: `${label} to finish loading`, timeout: 25000 });
  return text();
}

// The nav links live in the header; scoping to it keeps page BODY copy from being mistaken for
// navigation (the admin overview page legitimately describes the other admin surfaces in prose).
const navText = () => evaluate(`(() => { const n = document.querySelector('nav') || document.querySelector('header'); return n ? n.innerText : ''; })()`);

// ---------------------------------------------------------------- run
let chrome = null;
try {
  if (!CHROME) { console.log('Cannot run: Chrome not found.'); process.exit(0); }
  if (!admin.email || !admin.password || !customer.email || !customer.password) {
    console.log('Cannot run: missing ADMIN_/CUSTOMER_ credentials in .env.local.'); process.exit(0);
  }
  try {
    const r = await fetch(APP, { signal: AbortSignal.timeout(45000) });
    if (!r.ok && r.status >= 500) throw new Error('bad status');
  } catch { console.log('Cannot run: dev server not answering on :3000 — start `npm run dev`.'); process.exit(0); }

  const profile = mkdtempSync(join(tmpdir(), 'seva-cdp-admin-'));
  // The desktop nav is `hidden md:flex`. Headless Chrome's default viewport is narrower than the
  // md breakpoint, so at the default size the admin links are display:none, innerText omits them,
  // and every nav assertion below fails against a perfectly correct navbar.
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9223', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1440,900', 'about:blank',
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
  await send('Page.enable'); await send('Runtime.enable');
  // --window-size alone does not always settle the layout viewport in headless; pin it.
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  console.log('driving real Chrome (headless) against ' + APP + '\n');

  // ───────────────────────────────────────────────────────── admin
  console.log('[sign in as the admin]');
  await signInAs(admin.email, admin.password, 'the admin');
  ok('signed in through the real sign-in form');

  // (b) /admin exists at all — it 404'd before this pass.
  console.log('\n[b) /admin — the hub]');
  {
    // Settle on all three counts being numeric. A card stuck on the "—" placeholder means its
    // fetch failed and the hub is decorative, which is the failure worth catching here.
    const COUNTS_IN = `/\\d+\\s+open/i.test(document.body.innerText)
      && /\\d+\\s+to review/i.test(document.body.innerText)
      && /\\d+\\s+live/i.test(document.body.innerText)`;
    const body = await goto('/admin', 'Admin', '/admin', COUNTS_IN);
    ok('/admin renders (it 404\'d before this pass)');
    for (const card of ['Disputes', 'Provider applications', 'Service categories']) {
      if (body.includes(card)) ok(`the overview offers "${card}"`);
      else no(`the overview is missing "${card}"`);
    }
    const counts = (body.match(/\d+\s+(open|to review|live)/gi) ?? [])
      .map((c) => c.replace(/\s+/g, ' ')).join(' · ');
    ok('every card resolved a real count: ' + counts);
  }

  // (a) item 17 — the nav is admin-shaped.
  console.log('\n[a) item 17 — an admin does not see customer navigation]');
  {
    const nav = await navText();
    if (!/Become a Provider/i.test(nav)) ok('"Become a Provider" is gone from the admin nav');
    else no('an admin is still offered "Become a Provider"');
    for (const link of ['Admin', 'Disputes', 'Providers', 'Categories']) {
      if (nav.includes(link)) ok(`the admin nav offers "${link}"`);
      else no(`the admin nav is missing "${link}"`);
    }
    // An admin holds no balance; a wallet button reading ₹0 would be a claim about money.
    const wallet = await evaluate(`(() => { const n = document.querySelector('nav') || document.querySelector('header');
      return n ? /₹/.test(n.innerText) : false; })()`);
    if (!wallet) ok('no wallet balance in the admin nav');
    else no('the admin nav still shows a wallet balance');
  }

  // (b)+(c) item 12 — the queue is reachable and opens a decision page.
  console.log('\n[b/c) item 12 — the provider queue is reachable and opens a decision]');
  {
    const body = await goto('/admin/providers', 'Provider Applications', '/admin/providers',
      `!document.body.innerText.includes('Loading applications')`);
    ok('/admin/providers renders the queue');
    for (const tab of ['Overview', 'Disputes', 'Providers', 'Categories']) {
      if (body.includes(tab)) ok(`the admin tab strip offers "${tab}"`);
      else no(`the admin tab strip is missing "${tab}"`);
    }
    // Case-insensitive on purpose: the tab is styled `capitalize`, and innerText reports text as
    // rendered, so the JSX's "To review" reaches this assertion as "To Review".
    if (/to review/i.test(body)) ok('the queue has a "To review" tab');
    else no('the queue has no "To review" tab');

    // The queue is only reachable if its rows go somewhere.
    const href = await evaluate(`(() => { const a = [...document.querySelectorAll('a')]
      .find(a => /^\\/admin\\/providers\\/[0-9a-f-]{36}$/.test(new URL(a.href).pathname));
      return a ? new URL(a.href).pathname : null; })()`);
    if (href) {
      const detail = await goto(href, 'Decision', 'the application detail page',
        `!document.body.innerText.includes('Loading application')`);
      ok('a queue row opens the approve/reject page');
      if (/Tier \d/.test(detail)) ok('the decision page shows the applicant\'s trust tier (item 21)');
      else no('the decision page does not show a trust tier');
    } else {
      // Not a pass: with no rows, "reachable" is unproven. Say so rather than counting it green.
      no('no application row to open — the queue is empty, so item 12 could not be proven end to end');
    }
  }

  // item 15 — the categories screen.
  console.log('\n[item 15 — the categories screen]');
  {
    const body = await goto('/admin/categories', 'Service Categories', '/admin/categories',
      `!document.body.innerText.includes('Loading categories')`);
    ok('/admin/categories renders');
    if (/Add a category/.test(body)) ok('an admin is offered "Add a category"');
    else no('the "Add a category" control is missing');
    // Real rows, with the slug the router actually uses.
    const slugs = await evaluate(`(() => (document.body.innerText.match(/\\/[a-z0-9-]{3,}/g) || []).length)()`);
    if (slugs > 0) ok(`the screen lists real categories with their slugs (${slugs} shown)`);
    else no('no categories listed');
    // The usage counts drive whether a delete is even offered.
    if (/provider/.test(body) && /booking/.test(body)) ok('each category shows what a delete would cost (providers/bookings/listings)');
    else no('category usage counts are not shown — every row would offer an unsafe delete');

    /* An in-use category must not even OFFER a delete.

       verify-admin.mjs proves the RPC refuses it. This proves the screen withholds the button, so
       the refusal is not something you discover by clicking. Reading the row's own counts and
       comparing against its controls is the only honest way to check — asserting "some row says
       in use" would pass on a page that got the pairing backwards. */
    /* Anchor on the counts <p>, then walk UP to the row.

       Do not try to find rows by filtering every <div> for the counts text: the row's inner
       `flex-1` wrapper holds that text too, and the delete button is that wrapper's SIBLING, not
       its child. Matching the wrapper makes `hasBtn` false for every row — which turns the in-use
       assertion into a vacuous pass, since "no in-use row has a button" is then trivially true. */
    const guard = await evaluate(`(() => {
      const counts = [...document.querySelectorAll('p')]
        .filter(p => /\\d+ provider/.test(p.textContent) && /listing/.test(p.textContent));
      let used = 0, usedWithButton = 0, free = 0, freeWithButton = 0;
      for (const p of counts) {
        const row = p.parentElement && p.parentElement.parentElement;
        if (!row) continue;
        const m = p.textContent.match(/(\\d+) provider[s]? · (\\d+) booking[s]? · (\\d+) listing[s]?/);
        if (!m) continue;
        const total = Number(m[1]) + Number(m[2]) + Number(m[3]);
        const hasBtn = !!row.querySelector('button[aria-label^="Remove"]');
        if (total > 0) { used++; if (hasBtn) usedWithButton++; }
        else { free++; if (hasBtn) freeWithButton++; }
      }
      return { used, usedWithButton, free, freeWithButton };
    })()`);
    // If neither bucket found a button the walk-up is broken again, not the page.
    if (guard.free > 0 && guard.freeWithButton === 0 && guard.usedWithButton === 0)
      no('found no delete buttons at all — the row selector is wrong, not the page');
    if (guard.used === 0) sk('no in-use category on screen, so the withheld-delete guard was not exercised');
    else if (guard.usedWithButton === 0) ok(`every in-use category (${guard.used}) withholds its delete button`);
    else no(`${guard.usedWithButton} in-use categories still offer a delete button`);
    if (guard.free > 0 && guard.freeWithButton === guard.free) ok(`every unused category (${guard.free}) still offers a delete`);
    else if (guard.free > 0) no(`${guard.free - guard.freeWithButton} unused categories have no delete button — the guard is over-applied`);

    /* The create/delete ROUND TRIP, through the actual form.

       The RPC layer is covered by verify-admin.mjs. What is only checkable here is the WIRING —
       that the form calls the RPC, that the list refreshes afterwards, and that the row's delete
       button is bound to the right category. This whole pass existed because things were built and
       not wired, so reading the screen without operating it would have been the same mistake. */
    const stamp = Date.now();
    const NAME = `ZZ UI Check   Category!! ${stamp}`;
    const SLUG = `zz-ui-check-category-${stamp}`;

    await evaluate(`(() => { const b = [...document.querySelectorAll('button')]
      .find(x => x.textContent.trim() === 'Add a category'); if (b) b.click(); return !!b; })()`);
    await waitFor(`!!document.querySelector('input')`, { label: 'the new-category form' });
    await sleep(400);
    await evaluate(`(() => {
      ${REACT_SET}
      reactSet(document.querySelectorAll('input')[0], ${JSON.stringify(NAME)});
      return true;
    })()`);
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')]
      .find(x => /Add category/i.test(x.textContent) && !x.disabled); if (b) b.click(); return !!b; })()`);

    try {
      await waitFor(`document.body.innerText.includes(${JSON.stringify(SLUG)})`,
        { label: 'the new category in the list', timeout: 20000 });
      ok(`created a category through the form, and the list refreshed to show it (/${SLUG})`);
      // Messy input on purpose: the slug is what /services routes on, so normalisation is not cosmetic.
      ok('the doubled space, punctuation and capitals were normalised into the slug server-side');
    } catch {
      no('the category did not appear in the list after submitting the form');
    }

    // Delete it again through its own row button — and prove the row it removed was THIS one.
    // Same walk-up: the slug sits in the name <p>, the button hangs off that <p>'s grandparent.
    const removed = await evaluate(`(() => {
      const name = [...document.querySelectorAll('p')]
        .find(p => p.textContent.includes(${JSON.stringify(SLUG)}));
      const row = name && name.parentElement && name.parentElement.parentElement;
      const btn = row && row.querySelector('button[aria-label^="Remove"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    if (!removed) {
      no('the new category had no delete button — it is unused, so one should be offered');
    } else {
      try {
        await waitFor(`!document.body.innerText.includes(${JSON.stringify(SLUG)})`,
          { label: 'the category to disappear', timeout: 20000 });
        ok('deleted it again through the row button, and the list refreshed without it');
      } catch {
        no('the category is still listed after deleting it — the list did not refresh, or the delete failed');
      }
    }
  }

  console.log('\n[the dispute queue still works]');
  {
    await goto('/admin/disputes', 'Disputes', '/admin/disputes');
    ok('/admin/disputes still renders alongside the new tabs');
  }

  // ───────────────────────────────────────────────────────── non-admin
  console.log('\n[d) a non-admin is unchanged, and shut out]');
  {
    await signInAs(customer.email, customer.password, 'the customer');
    await goto('/', 'Seva', 'the homepage');
    const nav = await navText();
    if (/Become a Provider/i.test(nav)) ok('a customer still sees "Become a Provider" (nav unchanged for non-admins)');
    else no('"Become a Provider" vanished for a CUSTOMER — item 17 over-applied');
    if (!/Categories|Disputes/.test(nav)) ok('a customer is offered no admin links');
    else no('a customer can see admin navigation');

    // The guard, in the browser. The RPC refuses them anyway (verify-admin.mjs proves that);
    // this is the navigation half.
    await evaluate(`window.location.assign('/admin/categories')`);
    await sleep(3500);
    const landed = await path();
    const body = await text();
    if (landed !== '/admin/categories') ok(`a customer visiting /admin/categories is redirected to ${landed}`);
    else if (!/Add a category/.test(body)) ok('a customer reaching /admin/categories is shown no category controls');
    else no('a CUSTOMER was served the admin categories screen with its controls');
  }
} catch (e) {
  no('run aborted: ' + (e?.message ?? e));
} finally {
  try { chrome?.kill(); } catch {}
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
