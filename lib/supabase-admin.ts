/* SERVER-ONLY Supabase client. Uses the service-role key, which BYPASSES RLS.
 *
 * Import this ONLY from app/api/** route handlers (server code). Never import it from a
 * client component, and never expose SUPABASE_SERVICE_ROLE_KEY to the browser (it must not
 * be NEXT_PUBLIC_*). Doing so would hand every visitor god-mode over the database.
 *
 * Invariant #2 (wallet is server-only) and #5 (money moves only via escrow) rest on this
 * boundary: the wallet credit + escrow release are reachable only through the DB's
 * SECURITY DEFINER functions and this service-role key, never a signed-in user's session.
 *
 * Construction is lazy so `next build` (which imports route modules) does not crash when the
 * secret is absent — a request against a misconfigured deploy fails loudly instead. */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('supabase-admin: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server-only).');
  }
  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
