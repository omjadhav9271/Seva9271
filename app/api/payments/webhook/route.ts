/* POST /api/payments/webhook — Razorpay → us. THE SOURCE OF TRUTH FOR MONEY.
 *
 * No user auth. Trust is established by verifying X-Razorpay-Signature against the RAW body
 * with RAZORPAY_WEBHOOK_SECRET (HMAC-SHA256). A bad/absent signature is rejected with 400.
 *
 * This is the ONLY code path that sets bookings.payment_status = 'held'. It is idempotent:
 * Razorpay retries webhooks, so re-delivering the same payment.captured must change nothing.
 * We flip the ledger row created→captured with a conditional (WHERE status='created') update
 * so concurrent/duplicate deliveries can't double-apply. We also verify the captured amount
 * matches the amount we recorded when the order was created. */

import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSupabaseAdmin } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function signatureMatches(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // timingSafeEqual throws if lengths differ; guard first to keep the comparison constant-time
  // only over equal-length inputs (a length mismatch is already a non-match).
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('webhook: RAZORPAY_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'webhook not configured' }, { status: 500 });
  }

  // Read the RAW body BEFORE parsing — the signature is computed over the exact bytes.
  const rawBody = await req.text();
  const signature = req.headers.get('x-razorpay-signature');
  if (!signatureMatches(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event: {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; amount?: number } };
      order?: { entity?: { id?: string; amount?: number; amount_paid?: number } };
    };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // We only settle on capture. Acknowledge everything else so Razorpay stops retrying.
  if (event.event !== 'payment.captured' && event.event !== 'order.paid') {
    return NextResponse.json({ ok: true, ignored: event.event ?? 'unknown' });
  }

  const payEntity = event.payload?.payment?.entity;
  const orderEntity = event.payload?.order?.entity;
  const orderId = payEntity?.order_id ?? orderEntity?.id ?? null;
  const paymentId = payEntity?.id ?? null;
  const amountPaise = payEntity?.amount ?? orderEntity?.amount_paid ?? orderEntity?.amount ?? null;

  if (!orderId) {
    return NextResponse.json({ error: 'no order id in payload' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // Find the ledger row we created for this order.
  const { data: tx, error: txErr } = await admin
    .from('payment_transactions')
    .select('id, booking_id, amount, status')
    .eq('razorpay_order_id', orderId)
    .maybeSingle();
  if (txErr) {
    return NextResponse.json({ error: 'ledger lookup failed' }, { status: 500 });
  }
  if (!tx) {
    // An order we didn't create (or a stale event). Acknowledge so retries stop; do nothing.
    return NextResponse.json({ ok: true, note: 'no matching order' });
  }

  // Idempotent: already captured (or released/refunded) → nothing to do.
  if (tx.status !== 'created') {
    return NextResponse.json({ ok: true, idempotent: true, status: tx.status });
  }

  // Verify the captured amount equals what we recorded at order time (both in paise).
  if (amountPaise == null || Number(tx.amount) !== Number(amountPaise)) {
    console.error(`webhook amount mismatch for order ${orderId}: recorded ${tx.amount}, captured ${amountPaise}`);
    return NextResponse.json({ error: 'amount mismatch' }, { status: 400 });
  }

  // Atomically claim the capture: only the delivery that flips created→captured proceeds to
  // mark the booking held. A duplicate delivery updates 0 rows and no-ops.
  const { data: claimed, error: claimErr } = await admin
    .from('payment_transactions')
    .update({ status: 'captured', razorpay_payment_id: paymentId, updated_at: new Date().toISOString() })
    .eq('id', tx.id)
    .eq('status', 'created')
    .select('id, booking_id')
    .maybeSingle();
  if (claimErr) {
    return NextResponse.json({ error: 'ledger update failed' }, { status: 500 });
  }
  if (!claimed) {
    // Lost the race to a concurrent delivery — the other one is marking it held. Idempotent.
    return NextResponse.json({ ok: true, idempotent: true });
  }

  // The only place payment_status becomes 'held'. Return provider_id so we can address the
  // "payment secured" notification below without a second booking lookup.
  const { data: heldBooking, error: bookErr } = await admin
    .from('bookings')
    .update({ payment_status: 'held', updated_at: new Date().toISOString() })
    .eq('id', claimed.booking_id)
    .select('id, provider_id')
    .maybeSingle();
  if (bookErr) {
    console.error('failed to mark booking held:', bookErr.message);
    return NextResponse.json({ error: 'could not mark held' }, { status: 500 });
  }

  // Tell the PROVIDER their funds are secured — appears live via the realtime bell (the
  // notifications table is in the realtime publication, filtered by user_id). Best-effort: a
  // failed bell insert must NOT fail the webhook. The money truth is already committed, and a
  // Razorpay retry would only no-op on the now-'captured' ledger row (status != 'created')
  // without ever reaching this insert again — so we log and move on rather than return 500.
  if (heldBooking?.provider_id) {
    const { data: sp, error: spErr } = await admin
      .from('service_providers')
      .select('user_id')
      .eq('id', heldBooking.provider_id)
      .maybeSingle();
    if (spErr) {
      console.error('held notification: provider lookup failed:', spErr.message);
    } else if (sp?.user_id) {
      const { error: notifErr } = await admin.from('notifications').insert({
        user_id: sp.user_id,
        title: 'Payment received',
        message: 'Payment is secured — you can start travel now.',
        type: 'success',
        link: `/bookings/${claimed.booking_id}`,
      });
      if (notifErr) console.error('held notification insert failed:', notifErr.message);
    }
  }

  return NextResponse.json({ ok: true, held: true, bookingId: claimed.booking_id });
}
