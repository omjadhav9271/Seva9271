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
/* The FIRST rung of the widening ladder in lib/matching.ts. Every "what should the page show"
   figure below is computed at this radius, because the page stops widening as soon as a rung
   returns three providers — and Mumbai centre is dense, so it never leaves the first one. If a
   check here starts failing by showing MORE than expected, suspect that the data thinned out and
   the page widened, not that a filter broke. */
const NEAR_KM = 15;

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
/* Outbound search_providers calls, counted separately from response bodies: a page that re-queries
   in a render loop is invisible to every other assertion here — it renders the right cards, shows
   the right distances, leaks nothing — while hammering the database. Only the request RATE shows it. */
let rpcRequests = 0;
function watchNetwork() {
  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Network.requestWillBeSent'
        && /rpc\/search_providers/.test(msg.params?.request?.url ?? '')) rpcRequests++;
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
    p_lat: ORIGIN.lat, p_lng: ORIGIN.lng, p_category_id: null, p_radius_km: NEAR_KM, p_limit: 30,
  });
  if (rpcErr) { console.log('Cannot run: search_providers failed — ' + rpcErr.message); process.exit(1); }
  if (!expected?.length) { console.log('Cannot run: no geocoded approved providers to rank.'); process.exit(0); }

  const { data: truth } = await service.from('service_providers')
    .select('business_name, latitude, longitude').eq('status', 'approved').not('latitude', 'is', null);
  // The exact decimal strings a leak would most likely carry.
  const coordStrings = (truth ?? []).flatMap((t) => [String(t.latitude), String(t.longitude)])
    .filter((s) => s && s.length >= 6);

  const profile = mkdtempSync(join(tmpdir(), 'seva-cdp11-'));
  /* Headed by default (same convention as ui-check-step9): this check's whole point is the part a
     human has to see — ranking order, distance copy, the fallback sentence. HEADLESS=1 for CI.
     The window size is explicit either way: the navbar links are `hidden md:flex`, so Chrome's
     default headless viewport puts them at display:none and every nav assertion fails against a
     perfectly correct page. */
  const HEADLESS = process.env.HEADLESS === '1';
  chrome = spawn(CHROME, [
    ...(HEADLESS ? ['--headless=new'] : []),
    '--remote-debugging-port=9224', `--user-data-dir=${profile}`, '--window-size=1440,900',
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
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  console.log(`driving real Chrome (${HEADLESS ? 'headless' : 'headed'}) against ` + APP);
  console.log('expected top-ranked provider: ' + expected[0].business_name +
    ` (${expected[0].distance_km} km, reputation ${expected[0].reputation_score})\n`);

  // ================= 1) /providers — the catalog fallback is the starting state =================
  console.log('[/providers: before sharing a location]');
  /* Permission DENIED here, and that is the whole point of the section.
     This used to grant geolocation and then assert the un-located state, which was harmless while
     the page only read a position when "Use my location" was clicked. It is no longer: the search
     control now PREFILLS from the device when permission has already been given (that is the
     feature — a returning customer should not have to ask twice), so a granted browser ranks on
     load and this section was asserting against a page that had correctly moved on.
     It passed standalone and failed inside verify-all, which is the signature of a race, not of a
     wrong expectation — the check was racing the prefill's two awaits and usually winning on an
     idle machine. Denying the permission makes the precondition explicit instead of inherited, so
     the un-located state is now reached deterministically rather than by being quick. */
  await setGeolocation({ granted: false });
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

  /* ===== 1b) an ALREADY-PERMITTED browser prefills, without being asked twice =====
     The other half of the section above, and the reason it had to change. A customer who has
     already granted location should land on ranked results; making them click "Use my location"
     every visit is asking a question they have answered. Crucially this must NOT prompt — it only
     reads a position when the permission is already granted. */
  console.log('\n[/providers: an already-permitted browser prefills on load]');
  {
    await setGeolocation({ granted: true, ...ORIGIN });
    await send('Page.navigate', { url: `${APP}/providers` });
    await waitFor(`document.body.innerText.includes('Showing')`, { label: 'the providers list', timeout: 60000 });
    try {
      await waitFor(`document.body.innerText.includes('km away') || document.body.innerText.includes('m away')`,
        { label: 'distances without any click', timeout: 20000 });
      ok('a browser that already granted location ranks on load — nothing to click');
      const shownLabel = await evaluate(`(document.body.innerText.match(/Searching near\\s*\\n?\\s*([^\\n]+)/) || [])[1] || null`);
      if (shownLabel) ok(`...and says where it is searching from ("${shownLabel}"), editably`);
      else no('the prefilled location is not shown back to the customer');
    } catch {
      no('an already-permitted browser did NOT prefill — the customer must ask twice');
    }
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

  /* ===== 6) REGRESSION: every city offered must be a city we can rank from =====
     The dropdown used to be built from the cities present in the provider rows while the anchors
     were a hardcoded list of four. Any city missing from that list (Kalyan, Bengaluru, Mumbai
     Suburban — 312 of 485 providers at the time) silently fell back to the unranked catalog: no
     ordering, no distances, no explanation. A choice the ranking cannot honour must not be offered. */
  console.log('\n[city dropdown: every option can actually rank]');
  {
    const { data: cityAnchors, error: caErr } = await service.rpc('city_anchors');
    if (caErr) {
      no('city_anchors() failed: ' + caErr.message);
    } else if (!cityAnchors?.length) {
      sk('city_anchors() returned nothing — too few providers per city to anchor');
    } else {
      await setGeolocation({ granted: true, ...ORIGIN });
      await send('Page.navigate', { url: `${APP}/providers` });
      /* Scope BOTH the wait and the read to the city dropdown by its aria-label. These used to say
         `document.querySelectorAll('select')`, which was fine when the page had exactly one — the
         sort control added a second, and the loose version then (a) waited on the SORT select's
         options, which render immediately, so it stopped waiting before the city anchors had
         arrived from the DB, and (b) read "reviews / price_low / price_high" back as if they were
         cities that could not rank. Both failures pointed at the app; both were this selector. */
      const CITY_SELECT = `select[aria-label="Search from a city"]`;
      await waitFor(`(document.querySelector('${CITY_SELECT}') || { options: [] }).options.length > 1`,
        { label: 'city options', timeout: 60000 });
      const options = await evaluate(`[...document.querySelector('${CITY_SELECT}').options]
        .slice(1).map(o => o.value)`);
      const anchorCities = cityAnchors.map((c) => c.city);
      const unrankable = options.filter((o) => !anchorCities.includes(o));
      if (unrankable.length === 0) ok(`all ${options.length} offered cities have an anchor (${anchorCities.length} available)`);
      else no('cities offered that CANNOT rank: ' + unrankable.join(', '));

      // And prove it end to end on the biggest one, rather than trusting the list comparison.
      const target = anchorCities[0];
      const picked = await evaluate(`(() => { const s = document.querySelector('${CITY_SELECT}');
        if (!s || ![...s.options].some(o => o.value === ${JSON.stringify(target)})) return false;
        const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
        set.call(s, ${JSON.stringify(target)}); s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
      if (!picked) no(`the city dropdown never offered "${target}" to pick`);
      if (picked) {
        try {
          await waitFor(`document.body.innerText.includes(${JSON.stringify('near ' + target)})`,
            { label: `results near ${target}`, timeout: 25000 });
          const withDistance = await evaluate(`[...document.querySelectorAll('a[href^="/providers/"]')]
            .filter(a => /km away|m away/.test(a.innerText)).length`);
          const total = await evaluate(`document.querySelectorAll('a[href^="/providers/"]').length`);
          if (total > 0 && withDistance === total) ok(`picking "${target}" ranks and shows a distance on all ${total} cards`);
          else no(`picking "${target}" left ${total - withDistance} of ${total} cards with no distance`);
        } catch {
          no(`picking "${target}" did not produce ranked results — it fell back to the flat list`);
        }
      }
    }
  }

  /* ===== 7) REGRESSION: the category filters the QUERY, not the results =====
     /services used to call the RPC unfiltered with limit 60 and filter by category in the browser.
     A filter applied after a ranked cut is a sample, not a filter: electricians near Kalyan showed
     2 of the 7 in range, and the 5 it dropped included nearer ones. */
  console.log('\n[category filtering happens server-side]');
  {
    /* Drive the labels the PAGE offers, not the DB's category names: /services carries its own
       hardcoded chip list, so the DB's "Farm Fresh Delivery" is the button "Farm Fresh" and a
       click on the DB name silently finds nothing. (That list also covers only some of the
       categories that exist — noted in the decisions log, pre-dates Step 11.) */
    const { data: cats } = await service.from('service_categories').select('id, name, slug');
    await send('Page.navigate', { url: `${APP}/services` });
    const labelOf = (name) => {
      const short = name.split('/')[0].trim();
      return short.length <= 20 ? short : short.split('&')[0].trim();
    };
    /* Wait for THIS page before waiting for anything on it. A category label is not a unique
       marker — /providers renders category names on its cards, so waiting for "Appliance Repair"
       matched the page we were leaving, and the chips were then read off /providers, which has
       none. Anchor on the <h1> first, then on a chip. */
    await waitFor(`document.querySelector('h1') &&
      document.querySelector('h1').textContent.includes('Browse Services')`,
      { label: 'the /services heading', timeout: 60000 });
    const firstLabel = labelOf((cats ?? [{ name: 'Electrician' }])[0].name);
    await waitFor(`[...document.querySelectorAll('button')]
      .some(b => b.textContent.trim() === ${JSON.stringify(firstLabel)})`,
      { label: `a category chip ("${firstLabel}")`, timeout: 60000 });

    /* REGRESSION: the chips must come from service_categories, not a hardcoded mirror of it.
       The page shipped a 14-entry array against a 25-row table, so Laundry, Maid, Mason, Painter,
       Security, Tailor, Water Tanker, Mobile Repair, Cycle Repair, Auto Rickshaw and Cow Dung
       could not be filtered here at all. Categories are admin-managed, so a mirrored list goes
       stale on the very next insert. */
    {
      const chipTexts = await evaluate(`[...document.querySelectorAll('button')]
        .map(b => b.textContent.trim()).filter(Boolean)`);
      const missing = (cats ?? []).filter((c) => !chipTexts.includes(labelOf(c.name)));
      if (missing.length === 0) ok(`all ${cats.length} categories from the DB have a chip`);
      else no(`${missing.length} categories have no chip: ` + missing.map((c) => c.name).join(', '));
    }

    await waitFor(`document.body.innerText.includes('providers found')`, { label: 'the services list', timeout: 60000 });
    await sleep(2000);   // let the slug→id map land before the category is picked
    const chips = await evaluate(`[...document.querySelectorAll('button')]
      .map(b => b.textContent.trim())
      .filter(t => t && t !== 'All Services' && t.length < 24)`);

    let best = null;
    for (const c of cats ?? []) {
      const chip = chips.find((t) => c.name.toLowerCase().startsWith(t.toLowerCase()));
      if (!chip) continue;
      const { data } = await service.rpc('search_providers', {
        p_lat: ORIGIN.lat, p_lng: ORIGIN.lng, p_category_id: c.id, p_radius_km: NEAR_KM, p_limit: 500,
      });
      if ((data?.length ?? 0) > (best?.count ?? 0)) best = { ...c, chip, count: data.length };
    }
    if (!best || best.count === 0) {
      sk('no category reachable from the page chips has providers in range');
    } else {
      const expected = Math.min(best.count, 60);   // the page asks for 60
      const pickedCat = await clickUntil(best.chip, `document.body.innerText.includes('providers found')`);
      await sleep(1200);
      const located = await clickUntil('Use my location', `/km away|m away/.test(document.body.innerText)`);
      if (!pickedCat || !located) {
        no(`could not drive "${best.chip}" + location on /services`);
      } else {
        await sleep(1500);
        const shown = await evaluate(`document.querySelectorAll('a[href^="/providers/"]').length`);
        if (shown === expected) {
          ok(`"${best.chip}" near the origin returns all ${expected} in range (server-side filter)`);
        } else {
          no(`"${best.chip}" showed ${shown} of ${expected} in range — the category is applied AFTER the ranked cut`);
        }
        const noDistance = await evaluate(`[...document.querySelectorAll('a[href^="/providers/"]')]
          .filter(a => !/km away|m away/.test(a.innerText)).length`);
        if (noDistance === 0) ok('every category-filtered card still shows a distance');
        else no(`${noDistance} category-filtered cards show no distance`);
      }
    }
  }

  /* ===== 8) REGRESSION: the text box searches the QUERY, not the returned page =====
     /providers used to filter the 30 already-ranked rows by the typed text, so a search hit
     sitting at rank 31 was invisible while the box looked like it worked. The server now applies
     the query across everything in range, which is provable: type a term and the page must show
     the same count the category-filtered RPC does, including hits that were never in the top 30. */
  console.log('\n[text search is applied server-side]');
  {
    const { data: cats } = await service.from('service_categories').select('id, name, slug');
    const term = 'electric';
    const cat = (cats ?? []).find((c) => c.name.toLowerCase().includes(term));
    const { data: expectedRows } = await service.rpc('search_providers', {
      p_lat: ORIGIN.lat, p_lng: ORIGIN.lng, p_category_id: null,
      p_radius_km: NEAR_KM, p_limit: 500, p_query: term,
    });
    const { data: top30 } = await service.rpc('search_providers', {
      p_lat: ORIGIN.lat, p_lng: ORIGIN.lng, p_category_id: null, p_radius_km: NEAR_KM, p_limit: 30,
    });
    const inTop30 = (top30 ?? []).filter((p) => (p.category_name ?? '').toLowerCase().includes(term)
      || (p.business_name ?? '').toLowerCase().includes(term)).length;
    const expected = Math.min(expectedRows?.length ?? 0, 30);   // the page asks for 30

    if (!expected) {
      sk(`nothing matches "${term}" near the origin`);
    } else {
      await setGeolocation({ granted: true, ...ORIGIN });
      await send('Page.navigate', { url: `${APP}/providers` });
      await waitFor(`document.querySelector('h1') &&
        document.querySelector('h1').textContent.includes('All Providers')`,
        { label: 'the /providers heading', timeout: 60000 });
      const located = await clickUntil('Use my location', `document.body.innerText.includes('km away') ||
        document.body.innerText.includes('m away')`);
      if (!located) {
        no('could not put /providers into ranked mode');
      } else {
        await evaluate(`(() => {
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
          const box = document.querySelector('input[type=text]');
          set.call(box, ${JSON.stringify(term)});
          box.dispatchEvent(new Event('input', { bubbles: true }));
          return true; })()`);
        await sleep(2500);   // debounce (350ms) + round-trip
        const shown = await evaluate(`document.querySelectorAll('a[href^="/providers/"]').length`);
        if (shown === expected) {
          ok(`"${term}" shows all ${expected} matches in range (the top-30 alone held ${inTop30})`);
        } else {
          no(`"${term}" showed ${shown}, expected ${expected} — the text is filtering the returned page, not the query`);
        }
        if (expected > inTop30) {
          ok(`…and that is strictly more than filtering the ranked page would have found (${inTop30})`);
        } else {
          sk('every match already sat in the top 30 here, so this data cannot prove the difference');
        }
      }
    }
  }

  /* ===== 9) REGRESSION: /services searches the QUERY too =====
     The same defect as section 8, one page over, and it outlived the /providers fix by a day:
     /services asked for 60 rows and filtered THOSE by the typed text, so "electric" near Mumbai
     centre showed 2 of the 11 in range — 9 matching providers invisible. It matters more here than
     on /providers, because the homepage search box lands on this page. */
  console.log('\n[/services: text search is applied server-side]');
  {
    const term = 'electric';
    const { data: everything } = await service.rpc('search_providers', {
      p_lat: ORIGIN.lat, p_lng: ORIGIN.lng, p_category_id: null, p_radius_km: NEAR_KM, p_limit: 500, p_query: null,
    });
    const hits = (r) => (r.business_name ?? '').toLowerCase().includes(term)
      || (r.category_name ?? '').toLowerCase().includes(term);
    const expected = Math.min((everything ?? []).filter(hits).length, 60);  // the page asks for 60
    const inTop60 = (everything ?? []).slice(0, 60).filter(hits).length;

    if (!expected) {
      sk(`nothing matches "${term}" near the origin`);
    } else {
      await setGeolocation({ granted: true, ...ORIGIN });
      await send('Page.navigate', { url: `${APP}/services` });
      await waitFor(`document.querySelector('h1') !== null`, { label: 'the /services heading', timeout: 60000 });
      const located = await clickUntil('Use my location', `document.body.innerText.includes('km away') ||
        document.body.innerText.includes('m away')`);
      if (!located) {
        no('could not put /services into ranked mode');
      } else {
        await evaluate(`(() => {
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
          const box = [...document.querySelectorAll('input')]
            .find(i => (i.placeholder || '').includes('Search services or providers'));
          set.call(box, ${JSON.stringify(term)});
          box.dispatchEvent(new Event('input', { bubbles: true }));
          return true; })()`);
        await sleep(2500);   // debounce (350ms) + round-trip
        const shown = await evaluate(`document.querySelectorAll('a[href^="/providers/"]').length`);
        if (shown === expected) ok(`/services: "${term}" shows all ${expected} matches in range`);
        else no(`/services: "${term}" showed ${shown}, expected ${expected} — filtering the returned page, not the query`);
        if (expected > inTop60) ok(`…more than filtering the 60 rows it had would have found (${inTop60})`);
        else sk('every match already sat in the top 60 here, so this data cannot prove the difference');
      }
    }
  }

  /* ===== 10) REGRESSION: the homepage location control is real =====
     The hero's "Your location" was a free-text input writing ?location=, a parameter /services has
     never read: the customer's city was silently discarded and they landed on an unranked national
     list. A dead control on the front door of a location-matching product. It is now a city picker
     built from city_anchors(), emitting ?city=, which /services ranks from on arrival. */
  console.log('\n[homepage: the location control actually locates]');
  {
    const { data: cityAnchors } = await service.rpc('city_anchors');
    const pick = (cityAnchors ?? []).find((a) => a.provider_count >= 3) ?? (cityAnchors ?? [])[0];
    if (!pick) {
      sk('no city anchors available to test the hero with');
    } else {
      await send('Page.navigate', { url: `${APP}/` });
      await waitFor(`[...document.querySelectorAll('input')].some(i => (i.placeholder||'').includes('What service do you need'))`,
        { label: 'the homepage hero', timeout: 60000 });
      await sleep(1500);   // the anchors arrive from the DB after hydration

      const dead = await evaluate(
        `[...document.querySelectorAll('input')].some(i => (i.placeholder||'').includes('Your location'))`);
      if (dead) no('the homepage still carries the free-text "Your location" input wired to nothing');
      else ok('no dead free-text location input on the homepage');

      const options = await evaluate(`(() => {
        const s = document.querySelector('select[aria-label="City to search from"]');
        return s ? [...s.options].map(o => o.value).filter(Boolean) : null; })()`);
      const offered = new Set(options ?? []);
      const rankable = (cityAnchors ?? []).map((a) => a.city);
      if (!options) {
        no('the homepage hero has no city picker');
      } else if (rankable.every((c) => offered.has(c)) && [...offered].every((c) => rankable.includes(c))) {
        ok(`the hero offers exactly the ${rankable.length} cities we can rank from (city_anchors, not a hardcoded list)`);
      } else {
        no(`hero cities and rankable cities differ: offered ${[...offered].join(', ')} vs ${rankable.join(', ')}`);
      }

      if (options) {
        await evaluate(`(() => {
          const s = document.querySelector('select[aria-label="City to search from"]');
          const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;
          set.call(s, ${JSON.stringify(pick.city)});
          s.dispatchEvent(new Event('change', { bubbles: true }));
          const box = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('What service do you need'));
          box.closest('form').requestSubmit();
          return true; })()`);
        await waitFor(`location.pathname === '/services'`, { label: '/services after the hero search', timeout: 30000 });
        const url = await evaluate('location.href');
        if (url.includes(`city=${encodeURIComponent(pick.city)}`)) ok(`the hero emits ?city=${pick.city}, not the dead ?location=`);
        else no(`the hero navigated to ${url} — the chosen city is not in the URL`);

        try {
          await waitFor(`document.body.innerText.includes('km away') || document.body.innerText.includes('m away')`,
            { label: `distances after landing on ?city=${pick.city}`, timeout: 30000 });
          const shown = await evaluate(`document.querySelectorAll('a[href^="/providers/"]').length`);
          ok(`/services ranks from ${pick.city} on arrival — ${shown} cards, each with a distance`);
          const selected = await evaluate(`(() => {
            const s = [...document.querySelectorAll('select')]
              .find(x => [...x.options].some(o => o.value === ${JSON.stringify(pick.city)}));
            return s ? s.value : null; })()`);
          if (selected === pick.city) ok(`the /services city picker shows "${pick.city}" — the choice is visible, not implicit`);
          else no(`the /services city picker shows "${selected}" after arriving with ?city=${pick.city}`);
        } catch {
          no(`landing on ?city=${pick.city} did not rank — the location choice is still being dropped`);
        }
      }
    }
  }

  /* ===== 10b) REGRESSION: the rating floor and availability toggle filter the QUERY =====
     The last two of the family. Both were applied in the browser to the 60 rows already ranked, so
     "Available only" showed the available providers among the top 60 — not the available providers
     in range — and a 4.8-rated provider ranked 61st was unreachable whatever you set. */
  console.log('\n[/services: rating and availability filter the query]');
  {
    const { data: everything } = await service.rpc('search_providers', {
      p_lat: ORIGIN.lat, p_lng: ORIGIN.lng, p_category_id: null, p_radius_km: NEAR_KM, p_limit: 500,
      p_query: null, p_min_rating: null, p_available_only: false,
    });
    const inRange = everything ?? [];
    const cases = [
      {
        label: '4+ rating',
        click: `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '4+')`,
        expected: Math.min(inRange.filter((p) => Number(p.rating) >= 4).length, 60),
        naive: inRange.slice(0, 60).filter((p) => Number(p.rating) >= 4).length,
      },
      {
        // Now a plain checkbox in the results toolbar rather than a switch in the sidebar — the
        // control moved to where the results are, but the property under test is unchanged: it
        // must filter the QUERY, not the page.
        label: 'Available now',
        click: `document.querySelector('input[type="checkbox"][aria-label="Available now"]')`,
        expected: Math.min(inRange.filter((p) => p.is_available).length, 60),
        naive: inRange.slice(0, 60).filter((p) => p.is_available).length,
      },
    ];

    for (const c of cases) {
      if (!c.expected) { sk(`nothing in range matches "${c.label}"`); continue; }
      await setGeolocation({ granted: true, ...ORIGIN });
      await send('Page.navigate', { url: `${APP}/services` });
      await waitFor(`document.querySelector('h1') !== null`, { label: 'the /services heading', timeout: 60000 });
      const located = await clickUntil('Use my location', `document.body.innerText.includes('km away') ||
        document.body.innerText.includes('m away')`);
      if (!located) { no(`could not rank /services for the "${c.label}" case`); continue; }

      const clicked = await evaluate(`(() => { const el = ${c.click}; if (!el) return false; el.click(); return true; })()`);
      if (!clicked) { no(`could not find the "${c.label}" control`); continue; }
      await sleep(2500);   // debounce (350ms) + round-trip
      const shown = await evaluate(`document.querySelectorAll('a[href^="/providers/"]').length`);
      if (shown === c.expected) ok(`/services: "${c.label}" returns all ${c.expected} in range`);
      else no(`/services: "${c.label}" showed ${shown}, expected ${c.expected} — filtering the returned page, not the query`);
      if (c.expected > c.naive) ok(`…more than filtering the 60 rows it had would have found (${c.naive})`);
      else sk(`every "${c.label}" match already sat in the top 60, so this data cannot prove the difference`);
    }
  }

  /* ===== 10c) the sort toggle re-orders the RESULT SET, not the page =====
     The same family as every filter before it. A client-side "Top rated" over a match-ranked cut
     shows the best rated OF THE 60 THAT CAME BACK, which looks like a working control while the
     genuinely best-rated provider in range sits unreachable at rank 61. So the assertion is not
     "the order changed" but "the first card is the best-rated provider IN RANGE". */
  console.log('\n[/services: the sort runs in the query]');
  {
    const { data: byRating } = await service.rpc('search_providers', {
      p_lat: ORIGIN.lat, p_lng: ORIGIN.lng, p_category_id: null, p_radius_km: NEAR_KM, p_limit: 60,
      p_query: null, p_min_rating: null, p_available_only: false, p_sort: 'rating',
    });
    const { data: byMatch } = await service.rpc('search_providers', {
      p_lat: ORIGIN.lat, p_lng: ORIGIN.lng, p_category_id: null, p_radius_km: NEAR_KM, p_limit: 60,
      p_query: null, p_min_rating: null, p_available_only: false, p_sort: 'match',
    });

    if (!byRating?.length || !byMatch?.length) {
      sk('nothing in range to sort');
    } else if (byRating[0].id === byMatch[0].id) {
      sk('the best match is also the best rated here — this data cannot tell the two sorts apart');
    } else {
      await setGeolocation({ granted: true, ...ORIGIN });
      await send('Page.navigate', { url: `${APP}/services` });
      await waitFor(`document.querySelector('h1') !== null`, { label: 'the /services heading', timeout: 60000 });
      const located = await clickUntil('Use my location', `document.body.innerText.includes('km away') ||
        document.body.innerText.includes('m away')`);
      if (!located) {
        no('could not rank /services for the sort check');
      } else {
        const first = (await cardNames())[0];
        if (first === byMatch[0].business_name) ok(`"Best match" is the default — first card is ${first}`);
        else no(`default sort showed ${first}, expected the best match ${byMatch[0].business_name}`);

        const clicked = await clickContaining('Top rated');
        if (!clicked) { no('could not find the "Top rated" sort control'); }
        else {
          await sleep(2500);   // debounce (350ms) + round-trip
          const top = (await cardNames())[0];
          if (top === byRating[0].business_name) {
            ok(`"Top rated" leads with the best-rated provider in range (${top}, ${byRating[0].rating}★)`);
          } else {
            no(`"Top rated" led with ${top}; the best-rated in range is ${byRating[0].business_name} (${byRating[0].rating}★)`);
          }
          // The naive version would have re-sorted the 60 match-ranked rows it already had.
          const naiveBest = Math.max(...byMatch.slice(0, 60).map((p) => Number(p.rating)));
          if (Number(byRating[0].rating) > naiveBest) {
            ok(`…higher than re-sorting the rows it had would have reached (${naiveBest}★)`);
          } else {
            sk('the best-rated provider already sat in the match-ranked page, so this cannot prove the difference');
          }
        }

        const nearest = await clickContaining('Nearest');
        if (nearest) {
          await sleep(2500);
          const dists = await evaluate(`[...document.querySelectorAll('a[href^="/providers/"]')]
            .map(a => (a.innerText.match(/([\\d.]+) km away/) || a.innerText.match(/~(\\d+) m away/) || [])[0] || '')
            .filter(Boolean)`);
          const km = (dists ?? []).map((s) => s.includes('km') ? parseFloat(s) : parseFloat(s.replace('~', '')) / 1000);
          if (km.length > 1 && km.every((d, i) => i === 0 || km[i - 1] <= d + 0.05)) {
            ok(`"Nearest" orders the page near→far (${km[0]} … ${km[km.length - 1]} km)`);
          } else {
            no('"Nearest" did not produce an ascending distance order: ' + km.join(', '));
          }
        } else {
          no('could not find the "Nearest" sort control');
        }
      }
    }
  }

  /* ===== 10d) NO BLANK SCREEN: the search widens, and stops honestly =====
     A fixed 25 km radius returned an empty page whenever the nearest provider was 26 km away —
     which reads as a broken product rather than as thin supply. The page must now widen to find
     the nearest people, and where nobody is reachable it must SAY so rather than render nothing. */
  console.log('\n[no blank screen: widening, then an honest empty state]');
  {
    // A sparse origin: few or nothing near, people further out.
    const SPARSE = [
      { name: 'Karjat', lat: 18.9107, lng: 73.3233 },
      { name: 'Alibaug', lat: 18.6414, lng: 72.8722 },
      { name: 'Lonavala', lat: 18.7546, lng: 73.4062 },
    ];
    let chosen = null;
    for (const c of SPARSE) {
      const near = await service.rpc('search_providers', {
        p_lat: c.lat, p_lng: c.lng, p_category_id: null, p_radius_km: NEAR_KM, p_limit: 60,
        p_query: null, p_min_rating: null, p_available_only: false, p_sort: 'match',
      });
      const wide = await service.rpc('search_providers', {
        p_lat: c.lat, p_lng: c.lng, p_category_id: null, p_radius_km: 150, p_limit: 60,
        p_query: null, p_min_rating: null, p_available_only: false, p_sort: 'match',
      });
      if ((near.data ?? []).length < 3 && (wide.data ?? []).length >= 3) { chosen = c; break; }
    }

    if (!chosen) {
      sk('no sparse-then-populated origin in the current data — widening cannot be shown in the browser');
    } else {
      await setGeolocation({ granted: true, lat: chosen.lat, lng: chosen.lng });
      await send('Page.navigate', { url: `${APP}/services` });
      await waitFor(`document.querySelector('h1') !== null`, { label: 'the /services heading', timeout: 60000 });
      const located = await clickUntil('Use my location', `document.body.innerText.includes('km away') ||
        document.body.innerText.includes('Nobody within')`);
      if (!located) {
        no(`could not rank /services from ${chosen.name}`);
      } else {
        await sleep(1500);
        const cards = await evaluate(`document.querySelectorAll('a[href^="/providers/"]').length`);
        const body = await text();
        if (cards > 0) ok(`${chosen.name}: ${cards} providers shown where a fixed ${NEAR_KM} km radius would have shown NONE`);
        else no(`${chosen.name}: the page is still empty — it did not widen`);
        if (body.includes('Nobody within')) ok('…and the page SAYS it had to look further out');
        else no('the page widened silently — the customer is not told why the nearest is far away');
      }
    }

    // The other end: somewhere genuinely uncovered. Never blank, never an absurd match.
    const REMOTE = { lat: 23.6, lng: 78.9 };   // rural Madhya Pradesh
    await setGeolocation({ granted: true, ...REMOTE });
    await send('Page.navigate', { url: `${APP}/services` });
    await waitFor(`document.querySelector('h1') !== null`, { label: 'the /services heading', timeout: 60000 });
    await clickUntil('Use my location', `document.body.innerText.includes('No providers serve your area yet') ||
      document.body.innerText.includes('km away')`, { attempts: 3 });
    await sleep(1500);
    {
      const cards = await evaluate(`document.querySelectorAll('a[href^="/providers/"]').length`);
      const body = await text();
      if (body.includes('No providers serve your area yet')) {
        ok('an uncovered location gets the honest empty state, not a blank column');
      } else {
        no('an uncovered location produced neither results nor an explanation: ' + body.slice(0, 160).replace(/\n/g, ' '));
      }
      if (cards === 0) ok('…and offers nobody — no 400 km "match" dressed up as local');
      else no(`${cards} providers were offered from an uncovered location`);
    }
  }

  /* ===== 11) REGRESSION: a settled page must stop querying =====
     /services re-queried in a render loop — 162 calls in 12 idle seconds (13.5/s) — because its
     slug→id map was rebuilt every render and used as an effect dependency, so each result set
     triggered the next query. Every other check in this file passed throughout: the cards, the
     ranking, the distances and the privacy were all correct while it hammered the database. A
     ranked page that nobody is touching must make ZERO further requests. */
  console.log('\n[a settled page stops querying]');
  {
    const IDLE_MS = 8000;
    for (const path of ['/services', '/providers']) {
      await setGeolocation({ granted: true, ...ORIGIN });
      await send('Page.navigate', { url: APP + path });
      await waitFor(`document.querySelector('h1') !== null`, { label: `the ${path} heading`, timeout: 60000 });
      const located = await clickUntil('Use my location', `document.body.innerText.includes('km away') ||
        document.body.innerText.includes('m away')`);
      if (!located) { sk(`could not put ${path} into ranked mode`); continue; }
      await sleep(2500);        // let the initial burst settle
      rpcRequests = 0;
      await sleep(IDLE_MS);     // nothing touches the page in this window
      if (rpcRequests === 0) ok(`${path} is silent while idle — no re-query loop`);
      else no(`${path} fired ${rpcRequests} search_providers calls in ${IDLE_MS / 1000}s idle ` +
        `(${(rpcRequests / (IDLE_MS / 1000)).toFixed(1)}/s) — it is re-querying in a render loop`);
    }
  }

  // ================= 12) nothing blew up =================
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
