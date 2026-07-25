/* POST /api/payments/refund — return escrowed funds to the customer.
 *
 * Auth: the booking's customer, or an admin.
 * Two modes:
 *  1. Customer/admin refund of HELD money (pre-Step-8 behaviour, unchanged): only a 'held'
 *     booking, full amount, ledger row captured→refunded, booking → 'refunded'.
 *  2. Admin dispute-resolution refund (`disputeResolution: true`, Step 8): resolve_dispute has
 *     already set bookings.payment_status='refunded', so the held-only guard can't serve these —
 *     eligibility keys on the RESOLVED dispute (favor_customer/partial) + the ledger row still
 *     holding a refundable gateway payment ('captured' or 'released'). Supports partial amounts
 *     (rupees in, paise to Razorpay). Idempotent via the ledger row's refunded state. */

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

  let body: { bookingId?: string; amount?: number; disputeResolution?: boolean };
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

  // Authorize: the booking's customer or an admin (role is server-controlled).
  const { data: prof } = await admin.from('profiles').select('role').eq('id', userId).maybeSingle();
  const isAdmin = prof?.role === 'admin';
  if (booking.customer_id !== userId && !isAdmin) {
    return NextResponse.json({ error: 'not authorized to refund this booking' }, { status: 403 });
  }

  // ── Mode 2: admin dispute-resolution refund (Step 8) ──────────────────────────────────────
  if (body.disputeResolution) {
    if (!isAdmin) {
      return NextResponse.json({ error: 'dispute refunds are admin-only' }, { status: 403 });
    }
    // Eligibility = a resolved dispute that owes the customer money.
    const { data: dis } = await admin
      .from('disputes')
      .select('id, outcome, refund_amount')
      .eq('booking_id', bookingId)
      .eq('status', 'resolved')
      .in('outcome', ['favor_customer', 'partial'])
      .order('resolved_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!dis) {
      return NextResponse.json({ error: 'no resolved dispute owing a refund on this booking' }, { status: 409 });
    }
    // The gateway payment: captured (was held) or released (was paid out — RPC clawed back).
    const { data: dtx } = await admin
      .from('payment_transactions')
      .select('id, razorpay_payment_id, amount, status')
      .eq('booking_id', bookingId)
      .not('razorpay_payment_id', 'is', null)
      .in('status', ['captured', 'released', 'refunded'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!dtx || !dtx.razorpay_payment_id) {
      return NextResponse.json({ error: 'no gateway payment to refund' }, { status: 409 });
    }
    if (dtx.status === 'refunded') {
      return NextResponse.json({ ok: true, idempotent: true, refunded: true });
    }
    // Amount: request (rupees) → dispute's recorded refund_amount → full capture. Never above
    // what was captured; tx.amount is stored in paise.
    const rupees = Number(body.amount ?? dis.refund_amount ?? 0);
    const amountPaise = rupees > 0
      ? Math.min(Math.round(rupees * 100), Number(dtx.amount))
      : Number(dtx.amount);
    try {
      await getRazorpay().payments.refund(dtx.razorpay_payment_id, { amount: amountPaise });
    } catch (e) {
      console.error('razorpay dispute refund failed:', e);
      return NextResponse.json({ error: 'refund failed at gateway' }, { status: 502 });
    }
    await admin
      .from('payment_transactions')
      .update({ status: 'refunded', updated_at: new Date().toISOString() })
      .eq('id', dtx.id)
      .neq('status', 'refunded'); // idempotency guard
    return NextResponse.json({ ok: true, refunded: true, bookingId, amountPaise });
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
