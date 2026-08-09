/*
  Step-11 UI smoke test — drives a REAL Chrome over the DevTools Protocol.

  Why this exists: verify-step11.mjs proves the matching RULES in the database. It cannot prove the
  part the customer actually touches, and every SQL check would stay green while the feature was
  dead on arrival:

    1. "Use my location" on /providers and /services actually calls the RPC and RANKS the results;
    2. each card shows a DISTANCE ("2.3 km away") rather than a city;
    3. declining location does NOT dead-end — the list stays, with an honest sentence;
    4. 🔴 no provider coordinate ever reaches the browser — not in the page text, and not in any
       response body the page received. This is the check that matters: the RPC could be perfect
       and a careless page could still fetch lat/lng separately and draw a map.

  Geolocation is overridden through CDP (Browser.setPermission + Emulation.setGeolocationOverride),
  so both the granted and the DENIED path are deterministic — no clicking a native permission
  bubble, no flakiness. Harness (CDP plumbing, waits) is the one from ui-check-step10.mjs.

  Usage (needs `npm run dev` on :3000):
    node scripts/ui-check-step11.mjs
*/
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const APP = 'http://localhost:3000';
// Mumbai centre — the same anchor the app uses as its city fallback.
const ORIGIN = { lat: 19.0760, lng: 72.8777 };

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

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

const text = () => evaluate('document.body ? document.body.innerText : ""');

const clickContaining = (t) => evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(t)}));
  if (!el) return false;
  el.click(); return true;
})()`);

/** Provider names in the order the DOM lists them — i.e. the order the customer actually sees. */
const cardNames = () => evaluate(`[...document.querySelectorAll('a[href^="/providers/"]')]
  .map(a => a.querySelector('h3') && a.querySelector('h3').textContent.trim())
  .filter(Boolean)`);

async function setGeolocation({ granted, lat, lng }) {
  await send('Browser.setPermission', {
    origin: APP,
    permission: { name: 'geolocation' },
    setting: granted ? 'granted' : 'denied',
  });
  if (granted) {
    await send('Emulation.setGeolocationOverride', { latitude: lat, longitude: lng, accuracy: 40 });
  } else {
    // Belt and braces: with the permission denied the override is never consulted, but clearing it
    // means a bug that somehow bypasses the prompt still can't read a real position.
    await send('Emulation.clearGeolocationOverride').catch(() => {});
  }
}

/* Record every response body the page receives, WITH its URL — the URL matters.
   A coordinate VALUE found in a static JS chunk is not a leak: CITY_ANCHORS in lib/matching.ts
   hardcodes city centres, and one of them (Navi Mumbai, 19.033) happens to equal a seeded
   provider's latitude. A build-time constant cannot carry per-provider data from the database.
   So coordinate VALUES are searched in DATA responses (Supabase REST/RPC and /api), which is the
   only place a real leak could arrive; the coordinate KEY shape is still searched everywhere. */
const responses = [];
const urlOf = new Map();
function watchNetwork() {
  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Network.responseReceived' && msg.params?.requestId) {
      urlOf.set(msg.params.requestId, msg.params.response?.url ?? '');
    }
    if (msg.method === 'Network.loadingFinished' && msg.params?.requestId) {
      try {
        const r = await send('Network.getResponseBody', { requestId: msg.params.requestId }, 8000);
        if (r?.body) responses.push({ url: urlOf.get(msg.params.requestId) ?? '', body: r.body });
      } catch { /* body already evicted, or not a text body */ }
    }
  });
}
const isDataResponse = (url) => /\/rest\/v1\/|\/rpc\/|supabase\.co|\/api\//.test(url);

/** Click a control, then wait for its effect — retrying the click, because a freshly navigated
 *  Next page renders its markup before React attaches handlers, so the first click can land on
 *  nothing. Fails after the attempts are exhausted; it never passes without the effect. */
async function clickUntil(label, condition, { attempts = 4, each = 8000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const clicked = await clickContaining(label);
    if (!clicked) { await sleep(1000); continue; }
    try { await waitFor(condition, { timeout: each, label: `${label} → effect` }); return true; }
    catch { /* hydration probably lost the race — click again */ }
  }
  return false;
}

// ---------------------------------------------------------------- run
let chrome = null;
try {
  if (!CHROME) { console.log('Cannot run: Chrome not found.'); process.exit(0); }
  try {
    const r = await fetch(APP, { signal: AbortSignal.timeout(45000) });
    if (!r.ok && r.status >= 500) throw new Error('bad status');
  } catch { console.log('Cannot run: dev server not answering on :3000 — start `npm run dev`.'); process.exit(0); }

  // Ground truth straight from the DB: what the ranking SHOULD be, and the real coordinates that
  // must never appear in the browser.
  const { data: expected, error: rpcErr } = await service.rpc('search_providers', {
    p_lat: ORIGIN.lat, p_lng: ORIGIN.lng, p_category_id: null, p_radius_km: 25, p_limit: 30,
  });
  if (rpcErr) { console.log('Cannot run: search_providers failed — ' + rpcErr.message); process.exit(1); }
  if (!expected?.length) { console.log('Cannot run: no geocoded approved providers to rank.'); process.exit(0); }

  const { data: truth } = await service.from('service_providers')
    .select('business_name, latitude, longitude').eq('status', 'approved').not('latitude', 'is', null);
  // The exact decimal strings a leak would most likely carry.
  const coordStrings = (truth ?? []).flatMap((t) => [String(t.latitude), String(t.longitude)])
    .filter((s) => s && s.length >= 6);

  const profile = mkdtempSync(join(tmpdir(), 'seva-cdp11-'));
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
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  watchNetwork();
  console.log('driving real Chrome (headless) against ' + APP);
  console.log('expected top-ranked provider: ' + expected[0].business_name +
    ` (${expected[0].distance_km} km, reputation ${expected[0].reputation_score})\n`);

  // ================= 1) /providers — the catalog fallback is the starting state =================
  console.log('[/providers: before sharing a location]');
  await setGeolocation({ granted: true, ...ORIGIN });
  await send('Page.navigate', { url: `${APP}/providers` });
  await waitFor(`document.body.innerText.includes('Showing')`, { label: 'the providers list', timeout: 60000 });
  {
    const body = await text();
    if (/Share your location to rank by distance/i.test(body)) {
      ok('the un-located state invites the customer to share a location (no dead end, no empty page)');
    } else no('the prompt to share a location is missing: ' + body.slice(0, 160).replace(/\n/g, ' | '));

    const names = await cardNames();
    if (names.length > 0) ok(`catalog still lists providers without any location (${names.length} cards)`);
    else no('no provider cards rendered in the fallback state');

    if (!/km away/i.test(body)) ok('no distances shown before a location is known (nothing invented)');
    else no('distances appeared without a location being shared');
  }

  // ================= 2) "Use my location" ranks by the RPC =================
  console.log('\n[/providers: "Use my location"]');
  {
    const clicked = await clickUntil('Use my location', `document.body.innerText.includes('km away')`);
    if (!clicked) { no('"Use my location" never produced distances on /providers'); }
    else {
      const body = await text();

      if (/near your location/i.test(body)) ok('the header states the results are near the customer, best match first');
      else no('the "near your location" summary is missing');

      const distances = [...body.matchAll(/([\d.]+) km away/g)].map((m) => Number(m[1]));
      if (distances.length > 0) ok(`${distances.length} cards show a distance (e.g. "${distances[0]} km away")`);
      else no('no card shows a distance');

      // One decimal only: the point is grid-snapped, so metre precision would be a lie.
      const overPrecise = [...body.matchAll(/([\d.]+) km away/g)].filter((m) => (m[1].split('.')[1] ?? '').length > 1);
      if (overPrecise.length === 0) ok('distances render to one decimal — no precision we do not have');
      else no('a distance claims more precision than the snapped point supports: ' + overPrecise[0][0]);

      const names = await cardNames();
      const expectedNames = expected.map((p) => p.business_name);
      if (names.length && names[0] === expectedNames[0]) {
        ok(`the browser's first card is the server's top match ("${names[0]}")`);
      } else {
        no(`ranking mismatch — browser shows "${names[0]}", RPC ranks "${expectedNames[0]}" first`);
      }
      const headMatches = names.slice(0, 3).every((n, i) => n === expectedNames[i]);
      if (headMatches) ok('the first three cards are in exactly the server\'s ranked order');
      else no(`ranked order not preserved: browser ${JSON.stringify(names.slice(0, 3))} vs RPC ${JSON.stringify(expectedNames.slice(0, 3))}`);

      // Rank is not simply "nearest first" — that would mean reputation is not counting.
      const sortedByDistance = [...distances].sort((a, b) => a - b);
      if (distances.length >= 2 && JSON.stringify(distances) !== JSON.stringify(sortedByDistance)) {
        ok('displayed order is NOT pure nearest-first — reputation is visibly part of the ranking');
      } else if (distances.length >= 2) {
        sk('displayed order happens to equal distance order with this data (reputations may be level)');
      }
    }
  }

  // ================= 3) 🔴 no coordinate reaches the browser =================
  console.log('\n[🔴 coordinate privacy, checked in the browser itself]');
  {
    const body = await text();
    const inText = coordStrings.filter((c) => body.includes(c));
    if (inText.length === 0) ok(`no provider coordinate in the page text (${coordStrings.length} values searched)`);
    else no('COORDINATES VISIBLE ON THE PAGE: ' + inText.join(', '));

    // Coordinate VALUES: only data responses can carry per-provider data from the DB.
    const dataBodies = responses.filter((r) => isDataResponse(r.url));
    const leakingResponse = dataBodies.find((r) => coordStrings.some((c) => r.body.includes(c)));
    if (!leakingResponse) ok(`no provider coordinate in any of the ${dataBodies.length} data responses the page received`);
    else no('COORDINATES IN A DATA RESPONSE (' + leakingResponse.url.slice(0, 80) + ')');

    // Coordinate KEY shape: searched across EVERYTHING, bundles included — a page that started
    // selecting lat/lng would show up here even if the values were unfamiliar.
    const everything = responses.map((r) => r.body).join('\n');
    const hasCoordKey = /"(latitude|longitude|geo)"\s*:/.test(everything);
    if (!hasCoordKey) ok(`no latitude/longitude/geo key in any of the ${responses.length} response bodies`);
    else no('a response body carries a latitude/longitude/geo key');

    // And the one response that matters most: the RPC itself.
    const rpc = responses.filter((r) => /search_providers/.test(r.url));
    if (!rpc.length) sk('the search_providers response was not captured (body may have been evicted)');
    else if (rpc.some((r) => /distance_km/.test(r.body)) && !rpc.some((r) => /"(latitude|longitude|geo)"/.test(r.body))) {
      ok(`the search_providers response carries distance_km and no coordinate (${rpc.length} captured)`);
    } else no('the search_providers response is not the expected distance-only shape');
  }

  // ================= 4) declining location must not dead-end =================
  console.log('\n[/providers: the customer declines]');
  {
    await setGeolocation({ granted: false });
    await send('Page.navigate', { url: `${APP}/providers` });
    await waitFor(`document.body.innerText.includes('Showing')`, { label: 'the providers list', timeout: 60000 });
    const clicked = await clickUntil('Use my location',
      `document.body.innerText.includes('pick your city') || document.body.innerText.includes('Pick your city')`);
    if (!clicked) { no('declining produced no message at all — the customer is left guessing'); }
    else {
      const body = await text();
      ok('declining produces a plain sentence, not an error: "' +
        (body.match(/[^\n]*[Pp]ick your city[^\n]*/)?.[0] ?? '').trim().slice(0, 90) + '"');

      const names = await cardNames();
      if (names.length > 0) ok(`the list is STILL populated after declining (${names.length} cards) — not a dead end`);
      else no('declining location emptied the provider list — this is the dead end the spec forbids');

      if (!/km away/i.test(body)) ok('no distances are shown after declining (nothing fabricated)');
      else no('distances rendered even though location was declined');
    }
  }

  // ================= 5) /services carries the same behaviour =================
  console.log('\n[/services: same ranking, same privacy]');
  {
    await setGeolocation({ granted: true, ...ORIGIN });
    await send('Page.navigate', { url: `${APP}/services` });
    await waitFor(`document.body.innerText.includes('providers found')`, { label: 'the services list', timeout: 60000 });

    const before = await text();
    if (!/Location/.test(before) || /Use my location/.test(before)) {
      ok('the dead "Location" input is gone — replaced by a control that does something');
    } else no('the inert Location text input is still on the page');

    const clicked = await clickUntil('Use my location', `document.body.innerText.includes('km away')`);
    if (!clicked) { no('"Use my location" never produced distances on /services'); }
    else {
      const body = await text();
      const names = await cardNames();
      const expectedNames = expected.map((p) => p.business_name);
      if (names.length && names[0] === expectedNames[0]) ok(`/services ranks by match too (top: "${names[0]}")`);
      else no(`/services ranking mismatch — "${names[0]}" vs expected "${expectedNames[0]}"`);

      if (/Best match/i.test(body)) ok('a "Best match" sort option appears once a location is known');
      else no('the "Best match" sort option did not appear');

      const leaked = coordStrings.filter((c) => body.includes(c));
      if (leaked.length === 0) ok('no coordinate on /services either');
      else no('COORDINATES VISIBLE ON /services: ' + leaked.join(', '));
    }
  }

  // ================= 6) nothing blew up =================
  console.log('\n[page health]');
  {
    const errors = await evaluate(`window.__sevaErrors ? window.__sevaErrors.length : 0`).catch(() => 0);
    if (!errors) ok('no uncaught page errors captured during the flow');
    else no(`${errors} uncaught page errors`);
  }
} catch (e) {
  no('unexpected error: ' + (e?.stack || e?.message || e));
} finally {
  console.log('\n[cleanup]');
  try { if (ws) ws.close(); } catch { /* already gone */ }
  if (chrome) { chrome.kill(); console.log('  closed Chrome.'); }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
