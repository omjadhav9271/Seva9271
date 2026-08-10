'use client';

/* The evidence bundle — the page where "he never arrived" gets settled by timestamps instead of
   shouting. Everything here exists because the booking ran on-platform: the state timeline, the
   chat thread, the ledger, both reputations. Admin-only (RLS re-checks every read). */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, Scale, MessageSquare, CreditCard, ShieldCheck, Clock, Phone, Mail, Paperclip, FileText } from 'lucide-react';
import { supabase, type Dispute, type DisputeOutcome, type Message, type DisputeEvidence } from '@/lib/supabase';
import { useAdminGuard, REASON_LABELS, OUTCOME_LABELS, adminDisputeRefund, fetchDisputeContacts, type DisputeContacts } from '@/lib/admin';
import { shortId, inr } from '@/lib/disputes';
import { listEvidence, evidenceSignedUrl } from '@/lib/dispute-evidence';
import { fetchServiceLocation } from '@/lib/bookings';
import DisputeSettlement from '@/components/dispute-settlement';
import { toast } from 'sonner';

type BookingBundle = {
  id: string;
  customer_id: string;
  provider_id: string;
  status: string;
  payment_status: string;
  payment_method: string;
  price_agreed: number | null;
  price_charged: number | null;
  total_amount: number;
  scheduled_date: string | null;
  scheduled_time: string | null;
  address: string | null;
  notes: string | null;
  created_at: string;
  service_categories: { name: string } | null;
  service_providers: {
    business_name: string | null;
    rating: number;
    reputation_score: number;
    service_categories: { name: string } | null;
  } | null;
};

type EventRow = {
  id: string;
  from_status: string | null;
  to_status: string;
  actor_role: string | null;
  meta: Record<string, unknown>;
  created_at: string;
};

type PayTx = {
  id: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  amount: number; // paise
  status: string;
  platform_fee: number | null;
  provider_amount: number | null;
  created_at: string;
};

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Platform fee — mirrors platform_fee_pct() in the DB (the RPC does the authoritative math).
const FEE_PCT = 0.01;

// What a chosen outcome will do to the escrowed amount, mirrored from resolve_dispute so the admin
// sees the split before committing. `refund` = ₹ back to the customer (only meaningful for partial).
type Split = { customerRefund: number; providerPayout: number; platformFee: number; valid: boolean; hint?: string };
function moneySplit(outcome: DisputeOutcome | '', amount: number, refund: number): Split | null {
  if (!outcome || !amount) return null;
  if (outcome === 'favor_customer') return { customerRefund: amount, providerPayout: 0, platformFee: 0, valid: true };
  if (outcome === 'favor_provider' || outcome === 'no_fault') {
    const fee = Math.round(amount * FEE_PCT * 100) / 100;
    return { customerRefund: 0, providerPayout: amount - fee, platformFee: fee, valid: true };
  }
  // partial: the admin controls the split with a single number (refund to the customer)
  if (!refund || Number.isNaN(refund) || refund <= 0 || refund >= amount) {
    return { customerRefund: 0, providerPayout: 0, platformFee: 0, valid: false,
      hint: `Enter a refund between ₹1 and ${inr(amount - 1)}.` };
  }
  const remainder = amount - refund;
  const fee = Math.round(remainder * FEE_PCT * 100) / 100;
  return { customerRefund: refund, providerPayout: remainder - fee, platformFee: fee, valid: true };
}

// Suggest the fault that usually pairs with an outcome (admin can still override).
const suggestFault = (o: DisputeOutcome | ''): 'customer' | 'provider' | 'none' | '' =>
  o === 'favor_customer' ? 'provider'
    : o === 'favor_provider' ? 'customer'
    : (o === 'partial' || o === 'no_fault') ? 'none'
    : '';

export default function AdminDisputeDetailPage({ params }: { params: { id: string } }) {
  const guard = useAdminGuard();
  const [dispute, setDispute] = useState<Dispute | null>(null);
  const [booking, setBooking] = useState<BookingBundle | null>(null);
  const [customer, setCustomer] = useState<{ full_name: string | null; reputation_score: number } | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [payTx, setPayTx] = useState<PayTx[]>([]);
  const [contacts, setContacts] = useState<DisputeContacts | null>(null);
  const [evidence, setEvidence] = useState<DisputeEvidence[]>([]);
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  // resolution panel
  const [outcome, setOutcome] = useState<DisputeOutcome | ''>('');
  const [fault, setFault] = useState<'customer' | 'provider' | 'none' | ''>('');
  const [notes, setNotes] = useState('');
  const [refundAmt, setRefundAmt] = useState('');
  const [resolving, setResolving] = useState(false);

  const loadAll = useCallback(async () => {
    const { data: d, error: dErr } = await supabase.from('disputes').select('*').eq('id', params.id).maybeSingle();
    if (dErr) console.error('dispute load failed:', dErr.message);
    const disputeRow = (d as Dispute | null) ?? null;
    setDispute(disputeRow);
    if (!disputeRow) { setLoading(false); return; }

    const bookingId = disputeRow.booking_id;
    const [{ data: b }, { data: ev }, { data: msg }, { data: tx }] = await Promise.all([
      // `address` is deliberately absent: the service address lost its column grant in
      // 20260823120000 and selecting it here would fail the whole query with 42501. Admins are
      // still entitled to it for case handling — it comes from the definer RPC below.
      supabase.from('bookings')
        .select('id, customer_id, provider_id, status, payment_status, payment_method, price_agreed, price_charged, total_amount, scheduled_date, scheduled_time, notes, created_at, service_categories(name), service_providers(business_name, rating, reputation_score, service_categories(name))')
        .eq('id', bookingId).maybeSingle(),
      supabase.from('booking_events').select('*').eq('booking_id', bookingId).order('created_at', { ascending: true }),
      supabase.from('messages').select('*').eq('booking_id', bookingId).order('created_at', { ascending: true }),
      supabase.from('payment_transactions').select('*').eq('booking_id', bookingId).order('created_at', { ascending: true }),
    ]);
    const bookingRow = (b as unknown as BookingBundle | null) ?? null;
    if (bookingRow) {
      // booking_service_location() returns the full address to an admin at any status — the reveal
      // rule it enforces is about the PROVIDER, not about case handling.
      const loc = await fetchServiceLocation(bookingId);
      bookingRow.address = [loc?.address, loc?.pincode].filter(Boolean).join(', ') || null;
    }
    setBooking(bookingRow);
    setEvents((ev ?? []) as EventRow[]);
    setMessages((msg ?? []) as Message[]);
    setPayTx((tx ?? []) as PayTx[]);

    // Evidence bundle: the admin reads BOTH parties' files (RLS), signed for viewing.
    const ev2 = await listEvidence(disputeRow.id);
    setEvidence(ev2);
    const urlEntries = await Promise.all(
      ev2.map(async (r) => [r.file_path, (await evidenceSignedUrl(r.file_path)) ?? ''] as const),
    );
    setEvidenceUrls(Object.fromEntries(urlEntries));

    // Contact details for both parties (admin-only server route).
    const c = await fetchDisputeContacts(params.id);
    setContacts('data' in c ? c.data : null);

    if (bookingRow) {
      // admin_read_profiles (Step 8) opens this read; the customer's reputation is part of the case
      const { data: prof } = await supabase.from('profiles')
        .select('full_name, reputation_score').eq('id', bookingRow.customer_id).maybeSingle();
      setCustomer((prof as typeof customer) ?? null);
    }
    setLoading(false);
  }, [params.id]);

  useEffect(() => {
    if (guard !== 'ok') return;
    void loadAll();
  }, [guard, loadAll]);

  const handleResolve = async () => {
    if (!dispute || !booking || !outcome || !fault || resolving) return;
    const needsAmount = outcome === 'partial';
    const amountNum = Number(refundAmt);
    if (needsAmount && (!refundAmt || Number.isNaN(amountNum) || amountNum <= 0)) {
      toast.error('Enter the partial refund amount (₹).');
      return;
    }
    setResolving(true);

    // 1) Record the decision: money intent + wallet effects + status exits + reputation.
    const { error } = await supabase.rpc('resolve_dispute', {
      p_dispute_id: dispute.id,
      p_outcome: outcome,
      p_fault: fault,
      p_notes: notes.trim() || null,
      p_refund_amount: needsAmount ? amountNum : null,
    });
    if (error) {
      setResolving(false);
      toast.error(error.message);
      return;
    }
    toast.success('Dispute resolved and recorded.');

    // 2) The real gateway refund, when the outcome owes the customer money and a Razorpay
    //    payment exists (wallet effects were already handled by the RPC).
    if (outcome === 'favor_customer' || outcome === 'partial') {
      const refundable = payTx.find((t) => t.razorpay_payment_id && ['captured', 'released'].includes(t.status));
      if (refundable) {
        const res = await adminDisputeRefund(booking.id, needsAmount ? amountNum : undefined);
        if ('error' in res) toast.error(`Gateway refund: ${res.error}`);
        else toast.success('Gateway refund issued to the customer.');
      } else {
        toast.info('No gateway payment to refund (money never captured).');
      }
    }

    setResolving(false);
    void loadAll();
  };

  // Pick an outcome → pre-fill the matching fault + reset the partial amount when it no longer applies.
  const onOutcomeChange = (o: DisputeOutcome | '') => {
    setOutcome(o);
    setFault(suggestFault(o));
    if (o !== 'partial') setRefundAmt('');
  };

  if (guard !== 'ok') {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Checking access…</div>;
  }
  if (loading) {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Loading evidence…</div>;
  }
  if (!dispute) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20 flex flex-col items-center justify-center gap-4">
        <p className="text-gray-400">Dispute not found</p>
        <Link href="/admin/disputes" className="text-[#FF9933] text-sm">← Back to queue</Link>
      </div>
    );
  }

  const amount = booking ? (booking.price_charged ?? booking.price_agreed ?? booking.total_amount) : 0;
  const split = moneySplit(outcome, Number(amount), Number(refundAmt));
  const providerName = booking?.service_providers?.business_name ?? 'Provider';
  const customerName = customer?.full_name ?? 'Customer';
  const nameFor = (senderId: string) => (senderId === booking?.customer_id ? customerName : providerName);
  const raiserName = dispute.raiser_role === 'customer' ? customerName : providerName;
  const accusedRole: 'customer' | 'provider' = dispute.raiser_role === 'customer' ? 'provider' : 'customer';
  const accusedName = accusedRole === 'customer' ? customerName : providerName;
  const categoryName = booking?.service_categories?.name
    ?? booking?.service_providers?.service_categories?.name ?? 'Service';

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/admin/disputes" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-6">
          <ArrowLeft className="w-4 h-4" />Back to queue
        </Link>

        {/* Case header */}
        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 mb-6">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Scale className="w-5 h-5 text-[#FF9933]" />
                <h1 className="text-xl font-black text-white">{REASON_LABELS[dispute.reason]}</h1>
                <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium capitalize ${
                  dispute.status === 'resolved' ? 'bg-[#138808]/10 text-[#138808]' : 'bg-orange-900/20 text-orange-400'
                }`}>
                  {dispute.status === 'under_review' ? 'under review' : dispute.status}
                </span>
              </div>
              {/* WHO, against WHOM, about WHAT — an admin arriving from a notification should
                  not have to cross-reference three cards to learn whose case this is. */}
              <p className="text-sm text-gray-400">
                Raised by <span className="text-white">{raiserName}</span> ({dispute.raiser_role})
                <span className="font-mono text-xs text-gray-600"> {shortId(dispute.raised_by)}</span>
                {' · '}against <span className="text-white">{accusedName}</span> ({accusedRole})
                {' · '}{fmtTime(dispute.created_at)}
              </p>
              <p className="text-sm text-gray-400 mt-1">
                {categoryName} · booking <span className="font-mono text-xs">#{dispute.booking_id.slice(0, 8)}</span>
                {' · '}case <span className="font-mono text-xs">{shortId(dispute.id)}</span>
                {' · '}scheduled {booking?.scheduled_date ?? '—'} {booking?.scheduled_time?.slice(0, 5) ?? ''}
              </p>
              {booking?.notes?.trim() && (
                <p className="text-xs text-gray-500 mt-1">Work booked: {booking.notes.trim()}</p>
              )}
              <p className="text-[11px] text-gray-500 mt-3 mb-1">
                What the {dispute.raiser_role} reported
              </p>
              {dispute.description?.trim() ? (
                <p className="text-sm text-gray-300 bg-[#1e1e1e] rounded-xl p-3 whitespace-pre-wrap">&ldquo;{dispute.description.trim()}&rdquo;</p>
              ) : (
                <p className="text-sm text-gray-500 italic">No description filed — only the reason above.</p>
              )}
            </div>
            {dispute.status === 'resolved' && (
              <div className="bg-[#138808]/10 border border-[#138808]/20 rounded-xl p-3 text-sm">
                <p className="text-[#138808] font-semibold">{dispute.outcome ? OUTCOME_LABELS[dispute.outcome] : 'Resolved'}</p>
                <p className="text-xs text-gray-400 mt-1">
                  Fault: {dispute.fault_party && dispute.fault_party !== 'none'
                    ? `${dispute.fault_party === 'customer' ? customerName : providerName} (${dispute.fault_party})`
                    : 'no one'}
                  {dispute.refund_amount != null && Number(dispute.refund_amount) > 0 && <> · refund ₹{Number(dispute.refund_amount).toLocaleString('en-IN')}</>}
                </p>
                {dispute.resolved_at && <p className="text-xs text-gray-500 mt-1">{fmtTime(dispute.resolved_at)}</p>}
                {dispute.resolution_notes && <p className="text-xs text-gray-400 mt-1">{dispute.resolution_notes}</p>}
              </div>
            )}
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          <div className="space-y-6">
            {/* Booking + money summary */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
              <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-4 flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-[#FF9933]" />Booking &amp; money
              </h2>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-500 text-xs">Service</span><p className="text-white">{booking?.service_providers?.service_categories?.name ?? '—'}</p></div>
                <div><span className="text-gray-500 text-xs">Status</span><p className="text-white capitalize">{booking?.status ?? '—'}</p></div>
                <div><span className="text-gray-500 text-xs">Agreed</span><p className="text-white">₹{Number(booking?.price_agreed ?? booking?.total_amount ?? 0).toLocaleString('en-IN')}</p></div>
                <div><span className="text-gray-500 text-xs">Charged</span><p className="text-[#FF9933] font-bold">{booking?.price_charged != null ? `₹${Number(booking.price_charged).toLocaleString('en-IN')}` : '— (not confirmed)'}</p></div>
                <div><span className="text-gray-500 text-xs">Payment</span><p className="text-white capitalize">{booking?.payment_method} · {booking?.payment_status}</p></div>
                <div><span className="text-gray-500 text-xs">Scheduled</span><p className="text-white">{booking?.scheduled_date ?? '—'} {booking?.scheduled_time?.slice(0, 5) ?? ''}</p></div>
              </div>
              {payTx.length > 0 && (
                <div className="mt-4 pt-4 border-t border-[#222] space-y-2">
                  {payTx.map((t) => (
                    <div key={t.id} className="flex items-center justify-between text-xs">
                      <span className="text-gray-400 font-mono">{t.razorpay_payment_id ?? t.razorpay_order_id}</span>
                      <span className="text-gray-300">₹{(Number(t.amount) / 100).toLocaleString('en-IN')} · <span className="capitalize">{t.status}</span>
                        {t.provider_amount != null && <> · payout ₹{Number(t.provider_amount).toLocaleString('en-IN')}</>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Both parties + reputations */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
              <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-4 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-[#5da9ff]" />Parties &amp; trust
              </h2>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="bg-[#1e1e1e] rounded-xl p-3">
                  <p className="text-xs text-gray-500 mb-1">Customer</p>
                  <p className="text-white font-semibold">{customerName}</p>
                  <p className="text-xs text-[#5da9ff] mt-1">Trust {Number(customer?.reputation_score ?? 0).toFixed(1)}</p>
                </div>
                <div className="bg-[#1e1e1e] rounded-xl p-3">
                  <p className="text-xs text-gray-500 mb-1">Provider</p>
                  <p className="text-white font-semibold">{providerName}</p>
                  <p className="text-xs text-[#5da9ff] mt-1">
                    Trust {Number(booking?.service_providers?.reputation_score ?? 0).toFixed(1)}
                    <span className="text-gray-500"> · {Number(booking?.service_providers?.rating ?? 0).toFixed(1)}★</span>
                  </p>
                </div>
              </div>
            </div>

            {/* Contact parties — admin-only, so you can verify facts directly with either side.
                Never shown to the other party. Provider business phone/email come from the
                server route (they're column-locked / in auth.users). */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
              <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-4 flex items-center gap-2">
                <Phone className="w-4 h-4 text-[#138808]" />Contact parties
              </h2>
              {contacts ? (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {([['Customer', contacts.customer], ['Provider', contacts.provider]] as const).map(([label, c]) => (
                    <div key={label} className="bg-[#1e1e1e] rounded-xl p-3 space-y-1.5">
                      <p className="text-xs text-gray-500">
                        {label}
                        <span className="text-gray-600">
                          {' · '}{label.toLowerCase() === dispute.raiser_role ? 'raised this dispute' : 'responding party'}
                        </span>
                      </p>
                      <p className="text-white font-semibold truncate">{c.business_name || c.name || '—'}</p>
                      {c.business_name && c.name && <p className="text-xs text-gray-400 truncate">{c.name}</p>}
                      <p className="text-xs text-gray-400">Service: {categoryName}</p>
                      {c.phone ? (
                        <a href={`tel:${c.phone}`} className="flex items-center gap-1.5 text-xs text-[#5da9ff] hover:underline"><Phone className="w-3 h-3 flex-shrink-0" />{c.phone}</a>
                      ) : <p className="text-xs text-gray-600">no phone on file</p>}
                      {c.email ? (
                        <a href={`mailto:${c.email}`} className="flex items-center gap-1.5 text-xs text-[#5da9ff] hover:underline break-all"><Mail className="w-3 h-3 flex-shrink-0" />{c.email}</a>
                      ) : <p className="text-xs text-gray-600">no email on file</p>}
                      {c.address && <p className="text-xs text-gray-400">{c.address}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-500">Contact details unavailable.</p>
              )}
              <p className="text-[11px] text-gray-600 mt-3">
                Visible to admins only — never to the other party. Call or email either side to
                verify facts before assigning fault; fault is what moves a trust score.
              </p>
            </div>

            {/* Timeline — where "he never arrived" is settled by timestamps. */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
              <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-4 flex items-center gap-2">
                <Clock className="w-4 h-4 text-[#FF9933]" />Timeline
              </h2>
              {events.length === 0 ? (
                <p className="text-xs text-gray-500">No events recorded.</p>
              ) : (
                <div className="space-y-0">
                  {events.map((e, i) => (
                    <div key={e.id} className="flex gap-3 text-sm">
                      <div className="flex flex-col items-center">
                        <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${e.to_status === 'disputed' ? 'bg-orange-400' : 'bg-[#FF9933]'}`} />
                        {i < events.length - 1 && <div className="w-px flex-1 bg-[#2a2a2a] my-1" />}
                      </div>
                      <div className="pb-4 min-w-0">
                        <p className="text-white">
                          {e.from_status ? <span className="text-gray-500">{e.from_status} → </span> : null}
                          <span className={e.to_status === 'disputed' ? 'text-orange-400 font-semibold' : 'font-semibold'}>{e.to_status}</span>
                          <span className="text-gray-500"> · {e.actor_role ?? 'system'}</span>
                        </p>
                        <p className="text-xs text-gray-500">{fmtTime(e.created_at)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-6">
            {/* Resolution panel */}
            {dispute.status !== 'resolved' && (
              <div className="bg-[#161616] border border-[#FF9933]/30 rounded-2xl p-5">
                <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-1">Resolve</h2>
                <p className="text-xs text-gray-500 mb-4">
                  Outcome moves the money (₹{Number(amount).toLocaleString('en-IN')} at stake, currently {booking?.payment_status});
                  fault moves reputation — only the party found at fault takes the hit.
                </p>
                <div className="space-y-3">
                  <select value={outcome} onChange={(e) => onOutcomeChange(e.target.value as DisputeOutcome | '')}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#FF9933]">
                    <option value="">Outcome…</option>
                    {(Object.keys(OUTCOME_LABELS) as DisputeOutcome[]).map((o) => (
                      <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>
                    ))}
                  </select>

                  {/* Partial: one number controls the split — ₹ back to the customer; the rest goes to the provider. */}
                  {outcome === 'partial' && (
                    <input value={refundAmt} onChange={(e) => setRefundAmt(e.target.value)} type="number" min="1" max={Number(amount) - 1}
                      placeholder={`Refund to customer (₹) — between 1 and ${Number(amount) - 1}`}
                      className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#FF9933]" />
                  )}

                  {/* Live money preview — mirrors exactly what resolve_dispute will do with the escrow. */}
                  {split && (split.valid ? (
                    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-3 text-xs space-y-1">
                      <p className="text-gray-500 uppercase tracking-wide text-[10px] mb-1">This will move (of {inr(Number(amount))} held)</p>
                      <div className="flex justify-between"><span className="text-gray-400">Customer refunded</span><span className={split.customerRefund > 0 ? 'text-[#5da9ff] font-semibold' : 'text-gray-500'}>{inr(split.customerRefund)}</span></div>
                      <div className="flex justify-between"><span className="text-gray-400">Provider receives</span><span className={split.providerPayout > 0 ? 'text-[#138808] font-semibold' : 'text-gray-500'}>{inr(split.providerPayout)}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Platform fee (1%)</span><span className="text-gray-500">{inr(split.platformFee)}</span></div>
                      {booking?.payment_status === 'released' && split.customerRefund > 0 && (
                        <p className="text-[11px] text-amber-400/80 pt-1">Escrow was already paid out — the refund is clawed back from the provider&apos;s wallet (may go negative).</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-amber-400">{split.hint}</p>
                  ))}

                  <select value={fault} onChange={(e) => setFault(e.target.value as typeof fault)}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#FF9933]">
                    <option value="">At fault…</option>
                    <option value="provider">Provider</option>
                    <option value="customer">Customer</option>
                    <option value="none">No one (no fault / split)</option>
                  </select>
                  <p className="text-[11px] text-gray-600 -mt-1">Fault drives reputation — only the party at fault takes a hit. Suggested from the outcome; change if needed.</p>

                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
                    placeholder="Resolution notes (visible to both parties)"
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#FF9933] resize-none" />
                  <button onClick={handleResolve} disabled={resolving || !outcome || !fault || (outcome === 'partial' && !split?.valid)}
                    className="w-full py-3 rounded-xl text-sm font-semibold bg-[#FF9933] text-white hover:bg-[#e8872e] transition-colors disabled:opacity-50">
                    {resolving ? 'Resolving…' : 'Resolve dispute'}
                  </button>
                </div>
              </div>
            )}

            {/* Once resolved, the panel above is replaced by the arithmetic it produced — the
                SAME card both parties are shown, so a "where did my money go?" call can be
                answered from the exact screen the caller is looking at. */}
            {dispute.status === 'resolved' && (
              <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
                <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-1">Settled</h2>
                <p className="text-xs text-gray-500">
                  Read back from the ledger and the dispute row — not recomputed from the fee.
                </p>
                <DisputeSettlement dispute={dispute} amountFallback={Number(amount)} viewerRole={null} />
              </div>
            )}

            {/* Evidence — files BOTH parties attached (Step 8.5), grouped by side. This is where a
                photo of undone work or a recording settles what the timeline can't. */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
              <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-4 flex items-center gap-2">
                <Paperclip className="w-4 h-4 text-orange-400" />Evidence
                <span className="text-gray-500 font-normal normal-case">({evidence.length} file{evidence.length === 1 ? '' : 's'})</span>
              </h2>
              {evidence.length === 0 ? (
                <p className="text-xs text-gray-500">No evidence submitted by either party yet — you may want to wait before assigning fault.</p>
              ) : (
                <div className="space-y-4">
                  {(['customer', 'provider'] as const).map((r) => {
                    const rows = evidence.filter((e) => e.uploader_role === r);
                    return (
                      <div key={r}>
                        <p className="text-xs text-gray-500 mb-2 capitalize">
                          From the {r} <span className="text-gray-600">· {rows.length} file{rows.length === 1 ? '' : 's'}</span>
                        </p>
                        {rows.length === 0 ? (
                          <p className="text-[11px] text-gray-600 italic">nothing from the {r} yet</p>
                        ) : (
                          <div className="grid grid-cols-2 gap-2">
                            {rows.map((e) => {
                              const url = evidenceUrls[e.file_path];
                              return (
                                <div key={e.id} className="bg-[#1e1e1e] rounded-xl p-2">
                                  {e.kind === 'image' && url ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="evidence" className="w-full h-24 rounded-lg object-cover" /></a>
                                  ) : e.kind === 'video' && url ? (
                                    <video src={url} controls className="w-full h-24 rounded-lg bg-black" />
                                  ) : e.kind === 'audio' && url ? (
                                    <audio src={url} controls className="w-full mt-8" />
                                  ) : (
                                    <a href={url || '#'} target="_blank" rel="noreferrer" className="flex flex-col items-center justify-center gap-1 text-xs text-[#5da9ff] h-24 hover:underline"><FileText className="w-5 h-5" />Open file</a>
                                  )}
                                  {e.caption && <p className="text-[11px] text-gray-400 mt-1 truncate" title={e.caption}>{e.caption}</p>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Chat evidence */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
              <h2 className="font-bold text-white text-sm uppercase tracking-wide mb-4 flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-[#FF9933]" />Chat thread
                <span className="text-gray-500 font-normal normal-case">({messages.length} messages, immutable)</span>
              </h2>
              {messages.length === 0 ? (
                <p className="text-xs text-gray-500">No messages on this booking.</p>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                  {messages.map((m) => (
                    <div key={m.id} className="text-sm">
                      <p className="text-xs text-gray-500 mb-0.5">
                        <span className={m.sender_id === booking?.customer_id ? 'text-[#5da9ff]' : 'text-[#FF9933]'}>{nameFor(m.sender_id)}</span>
                        {' · '}{fmtTime(m.created_at)}
                      </p>
                      <p className="text-gray-200 bg-[#1e1e1e] rounded-lg px-3 py-2 inline-block">{m.body}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
