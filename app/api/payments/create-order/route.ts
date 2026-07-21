/* POST /api/payments/create-order — start an escrow payment for a booking.
 *
 * Auth: the signed-in CUSTOMER on this booking (Bearer access token).
 * The amount is read from the DB (price_agreed), never from the request body, and converted
 * to paise for Razorpay. We create a Razorpay order and record it in payment_transactions
 * with status 'created'. No money moves here and nothing is marked 'held' — only the webhook
 * (the source of truth) can do that after Razorpay captures the payment. */

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getUserIdFromRequest } from '@/lib/api-auth';
import { getRazorpay } from '@/lib/razorpay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A payment can only be started while the job is live and nothing has been captured yet.
const PAYABLE_STATUSES = ['accepted', 'en_route', 'arrived', 'in_progress'];

export async function POST(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { bookingId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const bookingId = body.bookingId;
  if (!bookingId) {
    return NextResponse.json({ error: 'bookingId required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // Load the booking server-side (service role bypasses RLS; we authorize explicitly below).
  const { data: booking, error: bErr } = await admin
    .from('bookings')
    .select('id, customer_id, status, payment_status, payment_method, price_agreed, total_amount')
    .eq('id', bookingId)
    .maybeSingle();
  if (bErr) {
    return NextResponse.json({ error: 'lookup failed' }, { status: 500 });
  }
  if (!booking) {
    return NextResponse.json({ error: 'booking not found' }, { status: 404 });
  }

  // Only the booking's own customer may pay for it.
  if (booking.customer_id !== userId) {
    return NextResponse.json({ error: 'not your booking' }, { status: 403 });
  }
  // Cash bookings settle in person — there's nothing to collect online and no escrow to hold.
  if (booking.payment_method === 'cod') {
    return NextResponse.json({ error: 'cash bookings are paid in person, not online' }, { status: 409 });
  }
  // Guard state: live booking, nothing captured yet.
  if (!PAYABLE_STATUSES.includes(booking.status)) {
    return NextResponse.json({ error: `booking is not payable in status '${booking.status}'` }, { status: 409 });
  }
  if (booking.payment_status !== 'pending') {
    return NextResponse.json({ error: `already paid or in progress (payment_status '${booking.payment_status}')` }, { status: 409 });
  }

  // Amount comes from the DB, in rupees → paise. Never trust a client-supplied amount.
  const rupees = Number(booking.price_agreed ?? booking.total_amount ?? 0);
  if (!(rupees > 0)) {
    return NextResponse.json({ error: 'no amount agreed for this booking' }, { status: 409 });
  }
  const amountPaise = Math.round(rupees * 100);

  // Create the Razorpay order (test mode). receipt is our booking id (<=40 chars).
  let orderId: string;
  try {
    const order = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: bookingId,
      notes: { booking_id: bookingId },
    });
    orderId = order.id;
  } catch (e) {
    console.error('razorpay order create failed:', e);
    return NextResponse.json({ error: 'could not create order' }, { status: 502 });
  }

  // Record the order in our ledger (server-only write). amount is stored in PAISE to match
  // what the webhook receives from Razorpay.
  const { error: insErr } = await admin.from('payment_transactions').insert({
    booking_id: bookingId,
    razorpay_order_id: orderId,
    amount: amountPaise,
    currency: 'INR',
    status: 'created',
  });
  if (insErr) {
    console.error('payment_transactions insert failed:', insErr.message);
    return NextResponse.json({ error: 'could not record order' }, { status: 500 });
  }

  return NextResponse.json({
    orderId,
    amount: amountPaise,
    currency: 'INR',
    keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
  });
}
