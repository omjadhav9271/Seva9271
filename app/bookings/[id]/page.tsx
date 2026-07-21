'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Calendar, Clock, MapPin, AlertCircle, CheckCircle, XCircle, Star, CreditCard, Shield, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import BookingChat from '@/components/booking-chat';
import {
  type BookingRow, type BookingStatus, type PaymentStatus, type Role,
  BOOKING_SELECT, statusConfig, paymentStatusConfig, actionsFor, runTransition,
  createPaymentOrder, ownsProviderSide, formatTime,
} from '@/lib/bookings';
import { toast } from 'sonner';

// Razorpay Checkout injects window.Razorpay once its script loads.
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

// Load the hosted Checkout script on demand (idempotent). We never bundle it — it must be the
// live script from Razorpay so payments are handled on their PCI-compliant surface, not ours.
function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(false);
    if (window.Razorpay) return resolve(true);
    const src = 'https://checkout.razorpay.com/v1/checkout.js';
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(true));
      existing.addEventListener('error', () => resolve(false));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

const PAYABLE_STATUSES: BookingStatus[] = ['accepted', 'en_route', 'arrived', 'in_progress'];

export default function BookingDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { user, loading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const [booking, setBooking] = useState<BookingRow | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [paying, setPaying] = useState(false);

  // Message notifications link here with ?tab=chat; status notifications land at the top so
  // the action buttons are what you see first.
  const wantChat = searchParams.get('tab') === 'chat';
  const chatRef = useRef<HTMLDivElement>(null);
  const didScroll = useRef(false);
  const pollAbort = useRef(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    let active = true;
    (async () => {
      // RLS returns this row only to the two booking parties; anyone else gets null.
      const { data, error } = await supabase
        .from('bookings')
        .select(BOOKING_SELECT)
        .eq('id', id)
        .maybeSingle();
      if (!active) return;
      if (error) console.error('Failed to load booking:', error.message);
      const row = (data as unknown as BookingRow) ?? null;
      setBooking(row);

      // Which side is the viewer on? Customer takes precedence; otherwise they're the
      // provider iff they own this booking's provider row.
      if (row) {
        if (row.customer_id === user.id) {
          setRole('customer');
        } else if (await ownsProviderSide(row.provider_id, user.id)) {
          if (active) setRole('provider');
        }
      }
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [id, user, authLoading]);

  // Scroll the chat into view once, after the booking has rendered.
  useEffect(() => {
    if (loading || !booking || !wantChat || didScroll.current) return;
    didScroll.current = true;
    chatRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loading, booking, wantChat]);

  // Re-read the booking (status + payment_status) from the DB. Called after Checkout closes:
  // the webhook — not the Checkout callback — is what flips payment_status to 'held', so we
  // simply refetch and let the badge catch up once that server-side event lands.
  const refetchBooking = useCallback(async () => {
    const { data } = await supabase
      .from('bookings')
      .select(BOOKING_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (data) setBooking(data as unknown as BookingRow);
  }, [id]);

  // Stop any in-flight payment poll if the page unmounts.
  useEffect(() => () => { pollAbort.current = true; }, []);

  // After Checkout closes on success, the webhook flips payment_status to 'held' server-side a
  // few seconds later — but `bookings` isn't in the realtime publication, so a single refetch
  // races (and usually loses to) the webhook. Poll briefly until the money state leaves
  // 'pending' so the badge updates without a manual reload. Bounded (~30s) so a webhook that
  // never arrives (e.g. no tunnel in local dev) just stops instead of looping forever.
  const pollUntilHeld = useCallback(async () => {
    pollAbort.current = false;
    for (let i = 0; i < 15 && !pollAbort.current; i++) {
      const { data } = await supabase
        .from('bookings').select(BOOKING_SELECT).eq('id', id).maybeSingle();
      const row = (data as unknown as BookingRow) ?? null;
      if (row) setBooking(row);
      if (row && row.payment_status !== 'pending') {
        if (row.payment_status === 'held') toast.success('Payment secured — funds are held in escrow.');
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }, [id]);

  const handlePay = async () => {
    if (!booking || paying) return;
    setPaying(true);

    // Server creates the order with the amount read from the DB (never the client).
    const res = await createPaymentOrder(booking.id);
    if ('error' in res) {
      setPaying(false);
      toast.error(res.error);
      return;
    }

    const loaded = await loadRazorpayScript();
    if (!loaded || !window.Razorpay) {
      setPaying(false);
      toast.error('Could not load the payment gateway. Check your connection and try again.');
      return;
    }

    const rzp = new window.Razorpay({
      key: res.keyId,
      order_id: res.orderId,
      amount: res.amount,
      currency: res.currency,
      name: 'Seva',
      description: `Booking #${booking.id.slice(0, 8)}`,
      theme: { color: '#FF9933' },
      // Money state is NOT trusted from here — the webhook is the source of truth. On either
      // success or dismiss we just refetch; the badge flips to “In escrow” when the webhook lands.
      handler: () => {
        setPaying(false);
        toast.success('Payment received — confirming securely…');
        void pollUntilHeld();
      },
      modal: {
        ondismiss: () => {
          setPaying(false);
          void refetchBooking();
        },
      },
    });
    rzp.open();
  };

  const handleTransition = async (next: BookingStatus) => {
    if (!booking || acting) return;
    const prevStatus = booking.status;
    setActing(true);
    // Optimistic: advance the badge/actions immediately so the next step is available at once.
    setBooking((b) => (b ? { ...b, status: next } : b));

    const res = await runTransition(booking.id, next);
    setActing(false);

    if (res.error) {
      setBooking((b) => (b ? { ...b, status: prevStatus } : b)); // roll back on rejection
      toast.error(res.error);
      return;
    }

    // Reconcile with the authoritative row the RPC returns (price_charged, payment_status, …).
    setBooking((b) => (b ? {
      ...b,
      status: res.row?.status ?? next,
      price_charged: res.row?.price_charged ?? b.price_charged,
      payment_status: res.row?.payment_status ?? b.payment_status,
    } : b));
    toast.success(`Marked as “${statusConfig[next].label}”.`);

    // On confirm, the system settles behind the RPC (escrow release → 'released'/'paid', or a
    // cash booking → 'paid') via the release trigger. The RPC returns the pre-settlement row,
    // so refetch to show the settled status + payment badge.
    if (next === 'confirmed') void refetchBooking();
  };

  if (loading || authLoading) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 text-center text-gray-400">Loading…</div>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20 text-center">
          <AlertCircle className="w-12 h-12 text-gray-600 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-white mb-2">Booking not found</h1>
          <p className="text-gray-400 text-sm mb-6">
            This booking doesn&apos;t exist, or you don&apos;t have access to it.
          </p>
          <Link href="/bookings" className="text-[#FF9933] text-sm hover:text-[#e8872e]">← Back to My Bookings</Link>
        </div>
      </div>
    );
  }

  const isCustomer = role === 'customer';
  const categoryName =
    booking.service_categories?.name ??
    booking.service_providers?.service_categories?.name ??
    'Service';
  // Safe-by-default: the customer sees the provider's business name; the provider side
  // shows a generic label (no customer PII joined here — that comes later if needed).
  const counterparty = isCustomer
    ? (booking.service_providers?.business_name ?? 'Provider')
    : 'Customer';
  const StatusIcon = statusConfig[booking.status].icon;
  const amount = booking.price_charged ?? booking.price_agreed ?? booking.total_amount;
  const priceLabel = booking.price_charged != null ? 'Charged' : 'Agreed';
  const address = booking.address ?? booking.service_providers?.city ?? '';
  const actions = role ? actionsFor(role, booking.status) : [];
  const canReview = isCustomer &&
    (booking.status === 'completed' || booking.status === 'confirmed' ||
     booking.status === 'paid' || booking.status === 'reviewed');
  // Cash bookings settle in person — there's nothing to pay online and no escrow to hold.
  const isCod = booking.payment_method === 'cod';
  // The customer may pay while the job is live and nothing has been captured yet. Cash is
  // excluded. This mirrors the server guard in /api/payments/create-order, so the button can
  // never offer an illegal pay. For online bookings the DB now blocks work until this is done.
  const canPay = isCustomer && !isCod && booking.payment_status === 'pending' &&
    PAYABLE_STATUSES.includes(booking.status);
  // A cash booking shows a "Cash on delivery" badge rather than the online "Payment pending"
  // track (its payment_status stays 'pending' since no money moves through us).
  const payCfg = isCod && booking.payment_status === 'pending'
    ? { label: 'Cash on delivery', color: 'text-amber-400', bg: 'bg-amber-900/20 border-amber-700/30', icon: Wallet }
    : (paymentStatusConfig[booking.payment_status as PaymentStatus] ?? paymentStatusConfig.pending);
  const PayStatusIcon = payCfg.icon;

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/bookings" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-6">
          <ArrowLeft className="w-4 h-4" />Back to My Bookings
        </Link>

        {/* Summary */}
        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 mb-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h1 className="text-xl font-black text-white">{counterparty}</h1>
              <p className="text-sm text-[#FF9933]">{categoryName}</p>
            </div>
            <span className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full border flex-shrink-0 ${statusConfig[booking.status].color} ${statusConfig[booking.status].bg}`}>
              <StatusIcon className="w-3 h-3" />
              {statusConfig[booking.status].label}
            </span>
          </div>

          <div className="flex items-center gap-4 text-xs text-gray-400 flex-wrap mb-4">
            {booking.scheduled_date && (
              <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(booking.scheduled_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            )}
            {booking.scheduled_time && (
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatTime(booking.scheduled_time)}</span>
            )}
            {address && (
              <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{address}</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm pt-4 border-t border-[#222]">
            <div>
              <span className="text-gray-500">Booking ID</span>
              <p className="text-white font-mono text-xs mt-0.5">#{booking.id.slice(0, 8)}</p>
            </div>
            <div>
              <span className="text-gray-500">Service Type</span>
              <p className="text-white capitalize mt-0.5">{booking.service_type}</p>
            </div>
            <div>
              <span className="text-gray-500">Payment</span>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-white capitalize">{booking.payment_method}</span>
                <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${payCfg.color} ${payCfg.bg}`}>
                  <PayStatusIcon className="w-3 h-3" />
                  {payCfg.label}
                </span>
              </div>
            </div>
            <div>
              <span className="text-gray-500">{priceLabel}</span>
              <p className="text-[#FF9933] font-bold mt-0.5">₹{Number(amount).toLocaleString('en-IN')}</p>
            </div>
          </div>

          {/* Pay via escrow — customer only, once the provider has accepted. Prominent because
              the provider CAN'T start work until this is paid (the DB blocks accepted→en_route). */}
          {canPay && (
            <div className="mt-4 pt-4 border-t border-[#222]">
              <div className="rounded-xl border border-[#138808]/40 bg-[#138808]/10 p-4">
                <div className="flex items-start gap-3">
                  <Shield className="w-5 h-5 text-[#22c55e] flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-white">Pay to start your booking</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Your provider has accepted. <span className="text-gray-300">The job won&apos;t start until you pay.</span> Funds are held securely in escrow and released to the provider only after you confirm the work is done.
                    </p>
                  </div>
                </div>
                <button
                  onClick={handlePay}
                  disabled={paying}
                  className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold bg-[#138808] text-white hover:bg-[#0f6b06] transition-colors disabled:opacity-50"
                >
                  <CreditCard className="w-4 h-4" />
                  {paying ? 'Opening…' : `Pay ₹${Number(amount).toLocaleString('en-IN')} securely`}
                </button>
              </div>
            </div>
          )}

          {/* Role-appropriate transitions (all go through the RPC) */}
          {(actions.length > 0 || canReview) && (
            <div className="flex gap-3 flex-wrap pt-4 mt-4 border-t border-[#222]">
              {actions.map((action) => (
                <button
                  key={action.next}
                  onClick={() => handleTransition(action.next)}
                  disabled={acting}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm transition-colors disabled:opacity-50 ${
                    action.tone === 'danger'
                      ? 'bg-red-900/20 border border-red-700/30 text-red-400 hover:bg-red-900/30'
                      : 'bg-[#FF9933]/10 border border-[#FF9933]/30 text-[#FF9933] hover:bg-[#FF9933]/20'
                  }`}
                >
                  {action.tone === 'danger' ? <XCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
                  {action.label}
                </button>
              ))}

              {/* Write Review — stubbed until Step 6 (customer side only) */}
              {canReview && (
                <button
                  onClick={() => toast.info('Reviews arrive in a later step.')}
                  className="flex items-center gap-2 px-4 py-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl text-sm text-gray-300 hover:text-white transition-colors"
                >
                  <Star className="w-4 h-4" />Write Review
                </button>
              )}
            </div>
          )}
        </div>

        {/* Chat */}
        <div ref={chatRef}>
          <BookingChat bookingId={booking.id} />
        </div>
      </div>
    </div>
  );
}
