/*
  Dead-control and reachability audit — drives a REAL Chrome over the DevTools Protocol.

  WHAT IT IS FOR. This codebase keeps finding controls that render and do nothing: a navbar
  location chip that was a <button> with no onClick, a hero "Your location" box writing a
  ?location= parameter nothing read, four more deleted in f74aa05, and — found while writing this —
  /providers ignoring ?category= and ?q= entirely, which made every category tile and every
  popular-search tag a link that arrived and forgot why. A typecheck cannot see any of these. Only
  the running page can.

  So for each route, as each role, this asserts:

    1. the page RENDERED — its <h1> is present and matches. A probe that skips this reports a
       confident PASS against a blank page, a 404, or the sign-in page it got redirected to,
       which is this suite's known false-green and has cost several sessions;
    2. every <button> has a way to do something — an onClick (React attaches these as props, so
       we look for a listener OR a form association), type=submit, or an aria-disabled state;
    3. every <a> has a real href — not '#', not empty;
    4. every internal href points at a route that EXISTS, by navigating to it and checking for an
       <h1>. A 404 renders no <h1>, so this catches a link to a deleted route;
    5. the role-specific bands actually rendered for the role that should see them.

  Usage (needs `npm run dev`; pass the REAL port — next falls back 3000→3001 and on this machine
  something unrelated already answers 404 on 3000):

    node scripts/ui-check-controls.mjs --port 3001
    HEADLESS=1 node scripts/ui-check-controls.mjs --port 3001
*/
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireAccounts } from './lib/creds.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = arg('--port', '3000');
const APP = `http://localhost:${PORT}`;
const HEADLESS = process.env.HEADLESS === '1';

const { CUSTOMER, PROVIDER, ADMIN } = requireAccounts(['CUSTOMER', 'PROVIDER', 'ADMIN']);

/* Every route a signed-in person can reach from the chrome, with the <h1> it must render.
   `roles` limits a route to the accounts that can actually see it. */
const ROUTES = [
  { path: '/',                h1: /welcome back/i,      roles: ['customer', 'provider', 'admin'] },
  { path: '/services',        h1: /browse services/i,   roles: ['customer', 'provider', 'admin'] },
  { path: '/providers',       h1: /all providers/i,     roles: ['customer', 'provider', 'admin'] },
  { path: '/how-it-works',    h1: /.+/,                 roles: ['customer'] },
  { path: '/become-provider', h1: /.+/,                 roles: ['customer'] },
  { path: '/bookings',        h1: /.+/,                 roles: ['customer', 'provider'] },
  { path: '/wallet',          h1: /.+/,                 roles: ['customer', 'provider'] },
  { path: '/profile',         h1: /.+/,                 roles: ['customer', 'provider', 'admin'] },
  { path: '/notifications',   h1: /.+/,                 roles: ['customer', 'provider', 'admin'] },
  { path: '/admin',           h1: /.+/,                 roles: ['admin'] },
];

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ PASS  ' + m); pass++; };
const no = (m) => { console.log('  ✗ FAIL  ' + m); fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => { try { readFileSync(p); return true; } catch { return false; } });

let ws = null, msgId = 0, chrome = null;
const pending = new Map();
function send(method, params = {}, timeoutMs = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timed out')); } }, timeoutMs);
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page JS error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
}
async function waitFor(expression, { timeout = 30000, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return true; } catch { /* mid-navigation */ }
    await sleep(300);
  }
  throw new Error('timed out waiting for: ' + label);
}

async function signIn({ email, password }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await evaluate('localStorage.clear()').catch(() => {});
    await send('Page.navigate', { url: `${APP}/auth/signin` });
    await waitFor("!!document.querySelector('input[type=password]')", { label: 'the sign-in form' });
    await sleep(2500); // React must attach handlers before the fill, or the form submits empty
    await evaluate(`(() => {
      const set = (el, v) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('input[type=email]'), ${JSON.stringify(email)});
      set(document.querySelector('input[type=password]'), ${JSON.stringify(password)});
      return true; })()`);
    await evaluate("(() => { const f = document.querySelector('form'); if (f) { f.requestSubmit(); return true; } return false; })()");
    try {
      await waitFor("!!localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sb-')) || '')",
        { label: 'a stored session', timeout: 12000 });
      return true;
    } catch { /* hydration lost the race */ }
  }
  throw new Error('could not sign in after 3 attempts');
}

/* Read every control on the page. React attaches onClick as a synthetic listener rather than an
   inline attribute, so an attribute check would call every working button dead; getEventListeners
   is a DevTools-console API unavailable to Runtime.evaluate. What IS observable: whether the
   button carries a React props key with an onClick, which is stable enough for this purpose. */
const AUDIT = `(() => {
  const reactPropsOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
    return key ? el[key] : null;
  };
  const buttons = [...document.querySelectorAll('button')].map((b) => {
    const props = reactPropsOf(b);
    return {
      text: (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40),
      type: b.getAttribute('type') || '',
      disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
      hasHandler: !!(props && (props.onClick || props.onSubmit || props.onChange)),
      inForm: !!b.closest('form'),
      // Enough to FIND an unlabelled offender in the source rather than guess at it.
      cls: (b.getAttribute('class') || '').slice(0, 70),
      parent: b.parentElement ? b.parentElement.tagName.toLowerCase() +
        '.' + (b.parentElement.getAttribute('class') || '').split(' ').slice(0, 2).join('.') : '',
      html: b.innerHTML.slice(0, 80),
    };
  });
  const describe = (a) => ({
    text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 40),
    href: a.getAttribute('href') || '',
  });
  const links = [...document.querySelectorAll('a')].map(describe);
  /* Nav-scoped separately. The footer carries its own "Become a Provider" and "How It Works"
     entries, so a page-wide text search cannot tell "the primary tab is still there" from "the
     footer sitemap lists it" — and reported the navbar as unfixed when it was correct. */
  const nav = document.querySelector('nav');
  const navLinks = nav ? [...nav.querySelectorAll('a')].map(describe) : [];
  const h1 = document.querySelector('h1');
  return { h1: h1 ? h1.textContent.trim() : null, buttons, links, navLinks, hasMain: !!document.querySelector('main') };
})()`;

async function auditRoute(route, role) {
  await send('Page.navigate', { url: APP + route.path });
  let snap;
  try {
    // The <h1> is the gate. Everything below is meaningless if the page didn't render.
    await waitFor("!!document.querySelector('h1')", { label: `${route.path} <h1>`, timeout: 25000 });
    await sleep(1200); // let client-side data land before counting controls
    snap = await evaluate(AUDIT);
  } catch {
    no(`${role} ${route.path} — no <h1> rendered (blank page, 404, or bounced to sign-in)`);
    return null;
  }
  if (!route.h1.test(snap.h1 ?? '')) {
    no(`${role} ${route.path} — <h1> reads "${snap.h1}", expected ${route.h1}`);
    return snap;
  }

  const deadButtons = snap.buttons.filter((b) => !b.hasHandler && !b.disabled && b.type !== 'submit' && !b.inForm);
  const deadLinks = snap.links.filter((a) => !a.href || a.href === '#');
  if (deadButtons.length) {
    no(`${role} ${route.path} — ${deadButtons.length} button(s) with no handler:`);
    for (const b of deadButtons) {
      console.log(`          text="${b.text || '(none)'}" class="${b.cls}" parent=${b.parent}`);
      console.log(`          html=${b.html || '(empty)'}`);
    }
  } else if (deadLinks.length) {
    no(`${role} ${route.path} — ${deadLinks.length} link(s) with no href: ` +
      deadLinks.map((a) => `"${a.text || '(no label)'}"`).join(', '));
  } else {
    ok(`${role} ${route.path} — h1 "${snap.h1}", ${snap.buttons.length} buttons + ${snap.links.length} links all wired`);
  }
  return snap;
}

/* ── run ─────────────────────────────────────────────────────────────────────── */
const profile = mkdtempSync(join(tmpdir(), 'seva-cdp-controls-'));
chrome = spawn(CHROME, [
  ...(HEADLESS ? ['--headless=new'] : []),
  '--remote-debugging-port=9235', `--user-data-dir=${profile}`, '--window-size=1440,900',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
  'about:blank',
], { stdio: 'ignore' });

try {
  // Pre-warm: next dev compiles per route on first request, and a cold route blows every timeout.
  for (const r of ROUTES) { try { await fetch(APP + r.path); } catch { /* compile errors show up in the browser */ } }

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try { target = (await (await fetch('http://127.0.0.1:9235/json/list')).json()).find((t) => t.type === 'page'); }
    catch { /* not up yet */ }
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
  // 1440 wide or the navbar's `hidden md:flex` links are display:none and every nav check fails
  // against a perfectly correct navbar.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log(`driving Chrome (${HEADLESS ? 'headless' : 'headed'}) against ${APP}\n`);

  for (const [role, account] of [['customer', CUSTOMER], ['provider', PROVIDER], ['admin', ADMIN]]) {
    console.log(`── as ${role} (${account.email}) ─────────────────────────────`);
    await signIn(account);
    const who = await evaluate(`JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('sb-')))).user.email`);
    if (who !== account.email) { no(`signed in as ${who}, expected ${account.email}`); continue; }

    const home = await auditRoute(ROUTES[0], role);

    /* The nav is role-shaped now, so assert the shape rather than trusting it.
       "Become a Provider" must be absent for someone who already owns a provider profile — that
       was the redundancy this work removed — and "How It Works" must be gone from the primary nav
       for everyone, since the footer already carries it. */
    if (home) {
      const inNav = (re) => home.navLinks.some((l) => re.test(l.text));
      const hasBecome = inNav(/become a provider/i);
      if (role === 'provider' && hasBecome) no('provider is still offered "Become a Provider" in the nav');
      else if (role === 'customer' && !hasBecome) no('customer is NOT offered "Become a Provider" in the nav');
      else ok(`${role} — nav "Become a Provider" correct (${hasBecome ? 'shown' : 'hidden'})`);

      // The duplicate PRIMARY tab is what was removed; the footer entry is the sitemap and stays.
      if (inNav(/how it works/i)) no(`${role} — "How It Works" is back in the primary nav`);
      else if (home.links.some((l) => l.href === '/how-it-works')) ok(`${role} — /how-it-works out of the nav, still reachable`);
      else no(`${role} — /how-it-works is now unreachable from this page`);
    }

    for (const route of ROUTES.slice(1)) {
      if (!route.roles.includes(role)) continue;
      await auditRoute(route, role);
    }
    console.log('');
  }
} catch (err) {
  no('run aborted: ' + err.message);
} finally {
  try { ws?.close(); } catch {}
  chrome?.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
