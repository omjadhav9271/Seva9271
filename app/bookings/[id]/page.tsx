'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Calendar, Clock, MapPin, Wallet, CheckCircle, XCircle,
  AlertCircle, RefreshCw, Truck, Star,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import BookingChat from '@/components/booking-chat';

type BookingStatus =
  | 'requested' | 'accepted' | 'en_route' | 'arrived' | 'in_progress'
  | 'completed' | 'confirmed' | 'paid' | 'reviewed'
  | 'cancelled' | 'disputed' | 'expired';

type BookingDetail = {
  id: string;
  customer_id: string;
  provider_id: string;
  scheduled_date: string | null;
  scheduled_time: string | null;
  total_amount: number;
  price_agreed: number | null;
  price_charged: number | null;
  status: BookingStatus;
  payment_method: string;
  payment_status: string;
  service_type: string;
  address: string | null;
  service_providers: {
    business_name: string | null;
    city: string | null;
    service_categories: { name: string; slug: string } | null;
  } | null;
  service_categories: { name: string; slug: string } | null;
};

const DETAIL_SELECT =
  'id, customer_id, provider_id, scheduled_date, scheduled_time, total_amount, price_agreed, price_charged, status, payment_method, payment_status, service_type, address, service_providers(business_name, city, service_categories(name, slug)), service_categories(name, slug)';

const statusConfig: Record<BookingStatus, { label: string; color: string; bg: string; icon: typeof CheckCircle }> = {
  requested:   { label: 'Requested',   color: 'text-yellow-400',  bg: 'bg-yellow-900/20 border-yellow-700/30',   icon: AlertCircle },
  accepted:    { label: 'Accepted',    color: 'text-blue-400',    bg: 'bg-blue-900/20 border-blue-700/30',       icon: CheckCircle },
  en_route:    { label: 'On the way',  color: 'text-sky-400',     bg: 'bg-sky-900/20 border-sky-700/30',         icon: Truck },
  arrived:     { label: 'Arrived',     color: 'text-teal-400',    bg: 'bg-teal-900/20 border-teal-700/30',       icon: MapPin },
  in_progress: { label: 'In Progress', color: 'text-[#FF9933]',   bg: 'bg-[#FF9933]/10 border-[#FF9933]/30',     icon: RefreshCw },
  completed:   { label: 'Completed',   color: 'text-[#22c55e]',   bg: 'bg-[#138808]/10 border-[#138808]/30',     icon: CheckCircle },
  confirmed:   { label: 'Confirmed',   color: 'text-emerald-400', bg: 'bg-emerald-900/20 border-emerald-700/30', icon: CheckCircle },
  paid:        { label: 'Paid',        color: 'text-green-400',   bg: 'bg-green-900/20 border-green-700/30',     icon: Wallet },
  reviewed:    { label: 'Reviewed',    color: 'text-purple-400',  bg: 'bg-purple-900/20 border-purple-700/30',   icon: Star },
  cancelled:   { label: 'Cancelled',   color: 'text-red-400',     bg: 'bg-red-900/20 border-red-700/30',         icon: XCircle },
  disputed:    { label: 'Disputed',    color: 'text-orange-400',  bg: 'bg-orange-900/20 border-orange-700/30',   icon: AlertCircle },
  expired:     { label: 'Expired',     color: 'text-gray-400',    bg: 'bg-gray-800/40 border-gray-700/40',       icon: Clock },
};

function formatTime(t: string | null): string {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return t;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr ?? '00'} ${ampm}`;
}

export default function BookingDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { user, loading: authLoading } = useAuth();
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(true);

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
        .select(DETAIL_SELECT)
        .eq('id', id)
        .maybeSingle();
      if (!active) return;
      if (error) console.error('Failed to load booking:', error.message);
      setBooking((data as unknown as BookingDetail) ?? null);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [id, user, authLoading]);

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

  const isCustomer = user?.id === booking.customer_id;
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
        </div>

        {/* Chat */}
        <BookingChat bookingId={booking.id} />
      </div>
    </div>
  );
}
