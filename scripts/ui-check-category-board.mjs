/*
  Drives real Chrome against /admin/categories — the engagement-model decision board.

  Why a browser check and not just the DB assertions in verify-category-model.mjs: the two defects
  this feature was most exposed to are BOTH invisible to the database.

    1. A Tailwind class that never reaches the stylesheet. ENGAGEMENT_MODELS lives in lib/, which
       was NOT in tailwind.config's content globs, and one of the classes was assembled at runtime
       (`m.bg.replace('/10','/70')`) — unscannable by construction. Either one renders as NO COLOUR
       AT ALL, silently, with every DB assertion still green. The whole premise of the board is
       "grey until decided, coloured once decided"; a colourless board is the feature not working.
    2. The picker writing without the screen agreeing. The row must reflect the new model after the
       reload, not just the RPC returning 200.

  What it checks:
    (a) THE BOARD RENDERS — heading, all 25+ rows, the "Decided N / M" counter and its legend.
    (b) 🔴 COLOUR IS REAL — the rail on an undecided row is the grey literal, and the rail on a
        decided row is that model's colour, read from getComputedStyle. Reading COMPUTED colour is
        the point: a class name in the DOM proves nothing about whether the stylesheet has a rule
        for it, which is exactly how the Tailwind-globs trap stays invisible.
    (c) THE PICKER ROUND-TRIPS — set a model in the UI, reload, and the row reads back decided with
        its badge and colour; the counter increments.
    (d) UNDECIDED SORTS TO THE TOP — the board is a worklist, so a decided row must move down.
    (e) IT WALKS BACKWARDS — set it to "— undecided —" and the row returns to grey.
    (f) THE EDIT FORM EXISTS and pre-fills, with the slug box deliberately BLANK (blank = keep).

  It restores whatever it touched: the category it experiments on ends the run with the model it
  started with.

  Usage — credentials come from .env.local (see .env.example):
    node scripts/ui-check-category-board.mjs
*/
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { account } from './lib/creds.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const admin = account('ADMIN');

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

/* Land on the board and refuse to proceed until it is genuinely populated. The rows arrive from an
   async fetch AFTER the heading paints, so asserting on the heading alone reads an empty board and
   reports every row missing. */
async function gotoBoard() {
  await evaluate(`window.location.assign('/admin/categories')`);
  await sleep(600);
  await waitFor(`(() => { const m = document.querySelector('main'); return !!m && m.innerText.length > 50; })()`,
    { label: 'the board to get past the auth gate' });
  const body = await text();
  if (/This page could not be found/.test(body)) throw new Error('/admin/categories rendered a 404');
  await waitFor(`document.body.innerText.includes('Service Categories')`, { label: 'the board heading' });
  // The app's own loading marker must be GONE, and the model pickers must exist — one per row.
  await waitFor(`!document.body.innerText.includes('Loading categories') &&
                 document.querySelectorAll('select[aria-label^="Engagement model"]').length > 0`,
    { label: 'the rows to load', timeout: 25000 });
}

/* One row, read the way the SCREEN presents it — including the rail's COMPUTED colour.

   Computed, not the class attribute: a class in the DOM says only that React wrote a string. It
   says nothing about whether the stylesheet has a rule for it, and an unscanned Tailwind class
   produces exactly that — the right class name and no styling. rgba(0,0,0,0) is the tell. */
const ROW_JS = (name) => `(() => {
  const sel = [...document.querySelectorAll('select[aria-label^="Engagement model"]')]
    .find(s => s.getAttribute('aria-label') === ${JSON.stringify('Engagement model for ' + name)});
  if (!sel) return null;
  const row = sel.closest('div.relative');
  if (!row) return null;
  const rail = row.querySelector('span[aria-hidden]');
  return {
    value: sel.value,
    rail: rail ? getComputedStyle(rail).backgroundColor : null,
    railClass: rail ? rail.className : null,
    text: row.innerText,
    index: [...document.querySelectorAll('select[aria-label^="Engagement model"]')].indexOf(sel),
  };
})()`;

const readRow = (name) => evaluate(ROW_JS(name));
const counter = () => evaluate(`(() => {
  const m = document.body.innerText.match(/Decided\\s+(\\d+)\\s*\\/\\s*(\\d+)/);
  return m ? { decided: +m[1], total: +m[2] } : null;
})()`);

// Set the picker the way a human does — a change event React actually hears.
const setPicker = (name, value) => evaluate(`(() => {
  const sel = [...document.querySelectorAll('select[aria-label^="Engagement model"]')]
    .find(s => s.getAttribute('aria-label') === ${JSON.stringify('Engagement model for ' + name)});
  if (!sel) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, ${JSON.stringify(value)});
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

const TRANSPARENT = /rgba\(0,\s*0,\s*0,\s*0\)|transparent/;

// ---------------------------------------------------------------- run
let chrome = null;
let touched = null; // { name, original } — restored in `finally`
try {
  if (!CHROME) { console.log('Cannot run: Chrome not found.'); process.exit(0); }
  if (!admin.email || !admin.password) {
    console.log('Cannot run: missing ADMIN_* credentials in .env.local.'); process.exit(0);
  }
  try {
    const r = await fetch(APP, { signal: AbortSignal.timeout(45000) });
    if (!r.ok && r.status >= 500) throw new Error('bad status');
  } catch { console.log(`Cannot run: dev server not answering on ${APP} — start \`npm run dev\`.`); process.exit(0); }

  const profile = mkdtempSync(join(tmpdir(), 'seva-cdp-catboard-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9224', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1440,900', 'about:blank',
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
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  console.log('driving real Chrome (headless) against ' + APP + '\n');

  await signInAs(admin.email, admin.password, 'the admin');

  // ───────────────────────────────────────────────────────────────── (a)
  console.log('[a) the board renders]');
  await gotoBoard();
  const rowCount = await evaluate(`document.querySelectorAll('select[aria-label^="Engagement model"]').length`);
  rowCount >= 25 ? ok(`the board rendered ${rowCount} categories, each with a model picker`)
                 : no(`only ${rowCount} rows rendered — expected at least 25`);

  const c0 = await counter();
  c0 ? ok(`the counter reads "Decided ${c0.decided} / ${c0.total}"`) : no('no "Decided N / M" counter on the board');
  if (c0 && c0.total !== rowCount) no(`the counter's total (${c0.total}) disagrees with the rows on screen (${rowCount})`);
  else if (c0) ok('the counter\'s total matches the rows actually on screen');

  const legend = await text();
  ['Placement', 'Lead', 'Escrow', 'Directory'].every((l) => legend.includes(l))
    ? ok('all four models are named in the legend') : no('the legend does not name all four models');

  // ───────────────────────────────────────────────────────────────── (b)
  console.log('\n[b) 🔴 colour is real, not just a class name]');
  // Pick a row that is genuinely undecided right now, so the run is safe to repeat.
  const victimName = await evaluate(`(() => {
    const sels = [...document.querySelectorAll('select[aria-label^="Engagement model"]')];
    const s = sels.find(x => x.value === '');
    return s ? s.getAttribute('aria-label').replace(/^Engagement model for /, '') : null;
  })()`);
  if (!victimName) {
    sk('every category already has a model — nothing undecided left to exercise the grey state on');
  } else {
    touched = { name: victimName, original: '' };
    const grey = await readRow(victimName);
    grey.value === '' ? ok(`"${victimName}" is undecided`) : no(`picked a row that is not undecided (${grey.value})`);
    /Undecided/i.test(grey.text) ? ok('...and says so — an "Undecided" chip, not an empty space')
                                 : no('an undecided row shows no chip saying so');
    if (grey.rail && !TRANSPARENT.test(grey.rail)) ok(`the undecided rail is painted grey (${grey.rail})`);
    else no(`the undecided rail has NO computed colour (${grey.rail}) — class "${grey.railClass}" never reached the stylesheet`);

    // ─────────────────────────────────────────────────────────────── (c)
    console.log('\n[c) the picker round-trips through the database]');
    await setPicker(victimName, 'placement');
    await waitFor(`${ROW_JS(victimName)}?.value === 'placement'`, { label: 'the row to show placement', timeout: 15000 });
    const green = await readRow(victimName);
    ok(`"${victimName}" → placement through the real picker`);
    /PLACEMENT/i.test(green.text) ? ok('the badge reads PLACEMENT') : no(`no PLACEMENT badge on the row — got: ${green.text.slice(0, 120)}`);
    if (green.rail && !TRANSPARENT.test(green.rail) && green.rail !== grey.rail) {
      ok(`🔴 the rail CHANGED COLOUR, computed (${grey.rail} → ${green.rail}) — the Tailwind classes are in the stylesheet`);
    } else if (green.rail && green.rail === grey.rail) {
      no(`the rail did not change colour (${green.rail}) — a decided row looks identical to an undecided one`);
    } else {
      no(`the decided rail has NO computed colour (${green.rail}) — class "${green.railClass}" never reached the stylesheet`);
    }

    const c1 = await counter();
    (c1 && c0 && c1.decided === c0.decided + 1)
      ? ok(`the counter advanced ${c0.decided} → ${c1.decided}`)
      : no(`the counter did not advance (${c0?.decided} → ${c1?.decided})`);

    // It must SURVIVE a reload — otherwise the picker only moved React state.
    await gotoBoard();
    const persisted = await readRow(victimName);
    persisted?.value === 'placement' ? ok('and it survives a full page reload — the model is in the database')
                                     : no(`the model did not persist a reload (got ${persisted?.value})`);

    // ─────────────────────────────────────────────────────────────── (d)
    console.log('\n[d) undecided sorts to the top — the board is a worklist]');
    const firstUndecided = await evaluate(`(() => {
      const sels = [...document.querySelectorAll('select[aria-label^="Engagement model"]')];
      const lastGrey = sels.map(s => s.value).lastIndexOf('');
      const firstDecided = sels.map(s => s.value).findIndex(v => v !== '');
      return { lastGrey, firstDecided, total: sels.length };
    })()`);
    (firstUndecided.firstDecided === -1 || firstUndecided.lastGrey < firstUndecided.firstDecided)
      ? ok('every undecided row sits above every decided one')
      : no(`ordering is mixed — last grey at ${firstUndecided.lastGrey}, first decided at ${firstUndecided.firstDecided}`);

    // ─────────────────────────────────────────────────────────────── (e)
    console.log('\n[e) the board walks backwards]');
    await setPicker(victimName, '');
    await waitFor(`${ROW_JS(victimName)}?.value === ''`, { label: 'the row to return to undecided', timeout: 15000 });
    const back = await readRow(victimName);
    ok(`"${victimName}" returned to undecided from the UI`);
    /Undecided/i.test(back.text) ? ok('the Undecided chip is back') : no('the row is undecided but shows no chip');
    back.rail === grey.rail ? ok('and the rail is grey again') : no(`the rail did not return to grey (${back.rail} vs ${grey.rail})`);
    touched = null; // restored through the UI itself
  }

  // ───────────────────────────────────────────────────────────────── (f)
  console.log('\n[f) the edit form exists, and its slug box is deliberately blank]');
  {
    const opened = await evaluate(`(() => {
      const b = document.querySelector('button[aria-label^="Edit "]');
      if (!b) return null;
      const name = b.getAttribute('aria-label').replace(/^Edit /, '');
      b.click();
      return name;
    })()`);
    if (!opened) { no('no Edit control on any row — the screen still cannot update a category'); }
    else {
      await sleep(900);
      const form = await evaluate(`(() => {
        const inputs = [...document.querySelectorAll('input')];
        const nameBox = inputs.find(i => i.value === ${JSON.stringify(opened)});
        const slugBox = inputs.find(i => /^Slug/.test(i.placeholder || ''));
        return { hasName: !!nameBox, slugValue: slugBox ? slugBox.value : null,
                 slugPlaceholder: slugBox ? slugBox.placeholder : null,
                 warns: document.body.innerText.includes('stop resolving') };
      })()`);
      form.hasName ? ok(`the edit form opened pre-filled with "${opened}"`) : no('the edit form did not pre-fill the name');
      form.slugValue === '' ? ok('🔴 the slug box is BLANK — blank keeps the current slug, so the safe path is the do-nothing path')
                            : no(`the slug box is pre-filled with "${form.slugValue}" — editing the name would now move the URL`);
      /leave blank to keep/i.test(form.slugPlaceholder ?? '') ? ok(`and says so: "${form.slugPlaceholder}"`)
                                                              : no(`the slug placeholder does not explain the blank: "${form.slugPlaceholder}"`);
      form.warns ? ok('the form warns that changing a slug breaks existing links')
                 : no('no warning that changing the slug breaks links');
      await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^Cancel$/.test(x.textContent.trim())); if (b) b.click(); return true; })()`);
    }
  }
} catch (e) {
  no('run aborted: ' + (e?.message ?? e));
} finally {
  // If the run died mid-way with a model set, put it back through the UI so the board is clean.
  if (touched) {
    try {
      await setPicker(touched.name, touched.original);
      await sleep(1500);
      console.log(`  (restored "${touched.name}" to ${touched.original || 'undecided'})`);
    } catch { console.log(`  ⚠ could not restore "${touched.name}" — check it on the board.`); }
  }
  try { chrome?.kill(); } catch {}
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
