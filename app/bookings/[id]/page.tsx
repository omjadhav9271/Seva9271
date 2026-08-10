'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Calendar, Clock, MapPin, AlertCircle, AlertTriangle, CheckCircle, XCircle, CreditCard, Shield, Wallet, Navigation, Lock } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase, type Dispute, type DisputeReason } from '@/lib/supabase';
import BookingChat from '@/components/booking-chat';
import BookingReview from '@/components/booking-review';
import DisputeEvidencePanel from '@/components/dispute-evidence-panel';
import DisputeCase from '@/components/dispute-case';
import BookingNegotiation from '@/components/booking-negotiation';
import { DISPUTE_REASONS, fetchNames } from '@/lib/disputes';
import BookingTimeline from '@/components/booking-timeline';
import {
  type BookingRow, type BookingStatus, type PaymentStatus, type Role,
  BOOKING_SELECT, statusConfig, paymentStatusConfig, actionsFor, runTransition,
  createPaymentOrder, ownsProviderSide, formatTime, paymentMethodLabel,
  fetchServiceLocation, mapsDirectionsUrl, mapsPinUrl, type ServiceLocation,
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

// Mirrors raise_dispute's allowed states — the button never offers an illegal dispute.
const DISPUTABLE_STATUSES: BookingStatus[] = ['arrived', 'in_progress', 'completed', 'confirmed', 'paid'];

// The reason lists, labels and outcome copy live in lib/disputes.ts — one vocabulary shared with
// the admin console, so the two sides of a case can never call the same thing different names.

export default function BookingDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { user, loading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const [booking, setBooking] = useState<BookingRow | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [dispute, setDispute] = useState<Dispute | null>(null);
  // The customer's display name (public_profiles). The provider side had no way to name the
  // person they were dealing with — "Raised by the customer" is unanswerable.
  const [customerName, setCustomerName] = useState<string | null>(null);
  /* The service address, read through the definer RPC that owns the reveal rule — the columns
     themselves carry no SELECT grant, so this is the only way to it. `revealed` is decided in the
     DB, never here: the UI renders what it is told rather than deciding what to hide. */
  const [location, setLocation] = useState<ServiceLocation | null>(null);
  // Bumped whenever the booking is refetched, so the timeline re-reads booking_events alongside
  // it (that table isn't in the realtime publication, so it can't hear about new rows itself).
  const [timelineKey, setTimelineKey] = useState(0);
  const [disputeFormOpen, setDisputeFormOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState<DisputeReason | ''>('');
  const [disputeDesc, setDisputeDesc] = useState('');
  const [raising, setRaising] = useState(false);

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
        // Name both sides. public_profiles exposes only (id, full_name, avatar_url, city, state),
        // so this names the counterparty without widening the PII surface.
        const names = await fetchNames([row.customer_id]);
        if (active) setCustomerName(names[row.customer_id] || null);
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

  // Latest dispute on this booking (RLS: parties + admins only). The latest row is the one that
  // matters — the partial unique index allows at most one open dispute at a time.
  const fetchDispute = useCallback(async () => {
    const { data } = await supabase
      .from('disputes')
      .select('*')
      .eq('booking_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setDispute((data as Dispute | null) ?? null);
  }, [id]);

  useEffect(() => {
    if (!user) return;
    void fetchDispute();
  }, [user, fetchDispute]);

  /* Re-read the address whenever the STATUS changes, because the status is what unlocks it: the
     moment the provider accepts, the same call starts returning the full address instead of the
     pincode. Keyed on the status string (stable) rather than the booking object, which is replaced
     on every refetch and would re-query in a loop.
     🔴 The status dependency alone is NOT enough — see refreshLocation's call site in
     handleTransition. */
  const refreshLocation = useCallback(async () => {
    if (!user || !booking) { setLocation(null); return; }
    setLocation(await fetchServiceLocation(booking.id));
  }, [user, booking?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user || !booking) { setLocation(null); return; }
    let active = true;
    fetchServiceLocation(booking.id).then((loc) => { if (active) setLocation(loc); });
    return () => { active = false; };
  }, [user, booking?.id, booking?.status]);   // eslint-disable-line react-hooks/exhaustive-deps

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
    setTimelineKey((k) => k + 1);
  }, [id]);

  // Stop any in-flight payment poll if the page unmounts.
  useEffect(() => () => { pollAbort.current = true; }, []);

  // Live booking updates: `bookings` is in the realtime publication, so when the OTHER party
  // moves the booking (e.g. the customer confirms → it settles), this page refetches without a
  // manual refresh — the status/payment badges update and the review section's `settled` gate
  // flips on, revealing the form for the provider live. RLS gates the stream to the two parties.
  // Live updates while the page is open. Two streams, because they carry different news:
  //   bookings  — the other party moved the job (accepted, arrived, confirmed → settled)
  //   disputes  — a dispute was raised, taken under review, or RESOLVED. Resolution is the one
  //               that matters most: the notification links here, and landing on a stale "under
  //               review" banner after the outcome has been decided is exactly the confusion this
  //               pass exists to remove. `disputes` joined the realtime publication in
  //               20260811120000; RLS keeps the stream to the two parties (+ admins).
  // (Offers are subscribed inside BookingNegotiation, which owns that state.)
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`booking:${id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'bookings', filter: `id=eq.${id}` },
        // A status flip to/out of 'disputed' comes with a dispute row change — refresh both.
        () => { void refetchBooking(); void fetchDispute(); },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'disputes', filter: `booking_id=eq.${id}` },
        () => { void fetchDispute(); void refetchBooking(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, user, refetchBooking, fetchDispute]);

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
    // Either way the transition wrote a booking_events row; refetchBooking bumps the timeline
    // itself, so only the non-settling path needs to do it explicitly.
    if (next === 'confirmed') void refetchBooking();
    else setTimelineKey((k) => k + 1);

    /* Re-read the address AFTER the server has confirmed the move, not just when the local status
       string changes. Found in the browser: accepting a booking left the provider looking at
       "Pincode 400050 — unlocks once you accept" until they reloaded.
       Why the status-keyed effect cannot cover this: handleTransition updates `status`
       OPTIMISTICALLY, so that effect fires while transition_booking is still in flight. The RPC
       then reads a booking that is still 'requested' and correctly answers revealed=false — and
       because the status never changes a second time, nothing ever asks again. The DB was right
       throughout; the page had simply asked one moment too early.
       (The realtime path is unaffected: when the OTHER party moves the booking, the status really
       does change on arrival, so the effect re-fires with the truth.) */
    void refreshLocation();
  };

  // Raise a dispute — the ONLY way a booking enters 'disputed' (Step 8). The RPC validates
  // party + state server-side; here we just collect reason + description.
  const handleRaiseDispute = async () => {
    if (!booking || !disputeReason || raising) return;
    setRaising(true);
    const { data, error } = await supabase.rpc('raise_dispute', {
      p_booking_id: booking.id,
      p_reason: disputeReason,
      p_description: disputeDesc.trim() || null,
    });
    setRaising(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setDispute((Array.isArray(data) ? data[0] : data) as Dispute);
    setDisputeFormOpen(false);
    toast.success('Dispute raised. Attach any photos or files as evidence below — our team reviews both sides and gets back to you.');
    void refetchBooking();
  };

  if (loading || authLoading) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 text-center text-gray-400">Loading…</div>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-20 text-center">
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
  // The customer sees the provider's business name; the provider now sees who they're serving,
  // by name, from public_profiles (the hardened view — name/city only, never phone).
  const counterparty = isCustomer
    ? (booking.service_providers?.business_name ?? 'Provider')
    : (customerName || 'Customer');
  // One readable "when" for the dispute card.
  const scheduledLabel = [
    booking.scheduled_date
      ? new Date(booking.scheduled_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : null,
    formatTime(booking.scheduled_time) || null,
  ].filter(Boolean).join(', ');
  const StatusIcon = statusConfig[booking.status].icon;
  // While a booking is being negotiated NOTHING is agreed — price_agreed is deliberately NULL
  // (that is what makes /api/payments/create-order refuse to charge it). Falling back to
  // total_amount and still calling it "Agreed" told a customer who had offered ₹450 that they had
  // agreed ₹1,200, and kept saying it on an expired negotiation where no price was ever struck.
  // Label what the number actually is: charged > agreed > merely listed.
  const amount = booking.price_charged ?? booking.price_agreed ?? booking.total_amount;
  const priceLabel = booking.price_charged != null
    ? 'Charged'
    : booking.price_agreed != null
      ? 'Agreed'
      : 'Listed';
  // Bucket C (20): the shape of the job — how long it was booked for, and the rate it was listed
  // at. The rate is a sub-caption, never the headline: once a price is agreed or charged, THAT is
  // what anyone owes, and an hourly rate sitting next to it as an equal invites the wrong maths.
  const hours = Number(booking.duration_hours ?? 0);
  const workLabel = hours > 0 ? `${hours} hour${hours === 1 ? '' : 's'} of work` : 'Not specified';
  const rateLabel = Number(booking.hourly_rate) > 0
    ? `listed at ₹${Number(booking.hourly_rate).toLocaleString('en-IN')}/hr`
    : null;
  /* What goes in the header chip: the revealed address, else the pincode, else the provider's
     city. Never a blank chip and never a half-truth — the full block below says which it is. */
  const addressChip = location?.revealed
    ? [location.address, location.pincode].filter(Boolean).join(', ')
    : location?.pincode ?? booking.service_providers?.city ?? '';
  const directionsUrl = location?.revealed ? mapsDirectionsUrl(location) : null;
  const pinUrl = location?.revealed ? mapsPinUrl(location) : null;
  const actions = role ? actionsFor(role, booking.status) : [];
  // Settled = money has cleared (tightened from Step 1's 'completed'). Reviews open for BOTH
  // parties on a settled booking; the review section itself gates on whether you've reviewed yet.
  const settled = booking.status === 'paid' || booking.status === 'reviewed' ||
    booking.payment_status === 'released';
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
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/bookings" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-6">
          <ArrowLeft className="w-4 h-4" />Back to My Bookings
        </Link>

        {/* Step 10: while a price is being negotiated, the offer panel IS the action area —
            actionsFor() deliberately returns nothing for 'negotiating'. */}
        {booking.status === 'negotiating' && role && (
          <div className="mb-6">
            <BookingNegotiation bookingId={booking.id} role={role} onSettled={refetchBooking} />
          </div>
        )}

        {/* The dispute card — who raised it, against whom, about which booking, in whose words,
            and (once resolved) the outcome plus the settlement. Replaces the normal action
            emphasis while a dispute is live. */}
        {dispute && (
          <DisputeCase
            dispute={dispute}
            viewerRole={role}
            viewerId={user?.id ?? null}
            customerName={customerName}
            providerName={booking.service_providers?.business_name ?? null}
            categoryName={categoryName}
            bookingId={booking.id}
            scheduledLabel={scheduledLabel}
            workSummary={booking.notes}
            amount={Number(amount)}
            priceLabel={`${priceLabel} amount`}
          />
        )}

        {/* Summary */}
        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 mb-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              {/* Bucket C (20): say WHO this person is to you. "Ramesh Electricals" alone left the
                  provider's own list ambiguous about which side they were looking at. */}
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-0.5">
                {isCustomer ? 'Your provider' : 'Your customer'}
              </p>
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
            {addressChip && (
              <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{addressChip}</span>
            )}
          </div>

          {/* WHERE THE JOB IS — and, for the provider, whether they may see it yet.

              The gate is the database's, not this component's: booking_service_location() returns
              a NULL address to a provider whose booking is still requested or negotiating, so
              there is nothing here to accidentally render. This block only explains the state.

              Navigation is DELEGATED. The button hands the address to Google Maps, which geocodes
              Indian addresses far better than we could, and that is the whole feature — no in-app
              map, no route line, no ETA, no live position. That is Step 15. */}
          {location && (
            <div className="mb-4 rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                {isCustomer ? 'Where we\'re coming' : 'Where the job is'}
              </p>

              {location.revealed ? (
                <>
                  <p className="text-sm text-gray-100 leading-relaxed whitespace-pre-line">
                    {location.address || 'No address was given for this booking.'}
                  </p>
                  {location.pincode && <p className="text-sm text-gray-400 mt-0.5">Pincode {location.pincode}</p>}

                  {directionsUrl && (
                    <div className="flex flex-wrap items-center gap-3 mt-3">
                      <a
                        href={directionsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-[#FF9933] text-white hover:bg-[#e8872e] transition-colors"
                      >
                        <Navigation className="w-4 h-4" />
                        Open in Google Maps
                      </a>
                      {/* The backup pin, offered separately rather than instead of the address:
                          the text is what the customer typed and what a human reads out at the
                          gate, but a pin wins when Google cannot place the words. */}
                      {pinUrl && (
                        <a
                          href={pinUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-gray-400 hover:text-white transition-colors underline underline-offset-2"
                        >
                          Or open the map pin they dropped
                        </a>
                      )}
                    </div>
                  )}

                  {!isCustomer && (
                    <p className="text-[11px] text-gray-600 mt-3">
                      Shared with you because you accepted this booking. Please use it only for this job.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-300 flex items-center gap-2">
                    <Lock className="w-3.5 h-3.5 text-gray-500" />
                    {location.pincode
                      ? <>Pincode <span className="font-semibold text-white">{location.pincode}</span></>
                      : <>Area not given</>}
                  </p>
                  <p className="text-xs text-gray-500 mt-1.5">
                    The customer&apos;s full address unlocks once you accept this booking.
                  </p>
                </>
              )}
            </div>
          )}

          {/* The facts of the job, each one labeled. Display only — every value here is read
              straight off the booking row; nothing is computed and nothing is decided. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4 text-sm pt-4 border-t border-[#222]">
            <Detail label="Service" value={categoryName} />
            <Detail label="Booking type" value={booking.service_type} capitalize />
            <Detail label="Work booked" value={workLabel} />
            <Detail label={`${priceLabel} price`}>
              <span className="text-[#FF9933] font-bold">₹{Number(amount).toLocaleString('en-IN')}</span>
              {rateLabel && <span className="block text-xs text-gray-500 mt-0.5">{rateLabel}</span>}
            </Detail>
            <Detail label="Payment">
              <span className="text-white">{paymentMethodLabel(booking.payment_method)}</span>
              <span className={`mt-1 inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${payCfg.color} ${payCfg.bg}`}>
                <PayStatusIcon className="w-3 h-3" />
                {payCfg.label}
              </span>
            </Detail>
            <Detail label="Booked on" value={booking.created_at
              ? new Date(booking.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
              : null} />
            <Detail label="Booking ID">
              <span className="text-white font-mono text-xs">#{booking.id.slice(0, 8)}</span>
            </Detail>
          </div>

          {/* What the customer actually asked for, in their words. */}
          {booking.notes && (
            <div className="mt-4 pt-4 border-t border-[#222]">
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                {isCustomer ? 'What you asked for' : 'What the customer asked for'}
              </p>
              <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-line">{booking.notes}</p>
            </div>
          )}

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
          {actions.length > 0 && (
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
            </div>
          )}

          {/* Report a problem — either party, only in the states raise_dispute accepts, and only
              while no dispute is open (a resolved one doesn't block a new problem). */}
          {role && DISPUTABLE_STATUSES.includes(booking.status) &&
            (!dispute || dispute.status === 'resolved') && (
            <div className="pt-4 mt-4 border-t border-[#222]">
              {!disputeFormOpen ? (
                <button
                  onClick={() => setDisputeFormOpen(true)}
                  className="flex items-center gap-2 text-xs text-gray-500 hover:text-orange-400 transition-colors"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Report a problem with this booking
                </button>
              ) : (
                <div className="rounded-xl border border-orange-700/30 bg-orange-900/10 p-4">
                  <p className="text-sm font-semibold text-white mb-3">What went wrong?</p>
                  <div className="space-y-3">
                    <select
                      value={disputeReason}
                      onChange={(e) => setDisputeReason(e.target.value as DisputeReason)}
                      className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-orange-500/50"
                    >
                      <option value="">Select a reason…</option>
                      {DISPUTE_REASONS[role].map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                    <textarea
                      value={disputeDesc}
                      onChange={(e) => setDisputeDesc(e.target.value)}
                      rows={3}
                      placeholder="Describe what happened — dates, amounts, what was promised. Both this message and the other party's reply go to our team."
                      className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-orange-500/50 resize-none"
                    />
                    <p className="text-xs text-gray-500">
                      Raising a dispute pauses this booking. Our team reads the reason and message
                      you file here, the evidence each side attaches, and this booking&apos;s
                      timeline, chat and payments. Money stays protected until it&apos;s resolved.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={handleRaiseDispute}
                        disabled={raising || !disputeReason}
                        className="px-4 py-2 rounded-xl text-sm font-semibold bg-orange-600 text-white hover:bg-orange-700 transition-colors disabled:opacity-50"
                      >
                        {raising ? 'Submitting…' : 'Raise dispute'}
                      </button>
                      <button
                        onClick={() => setDisputeFormOpen(false)}
                        disabled={raising}
                        className="px-4 py-2 rounded-xl text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* (20) Every transition, in order, from the state machine's own audit trail. */}
        <BookingTimeline bookingId={booking.id} refreshKey={timelineKey} />

        {/* Dispute evidence — either party attaches files while a dispute is live; you see only
            your own. The admin weighs both sides in the evidence bundle. */}
        {dispute && role && <DisputeEvidencePanel dispute={dispute} role={role} />}

        {/* Reviews — bidirectional + reciprocity-gated. Rendered for the two parties once the
            booking is settled; the section itself shows the form, the waiting state, or the
            revealed counterpart review depending on RLS. */}
        {role && user && settled && (
          <BookingReview
            bookingId={booking.id}
            role={role}
            userId={user.id}
            settled={settled}
            counterpartyName={counterparty}
          />
        )}

        {/* Chat */}
        <div ref={chatRef}>
          <BookingChat bookingId={booking.id} />
        </div>
      </div>
    </div>
  );
}

/* One labeled fact about the booking. Renders nothing when there is nothing to say — an empty
   "Work booked —" row is worse than the row not being there. */
function Detail({ label, value, capitalize, children }: {
  label: string;
  value?: string | null;
  capitalize?: boolean;
  children?: React.ReactNode;
}) {
  if (!children && !value) return null;
  return (
    <div>
      <span className="text-xs uppercase tracking-wide text-gray-500">{label}</span>
      <div className="mt-1 flex flex-col items-start">
        {children ?? <span className={`text-white ${capitalize ? 'capitalize' : ''}`}>{value}</span>}
      </div>
    </div>
  );
}
