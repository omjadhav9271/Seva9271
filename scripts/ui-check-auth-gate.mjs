/*
  Drives real Chrome against the site-wide auth gate.

  Why a browser check and not DB assertions: there is nothing here for the database to have an
  opinion about. `<AuthGate>` is UX routing — the security boundary is, as always, RLS and the
  SECURITY DEFINER RPCs, and it does not move because of this file. What can only be observed in a
  browser is whether a signed-out visitor actually LANDS on sign-in, and whether the chrome around
  that page still offers them controls that bounce straight back to it.

  What it checks:
    (a) SIGNED OUT, EVERY ROUTE IS THE SIGN-IN PAGE — `/` included, which is the whole ask.
        Asserted as "no <main> was ever rendered for that route, and the URL became /auth/signin".
    (b) THE CHROME DOES NOT SIGNPOST GATED PAGES — an enumeration of EVERY anchor on both public
        pages (desktop nav, mobile menu, footer, page body), each of which must resolve to a
        public route or not be a route at all. A sweep, not a list of the links someone remembered.
    (c) `?next=` SURVIVES THE DETOUR AND CANNOT BE WEAPONISED — a deep link with a query string
        comes back after sign-in; `//evil.com` does not.
    (d) SIGNED IN, ALL OF IT RETURNS — the homepage renders, the four nav links are back, the
        footer's Popular Services column is back.
    (e) `/api/**` IS NOT GATED — route handlers skip layouts, so the gate never sees them. This
        asserts that directly, because gating the Razorpay webhook would silently stop escrow
        reconciliation (invariant 5) and no page in the UI would look any different.

  The load-bearing precondition everywhere below is `document.querySelector('main')`. The layout is
  <AuthGate><main>{children}</main></AuthGate>, so `main` IS the page and everything else is chrome:
  when the gate blocks a route it renders no `main` at all. Asserting on `document.body` instead
  would be satisfied by the navbar and footer alone — which is exactly how a gated page stays green
  while showing nothing.

  Usage — credentials come from .env.local (see .env.example):
    node scripts/ui-check-auth-gate.mjs
*/
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { account, readEnvLocal } from './lib/creds.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const customer = account('CUSTOMER');

const envLocal = readEnvLocal();
const envVar = (k) => process.env[k] ?? envLocal[k];
const SUPABASE_URL = envVar('NEXT_PUBLIC_SUPABASE_URL');
const ANON_KEY = envVar('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const SERVICE_KEY = envVar('SUPABASE_SERVICE_ROLE_KEY');

// The public list, mirrored from components/auth-gate.tsx. Deliberately duplicated rather than
// imported: this check exists to catch the gate changing, and a check that reads its expectation
// out of the thing under test cannot fail.
const PUBLIC = ['/auth/signin', '/auth/signup', '/auth/forgot-password', '/auth/reset-password'];
const GATED = ['/', '/providers', '/services', '/how-it-works', '/become-provider',
  '/bookings', '/wallet', '/profile', '/notifications', '/admin'];

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
    await sleep(250);
  }
  throw new Error('timed out waiting for: ' + label);
}
const soft = (p) => p.then(() => true).catch(() => false);

const here = () => evaluate('location.pathname + location.search');
const SESSION = "!!localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sb-')) || '')";
// The gate's own two states, as the DOM shows them. `main` present = the page rendered;
// "Loading…" with no main = the session is still being restored from localStorage.
const HAS_MAIN = `(() => { const m = document.querySelector('main'); return !!m && m.innerText.trim().length > 50; })()`;

const REACT_SET = `
function reactSet(el, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}`;

/* Sign in through the real form, optionally landing on a `?next=`-bearing sign-in URL so the
   redirect target can be asserted afterwards. The 3-attempt loop is not defensive padding: a
   freshly navigated Next page has its inputs in the DOM BEFORE React attaches handlers, so an
   early fill submits an empty form and fails silently rather than erroring. */
async function signIn({ email, password }, next = null) {
  const url = next ? `${APP}/auth/signin?next=${encodeURIComponent(next)}` : `${APP}/auth/signin`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await evaluate('localStorage.clear()').catch(() => {});
    await send('Page.navigate', { url });
    await waitFor("!!document.querySelector('input[type=password]')", { label: 'the sign-in form' });
    await sleep(2500); // let React hydrate and attach its handlers
    await evaluate(`(() => {
      ${REACT_SET}
      reactSet(document.querySelector('input[type=email]'), ${JSON.stringify(email)});
      reactSet(document.querySelector('input[type=password]'), ${JSON.stringify(password)});
      return true;
    })()`);
    // Submit the FORM, never the button: clicking refocuses the field, and in a profile with saved
    // passwords that re-triggers autofill over what we just typed.
    await evaluate("(() => { const f = document.querySelector('form'); if (f) { f.requestSubmit(); return true; } return false; })()");
    if (await soft(waitFor(SESSION, { label: 'a stored Supabase session', timeout: 12000 }))) return true;
  }
  throw new Error('could not sign in through the UI after 3 attempts');
}

/* Fill a form and submit it, retrying until the submission visibly took effect.
   Same hydration race as signIn(): the inputs exist before React attaches handlers, so an early
   fill submits an empty form and the page just sits there looking broken. `fields` is a list of
   [cssSelector, value, index] — the index picks among matches, because the reset form has two
   inputs that differ only by position; `settled` is the page expression proving the submit landed. */
async function fillAndSubmit(fields, settled, { attempts = 3, label = 'the form' } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(2000); // let React hydrate and attach its handlers
    const filled = await evaluate(`(() => {
      ${REACT_SET}
      const specs = ${JSON.stringify(fields)};
      for (const [sel, val, index] of specs) {
        const el = document.querySelectorAll(sel)[index || 0];
        if (!el) return false;
        reactSet(el, val);
      }
      return true;
    })()`);
    if (filled) {
      await evaluate("(() => { const f = document.querySelector('form'); if (f) { f.requestSubmit(); return true; } return false; })()");
      if (await soft(waitFor(settled, { label, timeout: 15000 }))) return true;
    }
  }
  return false;
}

async function signOut() {
  await evaluate('localStorage.clear()').catch(() => {});
  await send('Page.navigate', { url: `${APP}/auth/signin` });
  await waitFor("!!document.querySelector('input[type=password]')", { label: 'the sign-in form' });
  await sleep(500);
}

/* Every anchor in the document, tagged by which region it lives in — including the mobile menu,
   whose links are not in the DOM at all while it is closed. A sweep that skipped it would exempt a
   whole second copy of the navigation.

   Opening that menu is subject to the same hydration race as filling a form: the button is in the
   DOM before React attaches its onClick, so an early click does nothing and the sweep quietly
   returns a SHORT list. Observed live — the same page swept 7 anchors on one run and 3 on the
   next. A sweep that can silently under-count is worse than no sweep, because "none gated" is then
   a statement about the links it happened to see. So: retry the click until the nav's anchor count
   actually grows, wait for the footer, and make a shortfall a hard failure rather than a pass. */
/* Wait for the navbar to finish restoring the session.
   Its entire right-hand region is behind `{!loading && …}` (components/navbar.tsx), so while the
   session is being read back from localStorage the navbar renders exactly ONE anchor — the logo —
   and no auth controls whatsoever. Enumerating then reports a page that offers nothing, which
   passes an "offers nothing gated" test for entirely the wrong reason and fails a "still offers
   Sign In" one. It is the same class of bug as sampling a gated page before the gate resolves, and
   it showed up the moment the dev server got slow: identical code, 7 anchors on a warm run and 6
   on a cold one. Settling is therefore a PRECONDITION with its own failure message, never a silent
   part of some other assertion. */
async function chromeSettled(label, min = 2) {
  return soft(waitFor(`document.querySelectorAll('nav a[href]').length >= ${min}`,
    { label: `${label}: the navbar to leave its loading state`, timeout: 30000 }));
}

/* The signed-out version of the same precondition, and it cannot be the one above.
   Signed out the navbar now renders IDENTICALLY before and after the session is restored — one
   anchor, the logo — because the auth pair that used to appear at the end of the restore is gone.
   So `wait for N anchors` would either pass instantly or hang forever, and neither says anything.

   Waiting for the shape to STOP CHANGING does: two identical samples 800ms apart. It needs no
   knowledge of what the settled navbar should contain, so it keeps working if a future navbar
   starts swapping something in late again — which is precisely the failure this whole family of
   preconditions exists to catch. */
async function chromeStable(label, { timeout = 30000 } = {}) {
  const count = () => evaluate(`document.querySelectorAll('nav a[href], footer a[href]').length`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const a = await count();
    await sleep(800);
    if (a > 0 && a === await count()) return true;
  }
  return false;
}

async function anchorSweep(label) {
  if (!await chromeStable(label)) throw new Error(`${label}: the chrome never stopped changing`);
  await waitFor("!!document.querySelector('footer a[href]')", { label: `${label}'s footer` });
  const MOBILE_BTN = `[...document.querySelectorAll('nav button')].find(x => (x.className || '').includes('md:hidden'))`;
  const navCount = () => evaluate(`document.querySelectorAll('nav a[href]').length`);

  /* The hamburger is only rendered when there is a menu to open, which signed out there no longer
     is. Its ABSENCE is therefore the correct state rather than a coverage hole — but if it is
     present it must really open, or a second copy of the navigation goes unswept. */
  let mobileMenu = 'absent';
  if (await evaluate(`!!(${MOBILE_BTN})`)) {
    const before = await navCount();
    let opened = false;
    for (let attempt = 1; attempt <= 6 && !opened; attempt++) {
      await evaluate(`(() => { const b = ${MOBILE_BTN}; if (b) b.click(); return !!b; })()`);
      await sleep(400);
      opened = (await navCount()) > before;
    }
    if (!opened) throw new Error(`${label}: the mobile menu never opened, so its links went unswept`);
    mobileMenu = 'opened';
  }

  const anchors = await evaluate(`[...document.querySelectorAll('a[href]')].map(a => ({
    href: a.getAttribute('href'),
    text: (a.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 32),
    where: a.closest('nav') ? 'nav' : a.closest('footer') ? 'footer' : 'page',
  }))`);
  return { anchors, mobileMenu };
}

/* Is this anchor safe to offer someone with no session?
   Either it is not a route at all (mail, phone, an external site, an in-page jump), or it is one
   of the two public routes. Anything else is a control that bounces the visitor back to the page
   they are already on. */
function classify(href) {
  if (!href || href === '#' || href.startsWith('#')) return 'not-a-route';
  if (/^(mailto:|tel:|sms:)/i.test(href)) return 'not-a-route';
  if (/^https?:\/\//i.test(href)) return href.startsWith(APP) ? 'internal-absolute' : 'external';
  if (!href.startsWith('/')) return 'relative';
  const path = href.split(/[?#]/)[0];
  return PUBLIC.includes(path) ? 'public' : 'gated';
}

// ---------------------------------------------------------------- run
let chrome = null;
try {
  if (!CHROME) { console.log('Cannot run: Chrome not found.'); process.exit(0); }
  if (!customer.email || !customer.password) {
    console.log('Cannot run: CUSTOMER_EMAIL / CUSTOMER_PASSWORD missing from .env.local.'); process.exit(0);
  }
  try {
    const r = await fetch(APP, { signal: AbortSignal.timeout(45000) });
    if (!r.ok && r.status >= 500) throw new Error('bad status');
  } catch { console.log(`Cannot run: dev server not answering on ${APP} — start \`npm run dev\`.`); process.exit(0); }

  const profile = mkdtempSync(join(tmpdir(), 'seva-cdp-gate-'));
  // The desktop nav is `hidden md:flex`; below the md breakpoint its links are display:none and
  // every nav assertion would pass or fail for the wrong reason.
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9226', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:9226/json/list')).json();
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
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  console.log('driving real Chrome (headless) against ' + APP + '\n');

  await signOut();

  // ═══════════════ (a) signed out, every route is the sign-in page ═══════════════
  console.log('[a) signed out — nothing but sign-in renders]');
  for (const route of GATED) {
    /* Sample all the way through the redirect rather than only at the end of it.
       Checking `main` once the URL has settled proves nothing: by then `main` is the SIGN-IN page,
       which is a pass being read as a leak. What actually matters is whether the gated page ever
       flashed on the way past, so poll for any `main` whose content is neither auth page. The gate
       returns null while `!user`, so children never mount and this should stay empty — but "should"
       is the reason to look. Honest about its limits: this is sampling, not a guarantee of every
       frame, so a clean run means no leak was OBSERVED. */
    await send('Page.navigate', { url: APP + route });
    const deadline = Date.now() + 15000;
    let landed = false, leaked = '', samples = 0;
    while (Date.now() < deadline) {
      let snap = null;
      try {
        snap = await evaluate(`(() => { const m = document.querySelector('main');
          return { p: location.pathname, m: m ? m.innerText.trim().replace(/\\s+/g, ' ').slice(0, 80) : '' }; })()`);
      } catch { /* mid-navigation */ }
      if (snap) {
        samples++;
        if (snap.m && !/Welcome back|Create your account/i.test(snap.m)) leaked = snap.m;
        if (snap.p === '/auth/signin') { landed = true; break; }
      }
      await sleep(80);
    }
    if (!landed) { no(`${route} did NOT redirect — landed on ${await here()}`); continue; }
    // The page it redirected TO must be the real sign-in form, not an empty shell.
    const form = await soft(waitFor("!!document.querySelector('input[type=password]')",
      { label: 'the sign-in form', timeout: 10000 }));
    if (!form) no(`${route} reached /auth/signin but the form never rendered`);
    else if (leaked) no(`${route} flashed its own content before redirecting: "${leaked}"`);
    else ok(`${route} → ${await here()} (no page content in ${samples} samples on the way)`);
  }
  for (const route of PUBLIC) {
    await send('Page.navigate', { url: APP + route });
    const rendered = await soft(waitFor(HAS_MAIN, { label: `${route} to render`, timeout: 15000 }));
    if (rendered && (await here()).startsWith(route)) ok(`${route} is reachable with no session`);
    else no(`${route} did not render for a signed-out visitor (at ${await here()})`);
  }

  // ═══════════════ (b) the chrome offers nothing it cannot deliver ═══════════════
  console.log('\n[b) signed out — every anchor on every public page]');
  for (const route of PUBLIC) {
    await send('Page.navigate', { url: APP + route });
    await waitFor(HAS_MAIN, { label: `${route} to render` });
    await sleep(600);
    let anchors, mobileMenu;
    try { ({ anchors, mobileMenu } = await anchorSweep(route)); }
    catch (err) { no(err.message); continue; }
    const bad = anchors.filter((a) => classify(a.href) === 'gated');
    const good = anchors.filter((a) => classify(a.href) === 'public');
    const regions = [...new Set(anchors.map((a) => a.where))].sort();
    /* "None of them was gated" is only worth anything if the sweep actually saw the whole page, so
       prove the coverage before reporting the verdict: all three regions present, and at least the
       five anchors that must exist on any signed-out page — the nav logo, the footer's brand link
       plus its phone and email, and the page's own cross-link. */
    if (regions.join(',') !== 'footer,nav,page' || anchors.length < 5) {
      no(`${route}: the sweep only saw ${anchors.length} anchors across [${regions.join(', ')}] — too few to conclude anything`);
    } else if (bad.length === 0) {
      ok(`${route}: ${anchors.length} anchors across nav+footer+body (mobile menu ${mobileMenu}), ` +
         `none gated (${good.length} → sign-in/sign-up, ${anchors.length - good.length} mail/phone)`);
    } else {
      no(`${route}: ${bad.length} anchor(s) point at gated routes — ` +
         bad.map((a) => `${a.where}:"${a.text}"→${a.href}`).join(', '));
    }
  }
  {
    // The two regions the brief called out, asserted by name so a regression says WHICH one broke
    // rather than only that the sweep found something.
    await send('Page.navigate', { url: `${APP}/auth/signin` });
    await waitFor(HAS_MAIN, { label: 'the sign-in page' });
    if (!await chromeStable('/auth/signin')) no('the chrome never stopped changing on /auth/signin');
    await sleep(400);
    const nav = await evaluate(`(() => { const n = document.querySelector('nav');
      return { links: [...n.querySelectorAll('a[href]')].map(a => a.getAttribute('href')),
               buttons: n.querySelectorAll('button').length,
               text: n.innerText.replace(/\\s+/g, ' ') }; })()`);
    const navGated = nav.links.filter((h) => classify(h) === 'gated');
    if (navGated.length === 0) ok('the navbar offers no gated destination: ' + nav.links.join(' '));
    else no('the navbar still links to ' + navGated.join(', '));

    /* The "Sign In" / "Get Started" pair is GONE, and this assertion is the inverse of the one it
       replaced. Signed out the only reachable pages are the four /auth ones, so that pair was
       shown exclusively to people already standing on one of them: circular on the page it named,
       and duplicated in the page's own body on the other. */
    if (!/Sign In|Get Started/i.test(nav.text)) ok('…and no longer offers the circular Sign In / Get Started pair');
    else no('the navbar still shows Sign In / Get Started: ' + nav.text.slice(0, 80));
    if (nav.links.length === 1) ok('…leaving exactly one control, the logo → ' + nav.links[0]);
    else no(`the signed-out navbar carries ${nav.links.length} links, expected just the logo`);

    /* The location chip is gone. It was a <button> with no onClick whose fallback text was a
       hardcoded "Mumbai, MH", so it told every visitor without a profile city — including every
       signed-out one, who has no profile at all — that they were in Mumbai. */
    if (!/Mumbai|MH\b/i.test(nav.text)) ok('…and the dead "Mumbai, MH" location chip is gone from the navbar');
    else no('the navbar still shows a location chip: ' + nav.text.slice(0, 80));
    // Nothing left to open: no nav links and no auth pair means the panel would be empty.
    if (nav.buttons === 0) ok('…and there is no hamburger opening an empty mobile panel');
    else no(`the signed-out navbar still renders ${nav.buttons} button(s)`);

    const foot = await evaluate(`(() => { const f = document.querySelector('footer');
      return { links: [...f.querySelectorAll('a[href]')].map(a => a.getAttribute('href')),
               text: f.innerText.replace(/\\s+/g, ' ') }; })()`);
    const footGated = foot.links.filter((h) => classify(h) === 'gated');
    if (footGated.length === 0) ok('the footer offers no gated destination: ' + foot.links.join(' '));
    else no('the footer still links to ' + footGated.join(', '));
    if (!/Popular Services/i.test(foot.text)) ok('…and drops the Popular Services column entirely');
    else no('the footer still shows Popular Services, whose every entry deep-links into /services');
    // The unbuilt destinations must still be VISIBLE, just not clickable — silently deleting them
    // would be a different kind of dishonesty than linking them.
    if (/Privacy Policy/i.test(foot.text) && /Terms of Service/i.test(foot.text)) {
      ok('…while still naming Privacy Policy and Terms of Service as "Soon"');
    } else no('Privacy Policy / Terms of Service vanished from the footer rather than being labelled');

    /* The Support column used to offer two ways to reach nobody: "+91 98765 43210" is the stock
       placeholder every Indian mockup uses, and support@seva.com is a domain this project does not
       own. They are real now, and they are LINKS — tel: and mailto: are not routes, so the gate
       never sees them and they work signed out, which is exactly when someone locked out of their
       account needs them. */
    if (/98765 43210/.test(foot.text) || /support@seva\.com/i.test(foot.text)) {
      no('the footer still shows placeholder contact details');
    } else ok('the footer\'s placeholder phone and email are gone');
    if (foot.links.includes('tel:+918104996891')) ok('…the phone number is a tappable tel: link');
    else no('the footer phone is not a tel: link: ' + foot.links.join(' '));
    if (foot.links.includes('mailto:omjadhav9271@gmail.com')) ok('…and the email is a mailto: link');
    else no('the footer email is not a mailto: link: ' + foot.links.join(' '));
    /* "Based in" disambiguates whose location the pin means — unlabelled, a visitor in Pune reads
       it as the site guessing at THEIR location, which is what the deleted navbar chip pretended. */
    if (/Based in Mumbai/i.test(foot.text)) ok('…and the footer location says whose it is ("Based in Mumbai")');
    else no('the footer location line is unlabelled again: ' + (foot.text.match(/Mumbai[^\n·]*/) ?? ['(absent)'])[0]);

    // "Forgot password?" spent a release as a dead "Soon" chip because the route did not exist.
    // It is a real link again, and the sweep above has already proved the destination is public.
    const forgot = await evaluate(`(() => {
      const a = [...document.querySelectorAll('main a[href]')].find(x => /forgot password/i.test(x.innerText));
      return a ? a.getAttribute('href') : null; })()`);
    if (forgot === '/auth/forgot-password') ok('"Forgot password?" is a real link again → /auth/forgot-password');
    else no(`"Forgot password?" does not link to the reset flow (href: ${forgot})`);

    /* The demo-access block is gone. It filled the form with customer@seva.demo / provider@seva.demo,
       NEITHER OF WHICH EXISTS in auth.users — so the next click returned "Invalid login
       credentials". A control that manufactures an error is the worst kind of dead control,
       because the visitor concludes the site is broken rather than the button. */
    const signinBody = await evaluate(`document.querySelector('main').innerText`);
    if (!/quick demo|customer demo|provider demo|seva\.demo/i.test(signinBody)) {
      ok('the demo-access buttons (for accounts that never existed) are gone from sign-in');
    } else no('sign-in still offers demo accounts: ' + signinBody.slice(0, 120).replace(/\n/g, ' | '));
  }

  // ═══════════════ (c) ?next= comes back, and cannot be weaponised ═══════════════
  console.log('\n[c) ?next= survives the detour]');
  {
    const deep = '/services?category=electrician';
    await signOut();
    await send('Page.navigate', { url: APP + deep });
    await waitFor(`location.pathname === '/auth/signin'`, { label: 'the gate to redirect' });
    const stashed = await evaluate("new URLSearchParams(location.search).get('next')");
    if (stashed === deep) ok(`a deep link is stashed whole, query and all: next=${stashed}`);
    else no(`the gate stashed "${stashed}" instead of "${deep}"`);

    await signIn(customer, deep);
    const landedOn = await soft(waitFor(`location.pathname === '/services'`,
      { label: 'the original destination', timeout: 20000 }));
    const at = await here();
    if (landedOn && at.includes('category=electrician')) ok(`sign-in returned to ${at} rather than /`);
    else no(`sign-in dropped the destination — landed on ${at}`);
  }
  {
    /* The open-redirect case. `next` is attacker-supplied, and `//evil.com` starts with '/', so a
       bare startsWith('/') check waves it through and the BROWSER reads it as a host. The victim
       signs in on the real page at the real domain and is then handed to someone else's site
       wearing all the trust of the flow they just completed. */
    await signIn(customer, '//evil.example.com/phish');
    await sleep(2500);
    const at = await here();
    const origin = await evaluate('location.origin');
    if (origin === APP && at === '/') ok('a protocol-relative next= is dropped — sign-in landed on /');
    else no(`OPEN REDIRECT: sign-in sent the browser to ${origin}${at}`);
  }

  // ═══════════════ (d) signed in, all of it comes back ═══════════════
  console.log('\n[d) signed in — the site returns]');
  {
    await signIn(customer);
    await send('Page.navigate', { url: APP + '/' });
    const rendered = await soft(waitFor(HAS_MAIN, { label: 'the homepage', timeout: 25000 }));
    const at = await here();
    if (rendered && at === '/') ok('/ renders the homepage for a signed-in customer');
    else no(`/ did not render signed in — at ${at}`);
    const h2 = await evaluate(`(() => { const h = document.querySelector('main h2'); return h ? h.innerText.replace(/\\s+/g, ' ') : ''; })()`);
    if (/Trusted Service/i.test(h2)) ok(`…with its real hero: "${h2}"`);
    else no('the homepage rendered something other than its hero: ' + h2.slice(0, 60));

    // Same precondition as signed out: the nav links derive from `user`, so mid-restore there are
    // legitimately none and asserting early reads that as four missing links.
    if (!await chromeSettled('/', 2)) no('the navbar never left its loading state on / while signed in');
    const navText = await evaluate(`document.querySelector('nav').innerText.replace(/\\s+/g, ' ')`);
    // The location chip was removed for everyone, not only signed-out visitors: it was dead in
    // both states, and signed in it merely echoed a profile field with no effect on any search.
    if (!/Mumbai, MH/i.test(navText)) ok('the dead location chip is gone for signed-in users too');
    else no('the signed-in navbar still shows the location chip: ' + navText.slice(0, 80));
    const nav = await evaluate(`[...document.querySelectorAll('nav a[href]')].map(a => a.getAttribute('href'))`);
    for (const link of ['/services', '/providers', '/how-it-works', '/become-provider']) {
      if (nav.includes(link)) ok(`the navbar offers ${link} again`);
      else no(`the navbar is missing ${link} for a signed-in customer`);
    }
    const foot = await evaluate(`document.querySelector('footer').innerText`);
    if (/Popular Services/i.test(foot)) ok('the footer\'s Popular Services column is back');
    else no('the footer is still in its signed-out shape for a signed-in customer');

    // /how-it-works is the one server component in the app, so it exercises a different path
    // through the gate: `children` is server-rendered and passed as a prop into a client gate.
    await send('Page.navigate', { url: APP + '/how-it-works' });
    if (await soft(waitFor(HAS_MAIN, { label: '/how-it-works', timeout: 20000 }))) ok('/how-it-works renders signed in (the one server component)');
    else no('/how-it-works did not render for a signed-in customer');
  }

  // ═══════════════ (e) /api/** is not gated ═══════════════
  console.log('\n[e) /api/** is untouched by the gate]');
  {
    /* Route handlers never render through a layout, so the gate cannot see them — and must not.
       The Razorpay webhook is called by Razorpay, not a browser, and authenticates by verifying
       the HMAC signature; gating it would silently stop escrow reconciliation (invariant 5) with
       nothing in the UI looking any different. Assert it reaches the HANDLER: an unsigned POST
       must be REJECTED BY SIGNATURE CHECK, not answered with a sign-in page. */
    const r = await fetch(`${APP}/api/payments/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(30000),
    });
    const ct = r.headers.get('content-type') ?? '';
    const body = (await r.text()).slice(0, 120);
    if (ct.includes('text/html')) no(`the webhook was served HTML (status ${r.status}) — it is behind the gate`);
    else if (r.status >= 400 && r.status < 500) ok(`the webhook reached its handler and rejected an unsigned POST (${r.status}: ${body.replace(/\s+/g, ' ')})`);
    else no(`the webhook answered ${r.status} ${ct} — expected a 4xx signature rejection: ${body}`);
  }

  // ═══════════════ (f) password reset, end to end ═══════════════
  console.log('\n[f) password reset — the real link, a real new password]');
  if (!SERVICE_KEY || !SUPABASE_URL || !ANON_KEY) {
    no('cannot exercise the reset flow — NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY missing');
  } else {
    const service = createClient(SUPABASE_URL, SERVICE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const stamp = Date.now();
    /* A THROWAWAY user, created and deleted inside this check. The alternative — resetting a real
       test account's password — would leave every other script signing in with a stale one the
       moment this check failed halfway through. */
    const email = `zz-ui-check-reset-${stamp}@example.com`;
    const OLD = `Old-${stamp}-pw`;
    const NEW = `New-${stamp}-pw`;
    let userId = null;

    try {
      const { data: created, error: cErr } = await service.auth.admin.createUser({
        email, password: OLD, email_confirm: true,
      });
      if (cErr) throw new Error('could not create the throwaway user: ' + cErr.message);
      userId = created.user.id;

      /* Somewhere else already signed in as this user — a phone, a second browser. The whole
         reason the reset page signs out globally is to kill this session, so open one and check
         it dies. An access token is a JWT and stays syntactically valid until it expires, so the
         thing to test is whether it can still REFRESH. */
      const other = createClient(SUPABASE_URL, ANON_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: otherErr } = await other.auth.signInWithPassword({ email, password: OLD });
      if (otherErr) no('could not open a second session to test the global sign-out: ' + otherErr.message);

      // ---- the request page, with an address that has NO account ----
      /* Deliberate: it drives the entire client path and the confirmation screen while sending no
         mail at all (Supabase does not mail an unknown address, and still reports success), so
         this check cannot burn the project's email quota however often it runs. It also asserts
         the property that matters — a stranger's address gets the SAME answer a real one does. */
      await signOut();
      await send('Page.navigate', { url: `${APP}/auth/forgot-password` });
      await waitFor("!!document.querySelector('input[type=email]')", { label: 'the reset request form' });
      const nobody = `zz-nobody-${stamp}@example.com`;
      const requested = await fillAndSubmit(
        [['input[type=email]', nobody]],
        `/on its way/i.test(document.querySelector('main').innerText)`,
        { label: 'the confirmation screen' });
      if (!requested) no('the reset request form never reached its confirmation screen');
      else {
        const body = await evaluate(`document.querySelector('main').innerText`);
        if (/no account|not found|does not exist|isn't registered/i.test(body)) {
          no('the confirmation reveals whether the address has an account — that is an enumeration oracle');
        } else ok('an address with NO account gets the same neutral confirmation a real one does');
      }

      // ---- the real recovery link ----
      const { data: link, error: lErr } = await service.auth.admin.generateLink({
        type: 'recovery', email, options: { redirectTo: `${APP}/auth/reset-password` },
      });
      if (lErr) throw new Error('generateLink failed: ' + lErr.message);

      await signOut();
      await send('Page.navigate', { url: link.properties.action_link });
      const onResetPage = await soft(waitFor(`location.pathname === '/auth/reset-password'`,
        { label: 'the reset page', timeout: 25000 }));
      if (!onResetPage) {
        /* Almost always one thing: `redirectTo` is not on the project's redirect allowlist, so
           Supabase quietly substitutes the Site URL and the user lands somewhere with a live
           recovery session and no form to use it. */
        no(`the recovery link did not land on /auth/reset-password (landed on ${await evaluate('location.href')}) ` +
           `— add ${APP}/** to Supabase → Auth → URL Configuration → Redirect URLs`);
      } else {
        ok('the emailed recovery link lands on /auth/reset-password');
        const formUp = await soft(waitFor(
          `document.querySelectorAll('input[autocomplete="new-password"]').length === 2`,
          { label: 'the new-password form', timeout: 20000 }));
        if (!formUp) {
          const shown = await evaluate(`(() => { const m = document.querySelector('main'); return m ? m.innerText.replace(/\\s+/g, ' ').slice(0, 100) : ''; })()`);
          no(`the reset page did not offer a password form for a VALID link — it showed: "${shown}"`);
        } else {
          ok('…and a valid link is recognised, offering the new-password form');
          const saved = await fillAndSubmit(
            [['input[autocomplete="new-password"]', NEW, 0],
             ['input[autocomplete="new-password"]', NEW, 1]],
            `location.pathname === '/auth/signin'`,
            { label: 'the return to sign-in' });
          if (!saved) no('setting a new password did not return to the sign-in page');
          else ok('setting a new password returns to sign-in');

          const stillSignedIn = await evaluate(SESSION);
          if (!stillSignedIn) ok('…and the browser was signed out rather than dropped into the app');
          else no('the browser kept its recovery session after the reset');
        }
      }

      // ---- the assertions that actually prove the password changed ----
      const probe = createClient(SUPABASE_URL, ANON_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: newErr } = await probe.auth.signInWithPassword({ email, password: NEW });
      if (!newErr) ok('the NEW password signs in');
      else no('the new password does not work: ' + newErr.message);

      const { error: oldErr } = await probe.auth.signInWithPassword({ email, password: OLD });
      if (oldErr) ok('the OLD password no longer signs in');
      else no('the OLD password still works — the reset did not take');

      const { error: refreshErr } = await other.auth.refreshSession();
      if (refreshErr) ok('a session opened BEFORE the reset can no longer refresh — the sign-out was global');
      else no('a session opened before the reset is still alive — other devices stayed signed in');
    } catch (err) {
      no('the reset flow could not be exercised: ' + err.message);
    } finally {
      if (userId) {
        const { error } = await service.auth.admin.deleteUser(userId);
        if (error) console.log(`  ! left the throwaway user ${email} behind: ${error.message}`);
        else console.log(`  (cleaned up the throwaway user ${email})`);
      }
    }
  }

  console.log(`\n${'='.repeat(60)}\n  ${pass} passed, ${fail} failed`);
  if (fail) console.log('  The auth gate is NOT behaving as documented.');
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.error('\nFATAL: ' + err.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* already gone */ }
  try { chrome?.kill(); } catch { /* already gone */ }
}
