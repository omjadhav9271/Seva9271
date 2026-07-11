'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Star, MapPin, Clock, CheckCircle, ArrowLeft, Heart, Share2,
  Calendar, Shield, Award
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

type ProviderDetail = {
  id: string;
  category_id: string | null;
  business_name: string | null;
  bio: string | null;
  experience_years: number;
  hourly_rate: number;
  rating: number;
  total_reviews: number;
  total_bookings: number;
  is_verified: boolean;
  is_available: boolean;
  city: string | null;
  state: string | null;
  service_categories: { name: string; slug: string } | null;
};

type ReviewRow = { id: string; rating: number; comment: string | null; created_at: string };

const categoryGradient: Record<string, string> = {
  electrician: 'from-amber-500 to-orange-600',
  'house-cleaning': 'from-pink-500 to-rose-600',
  plumber: 'from-blue-500 to-cyan-600',
  'home-cook': 'from-red-500 to-orange-500',
  'farm-fresh': 'from-green-500 to-emerald-600',
  delivery: 'from-orange-500 to-amber-500',
  doctor: 'from-teal-500 to-cyan-600',
  carpenter: 'from-yellow-500 to-amber-600',
  caretaker: 'from-purple-500 to-violet-600',
  tutor: 'from-indigo-500 to-purple-600',
};

// The six fixed time-slot labels map to 24h TIME values for the DB column.
const timeSlots: { label: string; value: string }[] = [
  { label: '9:00 AM', value: '09:00' },
  { label: '11:00 AM', value: '11:00' },
  { label: '2:00 PM', value: '14:00' },
  { label: '4:00 PM', value: '16:00' },
  { label: '6:00 PM', value: '18:00' },
  { label: '8:00 PM', value: '20:00' },
];

const DURATION_HOURS = 2;

function initials(name: string | null): string {
  if (!name) return '?';
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
}

function StarRating({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'lg' }) {
  const starSize = size === 'lg' ? 'w-5 h-5' : 'w-3.5 h-3.5';
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`${starSize} ${i <= Math.floor(rating) ? 'fill-[#FF9933] text-[#FF9933]' : 'fill-gray-700 text-gray-700'}`}
        />
      ))}
    </div>
  );
}

export default function ProviderDetailPage({ params }: { params: { id: string } }) {
  const { user } = useAuth();
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderDetail | null>(null);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [bookingDate, setBookingDate] = useState('');
  const [bookingTime, setBookingTime] = useState('');
  const [serviceType, setServiceType] = useState('one-time');
  const [paymentMethod, setPaymentMethod] = useState('upi');
  const [isFavorited, setIsFavorited] = useState(false);
  const [bookingStep, setBookingStep] = useState<'form' | 'confirm'>('form');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase
        .from('service_providers')
        .select('id, category_id, business_name, bio, experience_years, hourly_rate, rating, total_reviews, total_bookings, is_verified, is_available, city, state, service_categories(name, slug)')
        .eq('id', params.id)
        .maybeSingle();
      if (!mounted) return;
      if (error) console.error('Failed to load provider:', error.message);
      setProvider((data as unknown as ProviderDetail) ?? null);

      const { data: reviewData } = await supabase
        .from('reviews')
        .select('id, rating, comment, created_at')
        .eq('provider_id', params.id)
        .order('created_at', { ascending: false })
        .limit(10);
      if (!mounted) return;
      setReviews((reviewData ?? []) as ReviewRow[]);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [params.id]);

  const handleBook = () => {
    if (!user) {
      router.push('/auth/signin');
      return;
    }
    if (!bookingDate || !bookingTime) {
      toast.error('Please select date and time');
      return;
    }
    setBookingStep('confirm');
  };

  const handleConfirmBook = async () => {
    if (!user || !provider) return;
    setSubmitting(true);
    const { error } = await supabase.from('bookings').insert({
      customer_id: user.id,
      provider_id: provider.id,
      category_id: provider.category_id,
      service_type: serviceType,
      scheduled_date: bookingDate,
      scheduled_time: bookingTime,
      duration_hours: DURATION_HOURS,
      hourly_rate: provider.hourly_rate,
      total_amount: totalAmount,
      payment_method: paymentMethod,
      // status/payment_status use their DB defaults ('pending')
    });
    setSubmitting(false);
    if (error) {
      toast.error('Could not create booking. Please try again.');
      console.error('Booking insert failed:', error.message);
      return;
    }
    toast.success('Booking created! The provider will contact you shortly.');
    router.push('/bookings');
  };

  if (loading) {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Loading provider…</div>;
  }

  if (!provider) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20 flex flex-col items-center justify-center gap-4">
        <p className="text-gray-400 text-lg">Provider not found</p>
        <Link href="/providers" className="text-[#FF9933] hover:text-[#e8872e] text-sm">← Back to Providers</Link>
      </div>
    );
  }

  const gradient = categoryGradient[provider.service_categories?.slug ?? ''] ?? 'from-slate-500 to-slate-600';
  const totalAmount = provider.hourly_rate > 0 ? provider.hourly_rate * DURATION_HOURS : 0;

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Back */}
        <Link href="/providers" className="inline-flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors group">
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
          Back to Providers
        </Link>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Profile Card */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4 mb-6">
                <div className="flex items-start gap-4">
                  <div className="relative flex-shrink-0">
                    <div className={`w-20 h-20 rounded-2xl bg-gradient-to-br ${gradient} flex items-center justify-center text-2xl font-black text-white`}>
                      {initials(provider.business_name)}
                    </div>
                    {provider.is_available && (
                      <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h1 className="text-2xl font-black text-white">{provider.business_name}</h1>
                      {provider.is_verified && <CheckCircle className="w-5 h-5 text-[#138808]" />}
                    </div>
                    <p className="text-[#FF9933] font-semibold mb-2">{provider.service_categories?.name ?? 'Service'}</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <StarRating rating={provider.rating} size="sm" />
                        <span className="font-bold text-white">{Number(provider.rating).toFixed(1)}</span>
                        <span className="text-gray-500 text-sm">({provider.total_reviews} reviews)</span>
                      </div>
                      <span className="flex items-center gap-1 text-sm text-gray-400">
                        <MapPin className="w-4 h-4" />{provider.city}{provider.state ? `, ${provider.state}` : ''}
                      </span>
                      <span className="flex items-center gap-1 text-sm text-gray-400">
                        <Clock className="w-4 h-4" />{provider.experience_years} years exp.
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => setIsFavorited(!isFavorited)}
                    className={`p-2.5 rounded-xl border transition-all ${isFavorited ? 'bg-red-900/20 border-red-500/30 text-red-400' : 'border-[#2a2a2a] text-gray-400 hover:border-red-500/30 hover:text-red-400'}`}
                  >
                    <Heart className={`w-5 h-5 ${isFavorited ? 'fill-current' : ''}`} />
                  </button>
                  <button className="p-2.5 rounded-xl border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/30 hover:text-[#FF9933] transition-all">
                    <Share2 className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Stats Row */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-[#1e1e1e] rounded-xl p-4 text-center">
                  <p className="text-xl font-black text-white">{provider.total_bookings}+</p>
                  <p className="text-xs text-gray-400 mt-0.5">Jobs Done</p>
                </div>
                <div className="bg-[#1e1e1e] rounded-xl p-4 text-center">
                  <p className="text-xl font-black text-[#FF9933]">{Number(provider.rating).toFixed(1)}</p>
                  <p className="text-xs text-gray-400 mt-0.5">Avg Rating</p>
                </div>
                <div className="bg-[#1e1e1e] rounded-xl p-4 text-center">
                  <p className="text-xl font-black text-[#138808]">{provider.experience_years}y</p>
                  <p className="text-xs text-gray-400 mt-0.5">Experience</p>
                </div>
              </div>

              {/* Badges */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                {provider.is_verified && (
                  <span className="flex items-center gap-1.5 bg-[#138808]/10 border border-[#138808]/20 rounded-full px-3 py-1 text-sm font-medium text-[#138808]">
                    <Shield className="w-4 h-4" />Verified
                  </span>
                )}
                {provider.total_bookings > 500 && (
                  <span className="flex items-center gap-1.5 bg-[#FF9933]/10 border border-[#FF9933]/20 rounded-full px-3 py-1 text-sm font-medium text-[#FF9933]">
                    <Award className="w-4 h-4" />Top Rated
                  </span>
                )}
                <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${provider.is_available ? 'bg-[#22c55e]/10 border border-[#22c55e]/20 text-[#22c55e]' : 'bg-gray-800 text-gray-500'}`}>
                  <span className={`w-2 h-2 rounded-full ${provider.is_available ? 'bg-[#22c55e] animate-pulse' : 'bg-gray-500'}`} />
                  {provider.is_available ? 'Available Now' : 'Currently Busy'}
                </span>
              </div>

              {/* Bio */}
              {provider.bio && <p className="text-gray-300 text-sm leading-relaxed">{provider.bio}</p>}
            </div>

            {/* Reviews */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="font-bold text-white text-lg">Customer Reviews</h2>
                <div className="flex items-center gap-2">
                  <StarRating rating={provider.rating} />
                  <span className="text-white font-bold">{Number(provider.rating).toFixed(1)}</span>
                  <span className="text-gray-500 text-sm">/ 5</span>
                </div>
              </div>
              {reviews.length === 0 ? (
                <p className="text-sm text-gray-500">No reviews yet. Reviews appear here once a completed booking is rated.</p>
              ) : (
                <div className="space-y-5">
                  {reviews.map((r) => (
                    <div key={r.id} className="pb-5 border-b border-[#222] last:border-0 last:pb-0">
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-500 to-slate-700 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                          C
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-white">Verified customer</span>
                              <CheckCircle className="w-3.5 h-3.5 text-[#138808]" />
                            </div>
                            <span className="text-xs text-gray-500">{new Date(r.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                          </div>
                          <StarRating rating={r.rating} />
                          {r.comment && <p className="text-sm text-gray-300 mt-2 leading-relaxed">{r.comment}</p>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Booking Sidebar */}
          <div className="lg:col-span-1">
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 sticky top-24">
              {bookingStep === 'form' ? (
                <>
                  <h3 className="font-bold text-white text-lg mb-1">Book This Provider</h3>
                  {provider.hourly_rate > 0 && (
                    <p className="text-[#FF9933] font-black text-2xl mb-5">₹{provider.hourly_rate}<span className="text-sm font-normal text-gray-400">/hour</span></p>
                  )}

                  <div className="space-y-4 mb-5">
                    {/* Service Type */}
                    <div>
                      <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-2">Service Type</label>
                      <div className="grid grid-cols-2 gap-2">
                        {['one-time', 'weekly', 'monthly', 'yearly'].map((t) => (
                          <button
                            key={t}
                            onClick={() => setServiceType(t)}
                            className={`py-2 rounded-lg text-xs font-medium capitalize transition-all ${serviceType === t ? 'bg-[#FF9933] text-white' : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/50'}`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Date */}
                    <div>
                      <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-2">Date</label>
                      <div className="flex items-center gap-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5">
                        <Calendar className="w-4 h-4 text-gray-500" />
                        <input
                          type="date"
                          value={bookingDate}
                          onChange={(e) => setBookingDate(e.target.value)}
                          min={new Date().toISOString().split('T')[0]}
                          className="flex-1 bg-transparent text-white text-sm focus:outline-none"
                        />
                      </div>
                    </div>

                    {/* Time */}
                    <div>
                      <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-2">Time</label>
                      <div className="grid grid-cols-3 gap-2">
                        {timeSlots.map((t) => (
                          <button
                            key={t.value}
                            onClick={() => setBookingTime(t.value)}
                            className={`py-2 rounded-lg text-xs font-medium transition-all ${bookingTime === t.value ? 'bg-[#FF9933] text-white' : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/50'}`}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Payment */}
                    <div>
                      <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-2">Payment Method</label>
                      <div className="space-y-2">
                        {[
                          { value: 'upi', label: 'UPI (GPay, PhonePe)', icon: '📱' },
                          { value: 'wallet', label: 'Seva Wallet', icon: '💰' },
                          { value: 'cod', label: 'Cash on Delivery', icon: '💵' },
                        ].map((pm) => (
                          <button
                            key={pm.value}
                            onClick={() => setPaymentMethod(pm.value)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-sm transition-all ${paymentMethod === pm.value ? 'bg-[#FF9933]/10 border-[#FF9933]/40 text-white' : 'bg-[#1e1e1e] border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/30'}`}
                          >
                            <span>{pm.icon}</span>
                            <span>{pm.label}</span>
                            {paymentMethod === pm.value && <CheckCircle className="w-4 h-4 text-[#FF9933] ml-auto" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {provider.hourly_rate > 0 && (
                    <div className="bg-[#1e1e1e] rounded-xl p-3 mb-4">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-400">₹{provider.hourly_rate} × {DURATION_HOURS} hours</span>
                        <span className="text-white">₹{totalAmount}</span>
                      </div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-400">Platform fee</span>
                        <span className="text-white">₹0</span>
                      </div>
                      <div className="flex justify-between text-sm font-bold border-t border-[#2a2a2a] pt-2 mt-2">
                        <span className="text-white">Total</span>
                        <span className="text-[#FF9933]">₹{totalAmount}</span>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleBook}
                    className="saffron-btn w-full rounded-xl py-3.5 font-semibold text-sm"
                  >
                    {user ? 'Book Now' : 'Sign In to Book'}
                  </button>

                  <div className="flex items-center gap-2 mt-4 justify-center">
                    <Shield className="w-4 h-4 text-[#138808]" />
                    <p className="text-xs text-gray-500">Secure booking · Money-back guarantee</p>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="font-bold text-white text-lg mb-5">Confirm Booking</h3>
                  <div className="space-y-3 mb-5">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Provider</span>
                      <span className="text-white font-medium">{provider.business_name}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Service</span>
                      <span className="text-white font-medium">{provider.service_categories?.name ?? 'Service'}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Date</span>
                      <span className="text-white font-medium">{bookingDate}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Time</span>
                      <span className="text-white font-medium">{timeSlots.find((t) => t.value === bookingTime)?.label ?? bookingTime}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Type</span>
                      <span className="text-white font-medium capitalize">{serviceType}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Payment</span>
                      <span className="text-white font-medium capitalize">{paymentMethod}</span>
                    </div>
                    {provider.hourly_rate > 0 && (
                      <div className="flex justify-between text-sm font-bold pt-2 border-t border-[#222]">
                        <span className="text-white">Total Amount</span>
                        <span className="text-[#FF9933]">₹{totalAmount}</span>
                      </div>
                    )}
                  </div>
                  <button onClick={handleConfirmBook} disabled={submitting} className="saffron-btn w-full rounded-xl py-3.5 font-semibold text-sm mb-2 disabled:opacity-60">
                    {submitting ? 'Creating…' : 'Confirm Booking'}
                  </button>
                  <button onClick={() => setBookingStep('form')} disabled={submitting} className="w-full py-3 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-60">
                    Go Back
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
