/* SERVER-ONLY. Authenticate an API caller from the `Authorization: Bearer <access_token>`
 * header. This repo uses the plain supabase-js client (no SSR cookie helpers), so the browser
 * sends its Supabase access token explicitly; we validate it with the service-role client's
 * getUser(). Returns the authenticated user id, or null when there's no valid token. */

import { getSupabaseAdmin } from './supabase-admin';

export async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}
