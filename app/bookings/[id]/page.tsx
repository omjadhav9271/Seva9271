'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Calendar, Clock, MapPin, AlertCircle, CheckCircle, XCircle, Star } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import BookingChat from '@/components/booking-chat';
import {
  type BookingRow, type BookingStatus, type Role,
  BOOKING_SELECT, statusConfig, actionsFor, runTransition, ownsProviderSide, formatTime,
} from '@/lib/bookings';
import { toast } from 'sonner';

export default function BookingDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { user, loading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const [booking, setBooking] = useState<BookingRow | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  // Message notifications link here with ?tab=chat; status notifications land at the top so
  // the action buttons are what you see first.
  const wantChat = searchParams.get('tab') === 'chat';
  const chatRef = useRef<HTMLDivElement>(null);
  const didScroll = useRef(false);

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
              <p className="text-white capitalize mt-0.5">{booking.payment_method} · {booking.payment_status}</p>
            </div>
            <div>
              <span className="text-gray-500">{priceLabel}</span>
              <p className="text-[#FF9933] font-bold mt-0.5">₹{Number(amount).toLocaleString('en-IN')}</p>
            </div>
          </div>

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
