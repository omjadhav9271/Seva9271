/* Test-account credentials for the verify/ui-check suite.

   They used to be hardcoded in five scripts and printed in the usage comment of a dozen more;
   they now come from .env.local (gitignored via `.env*.local`), with .env.example documenting the
   keys. These are disposable throwaway accounts, so this is tidiness rather than secret-handling.

   Precedence: an explicit environment variable wins (so a one-off run can override), then
   .env.local, then nothing — and "nothing" fails loudly rather than falling back to a literal.

   NAMING: the third account is the ADMIN (role='admin'). Older scripts call it STRANGER_*, from
   the permission tests where the admin doubles as someone who is not a party to the booking —
   that is a usage, not its identity. ADMIN_* is canonical; the two resolve to the same account. */

import { readFileSync } from 'node:fs';

// Same .env parser the scripts already use; missing file is not fatal here (env vars may supply
// everything), the caller decides what it needs.
export function readEnvLocal(file = '.env.local') {
  try {
    return Object.fromEntries(
      readFileSync(file, 'utf8').split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
    );
  } catch { return {}; }
}

const envLocal = readEnvLocal();

// ADMIN_* and STRANGER_* are two names for the same (admin) account, so a .env.local that defines
// either one satisfies a script asking for the other.
const ALIAS = { ADMIN: 'STRANGER', STRANGER: 'ADMIN' };
const aliasOf = (key) => {
  const m = key.match(/^(ADMIN|STRANGER)_(EMAIL|PASSWORD)$/);
  return m ? `${ALIAS[m[1]]}_${m[2]}` : null;
};

// One key, by precedence: env var → .env.local → the same key under its alias. Undefined if unset.
export const cred = (key) => {
  const alias = aliasOf(key);
  return process.env[key] || envLocal[key]
    || (alias ? process.env[alias] || envLocal[alias] : undefined)
    || undefined;
};

// { email, password } for a prefix such as 'CUSTOMER'. `fallbackPrefix` lets a role-specific name
// borrow another account's credentials (ui-check-step9's APPLICANT is the customer).
export function account(prefix, fallbackPrefix = null) {
  const pick = (suffix) => cred(`${prefix}_${suffix}`) ?? (fallbackPrefix ? cred(`${fallbackPrefix}_${suffix}`) : undefined);
  return { email: pick('EMAIL'), password: pick('PASSWORD') };
}

// Exit with the suite's "Cannot run:" convention (verify-all matches on that prefix and reports
// the script as "did not report" rather than silently counting a green run).
export function requireAccounts(prefixes) {
  const out = {};
  const missing = [];
  for (const entry of prefixes) {
    const [prefix, fallback] = Array.isArray(entry) ? entry : [entry, null];
    const a = account(prefix, fallback);
    if (!a.email || !a.password) missing.push(`${prefix}_EMAIL / ${prefix}_PASSWORD`);
    out[prefix] = a;
  }
  if (missing.length) {
    console.log('Cannot run: missing test credentials — ' + missing.join(', ') + '.');
    console.log('  Add them to .env.local (gitignored) or pass them as environment variables.');
    console.log('  See .env.example for the key names.');
    process.exit(0);
  }
  return out;
}

// The three accounts verify-all hands to every child process. ADMIN is the real name of the third
// one; verify-all also exports it as STRANGER_* for the scripts that still ask for that.
export const SUITE_PREFIXES = ['CUSTOMER', 'PROVIDER', 'ADMIN'];

/* Every auth user, paginated.
   `service.auth.admin.listUsers()` returns ONE page — 50 by default, and the scripts that passed
   `{ perPage: 200 }` were only ever buying headroom, not correctness. The moment the project held
   more than that, "find the user whose email is test1@…" started returning undefined and five
   ui-check scripts aborted with "Cannot run: test accounts not found" — which reads like missing
   credentials, not a truncated list. (Found by seeding 480 scale-test users; it would have hit
   just as hard on the 201st real signup.) Always page until a short page comes back. */
export async function listAllUsers(service, { perPage = 1000, maxPages = 100 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error('listUsers: ' + error.message);
    const users = data?.users ?? [];
    all.push(...users);
    if (users.length < perPage) break;
  }
  return all;
}
