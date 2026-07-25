/* GET /api/admin/dispute-contacts?disputeId=... — ADMIN ONLY.
 *
 * Returns both parties' contact details (name, phone, address, email) so an admin can reach out
 * to verify facts while resolving a dispute. This lives in a server route (not the client) on
 * purpose: the provider's business phone/work_address are column-REVOKED from `authenticated`
 * (the Step-7 PII hardening), and emails live in auth.users which the client SDK can't read at
 * all — only the service role can assemble this. Gated by is_admin so it's a single controlled
 * surface, never exposed to the other party. */

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getUserIdFromRequest } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const admin = getSupabaseAdmin();
  const { data: prof } = await admin.from('profiles').select('role').eq('id', userId).maybeSingle();
  if (prof?.role !== 'admin') {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }

  const disputeId = new URL(req.url).searchParams.get('disputeId');
  if (!disputeId) return NextResponse.json({ error: 'disputeId required' }, { status: 400 });

  const { data: dispute } = await admin.from('disputes').select('booking_id').eq('id', disputeId).maybeSingle();
  if (!dispute) return NextResponse.json({ error: 'dispute not found' }, { status: 404 });

  const { data: booking } = await admin
    .from('bookings').select('customer_id, provider_id').eq('id', dispute.booking_id).maybeSingle();
  if (!booking) return NextResponse.json({ error: 'booking not found' }, { status: 404 });

  const emailOf = async (uid: string | null | undefined) => {
    if (!uid) return null;
    const { data } = await admin.auth.admin.getUserById(uid);
    return data?.user?.email ?? null;
  };

  // Customer: personal profile + auth email.
  const { data: cust } = await admin
    .from('profiles').select('full_name, phone, address, city, state').eq('id', booking.customer_id).maybeSingle();

  // Provider: the business row (phone/work_address are server-only) + the owner's personal profile + email.
  const { data: sp } = await admin
    .from('service_providers').select('user_id, business_name, phone, work_address, city, state')
    .eq('id', booking.provider_id).maybeSingle();
  const { data: provProfile } = sp?.user_id
    ? await admin.from('profiles').select('full_name, phone').eq('id', sp.user_id).maybeSingle()
    : { data: null };

  return NextResponse.json({
    customer: {
      name: cust?.full_name ?? null,
      phone: cust?.phone ?? null,
      email: await emailOf(booking.customer_id),
      address: cust?.address ?? ([cust?.city, cust?.state].filter(Boolean).join(', ') || null),
    },
    provider: {
      business_name: sp?.business_name ?? null,
      name: provProfile?.full_name ?? null,
      // prefer the business line; fall back to the owner's personal number
      phone: sp?.phone ?? provProfile?.phone ?? null,
      email: await emailOf(sp?.user_id),
      address: sp?.work_address ?? ([sp?.city, sp?.state].filter(Boolean).join(', ') || null),
    },
  });
}
