'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, Calendar, Clock, MapPin, User as UserIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import {
  type BookingRow, type BookingStatus, type PaymentStatus, type Role,
  BOOKING_SELECT, statusConfig, paymentStatusConfig, categoryGradient, initials, formatTime,
} from '@/lib/bookings';

// This page is an index: it lists bookings and links to each one. Status actions and chat
// both live on /bookings/[id], so there's one place to act on a booking and one copy of the
// transition logic.
const FILTER_TABS: { value: BookingStatus | 'all'; label: string }[] = [
  { value: 'all',         label: 'All' },
  { value: 'requested',   label: 'Requested' },
  { value: 'accepted',    label: 'Accepted' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed',   label: 'Completed' },
  { value: 'paid',        label: 'Paid' },
  { value: 'cancelled',   label: 'Cancelled' },
];

export default function BookingsPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [customerBookings, setCustomerBookings] = useState<BookingRow[]>([]);
  const [providerBookings, setProviderBookings] = useState<BookingRow[]>([]);
  const [hasProviderProfile, setHasProviderProfile] = useState(false);
  const [view, setView] = useState<Role>('customer');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<BookingStatus | 'all'>('all');

  const loadBookings = useCallback(async (userId: string) => {
    // Which provider profiles (if any) does this user own?
    const { data: provRows } = await supabase
      .from('service_providers')
      .select('id')
      .eq('user_id', userId);
    const providerIds = (provRows ?? []).map((r) => r.id as string);
    setHasProviderProfile(providerIds.length > 0);

    // RLS scopes this to the union of the caller's customer bookings and bookings
    // for providers they own; we partition client-side into the two views.
    const { data, error } = await supabase
      .from('bookings')
      .select(BOOKING_SELECT)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to load bookings:', error.message);
      setCustomerBookings([]);
      setProviderBookings([]);
    } else {
      const all = (data ?? []) as unknown as BookingRow[];
      setCustomerBookings(all.filter((b) => b.customer_id === userId));
      setProviderBookings(all.filter((b) => providerIds.includes(b.provider_id)));
    }
    setLoading(false);
  }, []);

  // Wait for the session to be restored before deciding the user is signed out.
  // AuthContext starts at { user: null, loading: true }, so redirecting on !user
  // alone bounced a signed-in user to /auth/signin on every hard refresh.
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push('/auth/signin');
      return;
    }
    loadBookings(user.id);
  }, [user, authLoading, router, loadBookings]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">
        Loading…
      </div>
    );
  }
  if (!user) return null;

  const source = view === 'provider' ? providerBookings : customerBookings;
  const filtered = filter === 'all' ? source : source.filter((b) => b.status === filter);
  const tabs = FILTER_TABS.map((t) =>
    t.value === 'all' ? { ...t, label: `All (${source.length})` } : t,
  );

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-black text-white flex items-center gap-3">
            <BookOpen className="w-8 h-8 text-[#FF9933]" />My Bookings
          </h1>
          <Link href="/services" className="saffron-btn px-5 py-2.5 rounded-xl text-sm font-semibold">
            + New Booking
          </Link>
        </div>

        {/* Role toggle — the provider tab only exists if the user owns a provider profile */}
        {hasProviderProfile && (
          <div className="inline-flex bg-[#161616] border border-[#2a2a2a] rounded-xl p-1 mb-6">
            {([
              { value: 'customer', label: 'As Customer', icon: UserIcon },
              { value: 'provider', label: 'As Provider', icon: BookOpen },
            ] as { value: Role; label: string; icon: typeof UserIcon }[]).map((r) => {
              const RoleIcon = r.icon;
              return (
                <button
                  key={r.value}
                  onClick={() => { setView(r.value); setFilter('all'); }}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    view === r.value ? 'bg-[#FF9933] text-white' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  <RoleIcon className="w-4 h-4" />{r.label}
                </button>
              );
            })}
          </div>
        )}

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
            <p className="text-gray-400 text-lg mb-2">
              {view === 'provider' ? 'No incoming jobs found' : 'No bookings found'}
            </p>
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
              const isProviderView = view === 'provider';
              const title = isProviderView ? categoryName : providerName;
              const subtitle = isProviderView ? 'Incoming request' : categoryName;
              // Match the detail page's ladder: what was charged, else what was agreed, else what
              // was merely listed. total_amount alone called an unnegotiated list price "the" price.
              const amount = booking.price_charged ?? booking.price_agreed ?? booking.total_amount;
              const hours = Number(booking.duration_hours ?? 0);
              // (20) Where the money is. On a list of jobs this is the second question after
              // "what state is it in", and it was only answerable by opening each one.
              const payCfg = paymentStatusConfig[booking.payment_status as PaymentStatus]
                ?? paymentStatusConfig.pending;
              const PayIcon = payCfg.icon;
              return (
                <Link
                  key={booking.id}
                  href={`/bookings/${booking.id}`}
                  className="block bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover"
                >
                  <div className="flex items-start gap-4">
                    {/* Avatar */}
                    <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center text-sm font-black text-white flex-shrink-0`}>
                      {initials(isProviderView ? categoryName : providerName)}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-bold text-white">{title}</h3>
                          <p className="text-sm text-[#FF9933]">{subtitle}</p>
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
                        {hours > 0 && (
                          <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{hours} hr{hours === 1 ? '' : 's'}</span>
                        )}
                        {address && (
                          <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{address}</span>
                        )}
                      </div>
                    </div>

                    {/* Amount + where the money currently is */}
                    <div className="text-right flex-shrink-0">
                      <p className="font-black text-white">₹{Number(amount).toLocaleString('en-IN')}</p>
                      <span className={`inline-flex items-center gap-1 mt-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${payCfg.color} ${payCfg.bg}`}>
                        <PayIcon className="w-3 h-3" />
                        {payCfg.label}
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
