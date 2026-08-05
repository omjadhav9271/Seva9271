/*
  Runs the whole Seva verification suite in one command and prints a single summary.

  Why: the suite is 13 DB scripts + 2 browser checks, each wanting the same six env vars, and
  three of them quietly degrade when the dev server is down (verify-step5 bails outright, the
  admin contact-route and realtime checks skip). Run piecemeal it is easy to read a green-looking
  run that silently verified less than you think. This checks the preconditions first and says so.

  Usage (from the repo root):
    node scripts/verify-all.mjs            # everything, including the browser checks
    node scripts/verify-all.mjs --no-ui    # DB suite only (no Chrome needed)

  Credentials default to the three live test accounts and can be overridden with the usual
  CUSTOMER_/PROVIDER_/STRANGER_ env vars. Needs `npm run dev` on :3000 for full coverage.
*/
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DB_SCRIPTS = [
  'verify-hardening', 'verify-provider-pii', 'verify-step2', 'verify-step3', 'verify-step4',
  'verify-step5', 'verify-step6', 'verify-step7', 'verify-step8', 'verify-step8-evidence',
  'verify-step9', 'verify-step9-5', 'verify-step10',
];
const UI_SCRIPTS = ['ui-check-step8', 'ui-check-step9', 'ui-check-step10', 'ui-check-dispute-clarity'];
const withUi = !process.argv.includes('--no-ui');

const creds = {
  CUSTOMER_EMAIL: 'test2@gmail.com', CUSTOMER_PASSWORD: 'test2@9271',
  PROVIDER_EMAIL: 'test1@gmail.com', PROVIDER_PASSWORD: 'test1@9271',
  STRANGER_EMAIL: 'test3@gmail.com', STRANGER_PASSWORD: 'test3@9271',
};
const childEnv = { ...process.env };
for (const [k, v] of Object.entries(creds)) childEnv[k] ??= v;

// ---- preconditions ----
let env = {};
try {
  env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
} catch { console.log('Cannot run: .env.local not found (run from the repo root).'); process.exit(1); }

for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[key]) { console.log(`Cannot run: ${key} missing from .env.local.`); process.exit(1); }
}

let serverUp = false;
try {
  // Generous on purpose: `next dev` compiles the route on the first request, and a cold server has
  // been measured taking ~7s (much worse when it has been running for hours). A short timeout here
  // silently downgrades the run to DB-only — a green suite that never opened a browser.
  const r = await fetch('http://localhost:3000', { signal: AbortSignal.timeout(45000) });
  serverUp = r.status < 500;
} catch { serverUp = false; }

console.log('DB:', env.NEXT_PUBLIC_SUPABASE_URL);
console.log('dev server on :3000:', serverUp ? 'up' : 'DOWN');
if (!serverUp) {
  console.log('  ⚠ verify-step5 will not run at all, and the admin contact-route + realtime');
  console.log('    checks will skip. Start `npm run dev` for full coverage.');
}
console.log('browser checks:', withUi ? (serverUp ? 'yes' : 'skipped (needs the dev server)') : 'off (--no-ui)');
console.log('');

// ---- run ----
const run = (script) => new Promise((resolve) => {
  const child = spawn(process.execPath, [`scripts/${script}.mjs`], { env: childEnv });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ out, code }));
});

const rows = [];
let totalPass = 0, totalFail = 0, totalSkip = 0, missing = 0;

const scripts = [...DB_SCRIPTS, ...(withUi && serverUp ? UI_SCRIPTS : [])];
for (const script of scripts) {
  process.stdout.write(script.padEnd(24) + ' … ');
  const { out, code } = await run(script);
  const m = out.match(/^RESULT: (\d+) passed, (\d+) failed(?:, (\d+) skipped)?/m);
  if (!m) {
    const why = (out.match(/^(Cannot run|Cannot reach).*/m) ?? ['no RESULT line'])[0];
    console.log('— did not report (' + why.trim().slice(0, 80) + ')');
    rows.push({ script, missing: true, why });
    missing++;
    continue;
  }
  const [p, f, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  totalPass += p; totalFail += f; totalSkip += s;
  console.log(`${p} passed, ${f} failed${s ? `, ${s} skipped` : ''}${code !== 0 && f === 0 ? ' (non-zero exit)' : ''}`);
  rows.push({ script, p, f, s, out });
}

// ---- failures in detail ----
const failed = rows.filter((r) => r.f > 0);
if (failed.length) {
  console.log('\n──── failures ────');
  for (const r of failed) {
    console.log(`\n[${r.script}]`);
    for (const line of r.out.split('\n').filter((l) => l.includes('✗ FAIL'))) console.log('  ' + line.trim());
  }
}

const skipped = rows.filter((r) => r.s > 0);
if (skipped.length) {
  console.log('\n──── skips (each one is coverage you did NOT get) ────');
  for (const r of skipped) {
    for (const line of r.out.split('\n').filter((l) => l.includes('– SKIP'))) {
      console.log(`  [${r.script}] ` + line.replace(/.*– SKIP\s+/, '').trim().slice(0, 120));
    }
  }
}

console.log('\n═══════════════════════════════════════════════');
console.log(`TOTAL: ${totalPass} passed, ${totalFail} failed, ${totalSkip} skipped` +
  (missing ? `, ${missing} script(s) did not report` : ''));
if (!serverUp) console.log('NOTE: this run was incomplete — the dev server was down.');
process.exit(totalFail === 0 && missing === 0 ? 0 : 1);
