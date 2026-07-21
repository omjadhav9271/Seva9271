/* POST /api/payments/refund — return escrowed funds to the customer.
 *
 * Auth: the booking's customer, or an admin. (Full dispute/cancel policy is Step 8; here we
 * allow either party-of-record to trigger a refund of money that is still held.)
 * Only a 'held' booking can be refunded. We call the Razorpay refund API on the captured
 * payment, then mark the ledger row + booking 'refunded'. Idempotent: a second call on an
 * already-refunded booking is a 200 no-op. */

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getUserIdFromRequest } from '@/lib/api-auth';
import { getRazorpay } from '@/lib/razorpay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const { data: booking, error: bErr } = await admin
    .from('bookings')
    .select('id, customer_id, payment_status')
    .eq('id', bookingId)
    .maybeSingle();
  if (bErr) {
    return NextResponse.json({ error: 'lookup failed' }, { status: 500 });
  }
  if (!booking) {
    return NextResponse.json({ error: 'booking not found' }, { status: 404 });
  }

  // Authorize: the booking's customer or an admin.
  let isAdmin = false;
  if (booking.customer_id !== userId) {
    const { data: prof } = await admin.from('profiles').select('role').eq('id', userId).maybeSingle();
    isAdmin = prof?.role === 'admin';
    if (!isAdmin) {
      return NextResponse.json({ error: 'not authorized to refund this booking' }, { status: 403 });
    }
  }

  // Idempotent: already refunded → success no-op.
  if (booking.payment_status === 'refunded') {
    return NextResponse.json({ ok: true, idempotent: true, payment_status: 'refunded' });
  }
  // Only money still held can be refunded here (released funds are a wallet matter, not escrow).
  if (booking.payment_status !== 'held') {
    return NextResponse.json({ error: `cannot refund in payment_status '${booking.payment_status}'` }, { status: 409 });
  }

  // Find the captured ledger row.
  const { data: tx, error: txErr } = await admin
    .from('payment_transactions')
    .select('id, razorpay_payment_id, amount, status')
    .eq('booking_id', bookingId)
    .eq('status', 'captured')
    .maybeSingle();
  if (txErr) {
    return NextResponse.json({ error: 'ledger lookup failed' }, { status: 500 });
  }
  if (!tx || !tx.razorpay_payment_id) {
    return NextResponse.json({ error: 'no captured payment to refund' }, { status: 409 });
  }

  // Ask Razorpay to refund the captured payment (amount in paise).
  try {
    await getRazorpay().payments.refund(tx.razorpay_payment_id, { amount: Number(tx.amount) });
  } catch (e) {
    console.error('razorpay refund failed:', e);
    return NextResponse.json({ error: 'refund failed at gateway' }, { status: 502 });
  }

  // Mark the ledger row refunded (only if still captured — idempotency guard), then the booking.
  const { error: txUpdErr } = await admin
    .from('payment_transactions')
    .update({ status: 'refunded', updated_at: new Date().toISOString() })
    .eq('id', tx.id)
    .eq('status', 'captured');
  if (txUpdErr) {
    return NextResponse.json({ error: 'ledger update failed' }, { status: 500 });
  }

  const { error: bookUpdErr } = await admin
    .from('bookings')
    .update({ payment_status: 'refunded', updated_at: new Date().toISOString() })
    .eq('id', bookingId);
  if (bookUpdErr) {
    return NextResponse.json({ error: 'could not mark refunded' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, refunded: true, bookingId });
}
