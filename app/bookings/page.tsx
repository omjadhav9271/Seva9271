'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  BookOpen, Calendar, Clock, MapPin, Star, CheckCircle, XCircle,
  AlertCircle, RefreshCw, Truck, Wallet, User as UserIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

type BookingStatus =
  | 'requested' | 'accepted' | 'en_route' | 'arrived' | 'in_progress'
  | 'completed' | 'confirmed' | 'paid' | 'reviewed'
  | 'cancelled' | 'disputed' | 'expired';

type Role = 'customer' | 'provider';

type BookingRow = {
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
  service_providers: { business_name: string | null; city: string | null; service_categories: { name: string; slug: string } | null } | null;
  service_categories: { name: string; slug: string } | null;
};

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

const categoryGradient: Record<string, string> = {
  electrician: 'from-amber-500 to-orange-600',
  'house-cleaning': 'from-pink-500 to-rose-600',
  plumber: 'from-blue-500 to-cyan-600',
  'home-cook': 'from-red-500 to-orange-500',
  'farm-fresh': 'from-green-500 to-emerald-600',
  delivery: 'from-orange-500 to-amber-500',
};

type Action = { label: string; next: BookingStatus; tone: 'primary' | 'danger' };

// Which button each role gets at each status. Every entry maps 1:1 to a transition
// allowed by the transition_booking RPC, so the UI can never offer an illegal move.
// Provider drives the job forward through `completed`; the customer confirms and pays.
const PROVIDER_ACTION: Partial<Record<BookingStatus, Action>> = {
  requested:   { label: 'Accept',        next: 'accepted',    tone: 'primary' },
  accepted:    { label: 'Start travel',  next: 'en_route',    tone: 'primary' },
  en_route:    { label: 'Arrived',       next: 'arrived',     tone: 'primary' },
  arrived:     { label: 'Start work',    next: 'in_progress', tone: 'primary' },
  in_progress: { label: 'Mark complete', next: 'completed',   tone: 'primary' },
};

const CUSTOMER_ACTION: Partial<Record<BookingStatus, Action>> = {
  completed: { label: 'Confirm done',        next: 'confirmed', tone: 'primary' },
  confirmed: { label: 'Mark as paid (cash)', next: 'paid',      tone: 'primary' }, // Step-5 stub
};

// The customer may cancel while the job hasn't started yet.
const CUSTOMER_CANCELLABLE: BookingStatus[] = ['requested', 'accepted', 'en_route'];

function actionsFor(role: Role, status: BookingStatus): Action[] {
  if (role === 'provider') {
    const action = PROVIDER_ACTION[status];
    return action ? [action] : [];
  }
  const actions: Action[] = [];
  const action = CUSTOMER_ACTION[status];
  if (action) actions.push(action);
  if (CUSTOMER_CANCELLABLE.includes(status)) {
    actions.push({ label: 'Cancel', next: 'cancelled', tone: 'danger' });
  }
  return actions;
}

const BOOKING_SELECT =
  'id, customer_id, provider_id, scheduled_date, scheduled_time, total_amount, price_agreed, price_charged, status, payment_method, payment_status, service_type, address, service_providers(business_name, city, service_categories(name, slug)), service_categories(name, slug)';

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
  const [customerBookings, setCustomerBookings] = useState<BookingRow[]>([]);
  const [providerBookings, setProviderBookings] = useState<BookingRow[]>([]);
  const [hasProviderProfile, setHasProviderProfile] = useState(false);
  const [view, setView] = useState<Role>('customer');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<BookingStatus | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

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

  useEffect(() => {
    if (!user) {
      router.push('/auth/signin');
      return;
    }
    loadBookings(user.id);
  }, [user, router, loadBookings]);

  // Merge a partial update into a booking wherever it appears (both role views).
  const patchBooking = useCallback((id: string, patch: Partial<BookingRow>) => {
    const apply = (rows: BookingRow[]) => rows.map((b) => (b.id === id ? { ...b, ...patch } : b));
    setCustomerBookings(apply);
    setProviderBookings(apply);
  }, []);

  const handleTransition = async (booking: BookingRow, next: BookingStatus, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    const prevStatus = booking.status;
    setActingId(booking.id);
    // Optimistic: advance the badge/actions immediately so the next step is available at once.
    patchBooking(booking.id, { status: next });

    const { data, error } = await supabase.rpc('transition_booking', {
      p_booking_id: booking.id,
      p_next_status: next,
    });
    setActingId(null);

    if (error) {
      patchBooking(booking.id, { status: prevStatus }); // roll back on rejection
      toast.error(error.message);
      return;
    }

    // Reconcile with the authoritative row the RPC returns (price_charged, payment_status, …).
    const row = (Array.isArray(data) ? data[0] : data) as Partial<BookingRow> | null;
    patchBooking(booking.id, {
      status: row?.status ?? next,
      price_charged: row?.price_charged ?? booking.price_charged,
      payment_status: row?.payment_status ?? booking.payment_status,
    });
    toast.success(`Marked as “${statusConfig[next].label}”.`);
  };

  if (!user) return null;

  const source = view === 'provider' ? providerBookings : customerBookings;
  const filtered = filter === 'all' ? source : source.filter((b) => b.status === filter);

  const tabs: { value: BookingStatus | 'all'; label: string }[] = [
    { value: 'all', label: `All (${source.length})` },
    { value: 'requested', label: 'Requested' },
    { value: 'accepted', label: 'Accepted' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'paid', label: 'Paid' },
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
                  onClick={() => { setView(r.value); setFilter('all'); setSelectedId(null); }}
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
              const actions = actionsFor(view, booking.status);
              const amount = booking.price_charged ?? booking.total_amount;
              return (
                <div
                  key={booking.id}
                  className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover cursor-pointer"
                  onClick={() => setSelectedId(selectedId === booking.id ? null : booking.id)}
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
                        {address && (
                          <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{address}</span>
                        )}
                      </div>
                    </div>

                    {/* Amount */}
                    <div className="text-right flex-shrink-0">
                      <p className="font-black text-white">₹{Number(amount).toLocaleString('en-IN')}</p>
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
                          <p className="text-white capitalize mt-0.5">{booking.payment_method} · {booking.payment_status}</p>
                        </div>
                        <div>
                          <span className="text-gray-500">{booking.price_charged != null ? 'Charged' : 'Agreed'}</span>
                          <p className="text-[#FF9933] font-bold mt-0.5">₹{Number(booking.price_charged ?? booking.price_agreed ?? booking.total_amount).toLocaleString('en-IN')}</p>
                        </div>
                      </div>

                      <div className="flex gap-3 flex-wrap">
                        {/* Status-appropriate transitions (all go through the RPC) */}
                        {actions.map((action) => (
                          <button
                            key={action.next}
                            onClick={(e) => handleTransition(booking, action.next, e)}
                            disabled={actingId === booking.id}
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
                        {view === 'customer' && (booking.status === 'completed' || booking.status === 'confirmed' || booking.status === 'paid' || booking.status === 'reviewed') && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toast.info('Reviews arrive in a later step.'); }}
                            className="flex items-center gap-2 px-4 py-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl text-sm text-gray-300 hover:text-white transition-colors"
                          >
                            <Star className="w-4 h-4" />Write Review
                          </button>
                        )}

                        <button
                          onClick={(e) => { e.stopPropagation(); }}
                          className="flex items-center gap-2 px-4 py-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl text-sm text-gray-300 hover:text-white transition-colors"
                        >
                          {view === 'provider' ? 'Contact Customer' : 'Contact Provider'}
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
