'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, Calendar, Clock, MapPin, Star, CheckCircle, XCircle, AlertCircle, RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { toast } from 'sonner';

type BookingStatus = 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';

type MockBooking = {
  id: string;
  providerName: string;
  category: string;
  date: string;
  time: string;
  status: BookingStatus;
  amount: number;
  paymentMethod: string;
  address: string;
  avatar: string;
  gradient: string;
  serviceType: string;
};

const mockBookings: MockBooking[] = [
  { id: '1', providerName: 'Amit Sharma', category: 'Electrician', date: '2026-06-25', time: '11:00 AM', status: 'confirmed', amount: 700, paymentMethod: 'UPI', address: 'Andheri West, Mumbai', avatar: 'AS', gradient: 'from-amber-500 to-orange-600', serviceType: 'one-time' },
  { id: '2', providerName: 'Priya Patel', category: 'House Cleaning', date: '2026-06-20', time: '9:00 AM', status: 'completed', amount: 500, paymentMethod: 'Wallet', address: 'Bandra, Mumbai', avatar: 'PP', gradient: 'from-pink-500 to-rose-600', serviceType: 'weekly' },
  { id: '3', providerName: 'Meena Devi', category: 'Home Cook', date: '2026-07-01', time: '7:00 AM', status: 'pending', amount: 3600, paymentMethod: 'Cash', address: 'Powai, Mumbai', avatar: 'MD', gradient: 'from-red-500 to-orange-500', serviceType: 'monthly' },
  { id: '4', providerName: 'Ravi Kumar', category: 'Plumber', date: '2026-06-15', time: '2:00 PM', status: 'cancelled', amount: 300, paymentMethod: 'UPI', address: 'Thane, Mumbai', avatar: 'RK', gradient: 'from-blue-500 to-cyan-600', serviceType: 'one-time' },
  { id: '5', providerName: 'Suresh Farm', category: 'Farm Fresh', date: '2026-06-22', time: '7:00 AM', status: 'in_progress', amount: 800, paymentMethod: 'Cash', address: 'Malad, Mumbai', avatar: 'SF', gradient: 'from-green-500 to-emerald-600', serviceType: 'monthly' },
];

const statusConfig: Record<BookingStatus, { label: string; color: string; bg: string; icon: typeof CheckCircle }> = {
  pending: { label: 'Pending', color: 'text-yellow-400', bg: 'bg-yellow-900/20 border-yellow-700/30', icon: AlertCircle },
  confirmed: { label: 'Confirmed', color: 'text-blue-400', bg: 'bg-blue-900/20 border-blue-700/30', icon: CheckCircle },
  in_progress: { label: 'In Progress', color: 'text-[#FF9933]', bg: 'bg-[#FF9933]/10 border-[#FF9933]/30', icon: RefreshCw },
  completed: { label: 'Completed', color: 'text-[#22c55e]', bg: 'bg-[#138808]/10 border-[#138808]/30', icon: CheckCircle },
  cancelled: { label: 'Cancelled', color: 'text-red-400', bg: 'bg-red-900/20 border-red-700/30', icon: XCircle },
};

export default function BookingsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [filter, setFilter] = useState<BookingStatus | 'all'>('all');
  const [selectedBooking, setSelectedBooking] = useState<MockBooking | null>(null);

  useEffect(() => {
    if (!user) router.push('/auth/signin');
  }, [user, router]);

  if (!user) return null;

  const filtered = filter === 'all' ? mockBookings : mockBookings.filter(b => b.status === filter);

  const tabs: { value: BookingStatus | 'all'; label: string }[] = [
    { value: 'all', label: `All (${mockBookings.length})` },
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

        {filtered.length === 0 ? (
          <div className="text-center py-20">
            <BookOpen className="w-12 h-12 text-gray-600 mx-auto mb-4" />
            <p className="text-gray-400 text-lg mb-2">No bookings found</p>
            <Link href="/services" className="text-[#FF9933] text-sm hover:text-[#e8872e]">Browse services →</Link>
          </div>
        ) : (
          <div className="space-y-4">
            {filtered.map((booking) => {
              const StatusIcon = statusConfig[booking.status].icon;
              return (
                <div
                  key={booking.id}
                  className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover cursor-pointer"
                  onClick={() => setSelectedBooking(selectedBooking?.id === booking.id ? null : booking)}
                >
                  <div className="flex items-start gap-4">
                    {/* Avatar */}
                    <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${booking.gradient} flex items-center justify-center text-sm font-black text-white flex-shrink-0`}>
                      {booking.avatar}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-bold text-white">{booking.providerName}</h3>
                          <p className="text-sm text-[#FF9933]">{booking.category}</p>
                        </div>
                        <span className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full border flex-shrink-0 ${statusConfig[booking.status].color} ${statusConfig[booking.status].bg}`}>
                          <StatusIcon className="w-3 h-3" />
                          {statusConfig[booking.status].label}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 mt-2.5 text-xs text-gray-400">
                        <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(booking.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{booking.time}</span>
                        <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{booking.address}</span>
                      </div>
                    </div>

                    {/* Amount */}
                    <div className="text-right flex-shrink-0">
                      <p className="font-black text-white">₹{booking.amount.toLocaleString('en-IN')}</p>
                      <p className="text-xs text-gray-500">{booking.paymentMethod}</p>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {selectedBooking?.id === booking.id && (
                    <div className="mt-5 pt-5 border-t border-[#222]">
                      <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                        <div>
                          <span className="text-gray-500">Booking ID</span>
                          <p className="text-white font-mono text-xs mt-0.5">#{booking.id.padStart(8, '0')}</p>
                        </div>
                        <div>
                          <span className="text-gray-500">Service Type</span>
                          <p className="text-white capitalize mt-0.5">{booking.serviceType}</p>
                        </div>
                        <div>
                          <span className="text-gray-500">Payment</span>
                          <p className="text-white mt-0.5">{booking.paymentMethod}</p>
                        </div>
                        <div>
                          <span className="text-gray-500">Total</span>
                          <p className="text-[#FF9933] font-bold mt-0.5">₹{booking.amount.toLocaleString('en-IN')}</p>
                        </div>
                      </div>

                      <div className="flex gap-3">
                        {booking.status === 'completed' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toast.success('Review submitted!'); }}
                            className="flex items-center gap-2 px-4 py-2 bg-[#FF9933]/10 border border-[#FF9933]/30 rounded-xl text-sm text-[#FF9933] hover:bg-[#FF9933]/20 transition-colors"
                          >
                            <Star className="w-4 h-4" />Write Review
                          </button>
                        )}
                        {booking.status === 'pending' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toast.success('Booking cancelled'); }}
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
