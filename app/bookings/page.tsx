'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, Calendar, Clock, MapPin, Star, CheckCircle, XCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

type BookingStatus = 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';

type BookingRow = {
  id: string;
  scheduled_date: string | null;
  scheduled_time: string | null;
  total_amount: number;
  status: BookingStatus;
  payment_method: string;
  service_type: string;
  address: string | null;
  service_providers: { business_name: string | null; city: string | null; service_categories: { name: string; slug: string } | null } | null;
  service_categories: { name: string; slug: string } | null;
};

const statusConfig: Record<BookingStatus, { label: string; color: string; bg: string; icon: typeof CheckCircle }> = {
  pending: { label: 'Pending', color: 'text-yellow-400', bg: 'bg-yellow-900/20 border-yellow-700/30', icon: AlertCircle },
  confirmed: { label: 'Confirmed', color: 'text-blue-400', bg: 'bg-blue-900/20 border-blue-700/30', icon: CheckCircle },
  in_progress: { label: 'In Progress', color: 'text-[#FF9933]', bg: 'bg-[#FF9933]/10 border-[#FF9933]/30', icon: RefreshCw },
  completed: { label: 'Completed', color: 'text-[#22c55e]', bg: 'bg-[#138808]/10 border-[#138808]/30', icon: CheckCircle },
  cancelled: { label: 'Cancelled', color: 'text-red-400', bg: 'bg-red-900/20 border-red-700/30', icon: XCircle },
};

const categoryGradient: Record<string, string> = {
  electrician: 'from-amber-500 to-orange-600',
  'house-cleaning': 'from-pink-500 to-rose-600',
  plumber: 'from-blue-500 to-cyan-600',
  'home-cook': 'from-red-500 to-orange-500',
  'farm-fresh': 'from-green-500 to-emerald-600',
  delivery: 'from-orange-500 to-amber-500',
};

function initials(name: string | null): string {
  if (!name) return '?';
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
}

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

export default function BookingsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<BookingStatus | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadBookings = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from('bookings')
      .select('id, scheduled_date, scheduled_time, total_amount, status, payment_method, service_type, address, service_providers(business_name, city, service_categories(name, slug)), service_categories(name, slug)')
      .eq('customer_id', userId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Failed to load bookings:', error.message);
      setBookings([]);
    } else {
      setBookings((data ?? []) as unknown as BookingRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!user) {
      router.push('/auth/signin');
      return;
    }
    loadBookings(user.id);
  }, [user, router, loadBookings]);

  if (!user) return null;

  const filtered = filter === 'all' ? bookings : bookings.filter((b) => b.status === filter);

  const tabs: { value: BookingStatus | 'all'; label: string }[] = [
    { value: 'all', label: `All (${bookings.length})` },
    { value: 'pending', label: 'Pending' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
  ];

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-black text-white flex items-center gap-3">
            <BookOpen className="w-8 h-8 text-[#FF9933]" />My Bookings
          </h1>
          <Link href="/services" className="saffron-btn px-5 py-2.5 rounded-xl text-sm font-semibold">
            + New Booking
          </Link>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-2 overflow-x-auto pb-2 mb-6 scrollbar-hide">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setFilter(tab.value)}
              className={`flex-shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                filter === tab.value
                  ? 'bg-[#FF9933] text-white shadow-lg shadow-[#FF9933]/20'
                  : 'bg-[#161616] border border-[#2a2a2a] text-gray-400 hover:text-white hover:border-[#FF9933]/50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center py-20 text-gray-400">Loading bookings…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <BookOpen className="w-12 h-12 text-gray-600 mx-auto mb-4" />
            <p className="text-gray-400 text-lg mb-2">No bookings found</p>
            <Link href="/services" className="text-[#FF9933] text-sm hover:text-[#e8872e]">Browse services →</Link>
          </div>
        ) : (
          <div className="space-y-4">
            {filtered.map((booking) => {
              const StatusIcon = statusConfig[booking.status].icon;
              const providerName = booking.service_providers?.business_name ?? 'Provider';
              const categoryName = booking.service_categories?.name ?? booking.service_providers?.service_categories?.name ?? 'Service';
              const slug = booking.service_categories?.slug ?? booking.service_providers?.service_categories?.slug ?? '';
              const gradient = categoryGradient[slug] ?? 'from-slate-500 to-slate-600';
              const address = booking.address ?? booking.service_providers?.city ?? '';
              return (
                <div
                  key={booking.id}
                  className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover cursor-pointer"
                  onClick={() => setSelectedId(selectedId === booking.id ? null : booking.id)}
                >
                  <div className="flex items-start gap-4">
                    {/* Avatar */}
                    <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center text-sm font-black text-white flex-shrink-0`}>
                      {initials(providerName)}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-bold text-white">{providerName}</h3>
                          <p className="text-sm text-[#FF9933]">{categoryName}</p>
                        </div>
                        <span className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full border flex-shrink-0 ${statusConfig[booking.status].color} ${statusConfig[booking.status].bg}`}>
                          <StatusIcon className="w-3 h-3" />
                          {statusConfig[booking.status].label}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 mt-2.5 text-xs text-gray-400 flex-wrap">
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
                    </div>

                    {/* Amount */}
                    <div className="text-right flex-shrink-0">
                      <p className="font-black text-white">₹{Number(booking.total_amount).toLocaleString('en-IN')}</p>
                      <p className="text-xs text-gray-500 capitalize">{booking.payment_method}</p>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {selectedId === booking.id && (
                    <div className="mt-5 pt-5 border-t border-[#222]">
                      <div className="grid grid-cols-2 gap-4 text-sm mb-4">
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
                          <p className="text-white capitalize mt-0.5">{booking.payment_method}</p>
                        </div>
                        <div>
                          <span className="text-gray-500">Total</span>
                          <p className="text-[#FF9933] font-bold mt-0.5">₹{Number(booking.total_amount).toLocaleString('en-IN')}</p>
                        </div>
                      </div>

                      <div className="flex gap-3">
                        {booking.status === 'completed' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toast.info('Reviews arrive in a later step.'); }}
                            className="flex items-center gap-2 px-4 py-2 bg-[#FF9933]/10 border border-[#FF9933]/30 rounded-xl text-sm text-[#FF9933] hover:bg-[#FF9933]/20 transition-colors"
                          >
                            <Star className="w-4 h-4" />Write Review
                          </button>
                        )}
                        {booking.status === 'pending' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toast.info('Cancellation arrives with the booking state machine.'); }}
                            className="flex items-center gap-2 px-4 py-2 bg-red-900/20 border border-red-700/30 rounded-xl text-sm text-red-400 hover:bg-red-900/30 transition-colors"
                          >
                            <XCircle className="w-4 h-4" />Cancel
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); }}
                          className="flex items-center gap-2 px-4 py-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl text-sm text-gray-300 hover:text-white transition-colors"
                        >
                          Contact Provider
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
