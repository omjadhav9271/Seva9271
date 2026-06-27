'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Star, MapPin, Clock, CheckCircle, ArrowLeft, Heart, Share2,
  Phone, MessageCircle, Calendar, Shield, Award, ThumbsUp,
  X, Banknote, Wallet, CreditCard, Crosshair, LocateFixed,
  Sun, Moon, Map, Smartphone
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useLocation } from '@/lib/location-context';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

const dayMap: Record<string, string> = {
  'Mon': 'Monday', 'Tue': 'Tuesday', 'Wed': 'Wednesday',
  'Thu': 'Thursday', 'Fri': 'Friday', 'Sat': 'Saturday', 'Sun': 'Sunday'
};

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

function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export default function ProviderDetailPage() {
  const params = useParams<{ id: string }>();
  const { user } = useAuth();
  const { location } = useLocation();
  const [provider, setProvider] = useState<any>(null);
  const [reviews, setReviews] = useState<any[]>([]);
  const [workingHours, setWorkingHours] = useState<any[]>([]);
  const [kyc, setKyc] = useState<any>(null);
  const [isFavorited, setIsFavorited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bookingDate, setBookingDate] = useState('');
  const [bookingTime, setBookingTime] = useState('');
  const [serviceType, setServiceType] = useState('one-time');
  const [paymentMethod, setPaymentMethod] = useState('upi');
  const [bookingStep, setBookingStep] = useState<'form' | 'confirm'>('form');
  const [showMap, setShowMap] = useState(false);
  const [showPhone, setShowPhone] = useState(false);

  const providerId = params?.id;

  useEffect(() => {
    if (!providerId) return;
    loadProvider();
  }, [providerId, user]);

  async function loadProvider() {
    setLoading(true);
    const { data: p } = await supabase
      .from('service_providers')
      .select('*, profiles(full_name, phone, avatar_url), service_categories(name, slug)')
      .eq('id', providerId)
      .single();
    if (p) {
      setProvider(p);
      const [{ data: revs }, { data: wh }, { data: kycData }, { data: fav }] = await Promise.all([
        supabase.from('reviews').select('*, profiles(full_name)').eq('provider_id', providerId).order('created_at', { ascending: false }),
        supabase.from('provider_working_hours').select('*').eq('provider_id', providerId).order('id'),
        supabase.from('provider_kyc').select('*').eq('provider_id', providerId).single(),
        user ? supabase.from('favorites').select('*').eq('provider_id', providerId).eq('user_id', user.id).single() : Promise.resolve({ data: null }),
      ]);
      setReviews(revs || []);
      setWorkingHours(wh || []);
      setKyc(kycData);
      setIsFavorited(!!fav?.data);
    }
    setLoading(false);
  }

  async function toggleFavorite() {
    if (!user) { toast.error('Please sign in to favorite'); return; }
    if (isFavorited) {
      await supabase.from('favorites').delete().eq('provider_id', providerId).eq('user_id', user.id);
      setIsFavorited(false);
      toast.success('Removed from favorites');
    } else {
      await supabase.from('favorites').insert({ provider_id: providerId, user_id: user.id });
      setIsFavorited(true);
      toast.success('Added to favorites');
    }
  }

  async function handleBook() {
    if (!user) { toast.error('Please sign in to book'); return; }
    if (!bookingDate || !bookingTime) { toast.error('Please select date and time'); return; }
    setBookingStep('confirm');
  }

  async function handleConfirmBook() {
    if (!user || !provider) return;
    const { error } = await supabase.from('bookings').insert({
      customer_id: user.id,
      provider_id: providerId,
      category_id: provider.category_id,
      service_type: serviceType,
      scheduled_date: bookingDate,
      scheduled_time: bookingTime,
      hourly_rate: provider.hourly_rate || 0,
      total_amount: (provider.hourly_rate || 0) * 2,
      payment_method: paymentMethod,
      address: provider.city || '',
    });
    if (error) {
      toast.error('Booking failed: ' + error.message);
    } else {
      toast.success('Booking confirmed!');
      setBookingStep('form');
      setBookingDate('');
      setBookingTime('');
    }
  }

  async function handleShare() {
    if (navigator.share) {
      await navigator.share({ title: `${provider?.business_name || 'Provider'} on Seva`, url: window.location.href });
    } else {
      navigator.clipboard.writeText(window.location.href);
      toast.success('Link copied to clipboard');
    }
  }

  const mapEmbedUrl = provider?.latitude && provider?.longitude
    ? `https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d1000!2d${provider.longitude}!3d${provider.latitude}!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2z${provider.latitude}%2C${provider.longitude}!5e0!3m2!1sen!2sin!4v1`
    : `https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d5000!2d${location.lng}!3d${location.lat}!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2z${location.lat}%2C${location.lng}!5e0!3m2!1sen!2sin!4v1`;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#FF9933]/30 border-t-[#FF9933] rounded-full animate-spin" />
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-400 text-lg mb-4">Provider not found</p>
          <Link href="/services" className="text-[#FF9933] hover:text-[#e8872e] text-sm font-medium">Browse services</Link>
        </div>
      </div>
    );
  }

  const totalAmount = (provider.hourly_rate || 0) * 2;
  const distance = (provider.latitude && provider.longitude && location.lat)
    ? getDistanceFromLatLonInKm(location.lat, location.lng, provider.latitude, provider.longitude)
    : null;

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/services" className="inline-flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors group">
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
          Back to Services
        </Link>

        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            {/* Profile Card */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4 mb-6">
                <div className="flex items-start gap-4">
                  <div className="relative flex-shrink-0">
                    <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-[#FF9933] to-[#138808] flex items-center justify-center text-2xl font-black text-white">
                      {(provider.business_name || provider.profiles?.full_name || 'P').slice(0, 2).toUpperCase()}
                    </div>
                    {provider.is_available && (
                      <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h1 className="text-2xl font-black text-white">{provider.business_name || provider.profiles?.full_name || 'Provider'}</h1>
                      {provider.is_verified && <CheckCircle className="w-5 h-5 text-[#138808]" />}
                    </div>
                    <p className="text-[#FF9933] font-semibold mb-2">{provider.service_categories?.name || 'Service'}</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <StarRating rating={provider.rating || 0} size="sm" />
                        <span className="font-bold text-white">{(provider.rating || 0).toFixed(1)}</span>
                        <span className="text-gray-500 text-sm">({provider.total_reviews || 0} reviews)</span>
                      </div>
                      <span className="flex items-center gap-1 text-sm text-gray-400">
                        <MapPin className="w-4 h-4" />{provider.city || 'N/A'}{provider.state ? `, ${provider.state}` : ''}
                      </span>
                      <span className="flex items-center gap-1 text-sm text-gray-400">
                        <Clock className="w-4 h-4" />{provider.experience_years || 0} years
                      </span>
                      {distance !== null && distance !== Infinity && (
                        <span className="flex items-center gap-1 text-sm text-[#138808] font-medium">
                          <Crosshair className="w-4 h-4" />{distance.toFixed(1)} km away
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button onClick={toggleFavorite} className={`p-2.5 rounded-xl border transition-all ${isFavorited ? 'bg-red-900/20 border-red-500/30 text-red-400' : 'border-[#2a2a2a] text-gray-400 hover:border-red-500/30 hover:text-red-400'}`}>
                    <Heart className={`w-5 h-5 ${isFavorited ? 'fill-current' : ''}`} />
                  </button>
                  <button onClick={handleShare} className="p-2.5 rounded-xl border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/30 hover:text-[#FF9933] transition-all">
                    <Share2 className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-[#1e1e1e] rounded-xl p-4 text-center">
                  <p className="text-xl font-black text-white">{provider.total_bookings || 0}</p>
                  <p className="text-xs text-gray-400 mt-0.5">Jobs Done</p>
                </div>
                <div className="bg-[#1e1e1e] rounded-xl p-4 text-center">
                  <p className="text-xl font-black text-[#FF9933]">{(provider.rating || 0).toFixed(1)}</p>
                  <p className="text-xs text-gray-400 mt-0.5">Rating</p>
                </div>
                <div className="bg-[#1e1e1e] rounded-xl p-4 text-center">
                  <p className="text-xl font-black text-[#138808]">{provider.experience_years || 0}y</p>
                  <p className="text-xs text-gray-400 mt-0.5">Experience</p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap mb-4">
                {provider.is_verified && (
                  <span className="flex items-center gap-1.5 bg-[#FF9933]/10 border border-[#FF9933]/20 rounded-full px-3 py-1 text-sm font-medium text-[#FF9933]">
                    <Award className="w-4 h-4" />Verified
                  </span>
                )}
                <span className="flex items-center gap-1.5 bg-[#138808]/10 border border-[#138808]/20 rounded-full px-3 py-1 text-sm font-medium text-[#138808]">
                  <Shield className="w-4 h-4" />KYC Done
                </span>
                <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${provider.is_available ? 'bg-[#22c55e]/10 border border-[#22c55e]/20 text-[#22c55e]' : 'bg-gray-800 text-gray-500'}`}>
                  <span className={`w-2 h-2 rounded-full ${provider.is_available ? 'bg-[#22c55e] animate-pulse' : 'bg-gray-500'}`} />
                  {provider.is_available ? 'Available Now' : 'Currently Busy'}
                </span>
              </div>

              <p className="text-gray-300 text-sm leading-relaxed">{provider.bio || 'A verified professional ready to serve your needs.'}</p>
            </div>

            {/* Contact & Map */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-white text-lg">Location & Contact</h2>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowPhone(!showPhone)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-[#138808]/10 border border-[#138808]/20 rounded-lg text-sm text-[#138808] hover:bg-[#138808]/20 transition-colors"
                  >
                    <Phone className="w-4 h-4" />
                    {showPhone ? (provider.phone || provider.profiles?.phone || 'Contact via app') : 'Show Phone'}
                  </button>
                  <button
                    onClick={() => setShowMap(!showMap)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-[#FF9933]/10 border border-[#FF9933]/20 rounded-lg text-sm text-[#FF9933] hover:bg-[#FF9933]/20 transition-colors"
                  >
                    <Map className="w-4 h-4" />
                    {showMap ? 'Hide Map' : 'View Map'}
                  </button>
                </div>
              </div>
              <div className="space-y-2 text-sm text-gray-400">
                <p className="flex items-center gap-2"><MapPin className="w-4 h-4 text-[#FF9933]" />{provider.work_address || provider.address || provider.city || 'Address not provided'}</p>
                <p className="flex items-center gap-2"><Phone className="w-4 h-4 text-[#FF9933]" />{showPhone ? (provider.phone || provider.profiles?.phone || 'Contact via app') : 'Click Show Phone'}</p>
                {provider.working_days && provider.working_days.length > 0 && (
                  <p className="flex items-center gap-2"><Clock className="w-4 h-4 text-[#FF9933]" />{provider.working_days.join(', ')} | {provider.opening_hours || '09:00'} - {provider.closing_hours || '18:00'}</p>
                )}
              </div>
              {showMap && (
                <div className="mt-4 rounded-xl overflow-hidden border border-[#2a2a2a] h-64">
                  <iframe
                    src={mapEmbedUrl}
                    width="100%"
                    height="100%"
                    style={{ border: 0, filter: 'invert(0.9) hue-rotate(180deg)' }}
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    title="Provider Location"
                  />
                </div>
              )}
            </div>

            {/* Working Hours */}
            {workingHours.length > 0 && (
              <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6">
                <h2 className="font-bold text-white text-lg mb-4">Working Hours</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {workingHours.map((wh) => (
                    <div
                      key={wh.day_of_week}
                      className={`rounded-xl p-3 text-center border ${wh.is_open ? 'bg-[#22c55e]/5 border-[#22c55e]/20' : 'bg-[#1e1e1e] border-[#222] opacity-50'}`}
                    >
                      <p className={`text-sm font-bold ${wh.is_open ? 'text-[#22c55e]' : 'text-gray-500'}`}>{wh.day_of_week}</p>
                      <p className="text-xs text-gray-400 mt-1">{wh.is_open ? `${wh.open_time || '09:00'}-${wh.close_time || '18:00'}` : 'Closed'}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* KYC Details */}
            {kyc && (
              <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6">
                <h2 className="font-bold text-white text-lg mb-4">KYC Verification</h2>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="flex items-center gap-3 bg-[#1e1e1e] rounded-xl p-3">
                    <Shield className="w-5 h-5 text-[#138808]" />
                    <div>
                      <p className="text-sm font-semibold text-white">Aadhaar</p>
                      <p className="text-xs text-gray-400">{kyc.aadhaar_verified ? 'Verified' : 'Pending'}</p>
                    </div>
                    <CheckCircle className="w-4 h-4 text-[#138808] ml-auto" />
                  </div>
                  <div className="flex items-center gap-3 bg-[#1e1e1e] rounded-xl p-3">
                    <Shield className="w-5 h-5 text-[#138808]" />
                    <div>
                      <p className="text-sm font-semibold text-white">PAN</p>
                      <p className="text-xs text-gray-400">{kyc.pan_verified ? 'Verified' : 'Pending'}</p>
                    </div>
                    <CheckCircle className="w-4 h-4 text-[#138808] ml-auto" />
                  </div>
                  <div className="flex items-center gap-3 bg-[#1e1e1e] rounded-xl p-3">
                    <Shield className="w-5 h-5 text-[#138808]" />
                    <div>
                      <p className="text-sm font-semibold text-white">Background Check</p>
                      <p className="text-xs text-gray-400 capitalize">{kyc.background_check_status || 'Pending'}</p>
                    </div>
                    <CheckCircle className={`w-4 h-4 ml-auto ${kyc.background_check_status === 'verified' ? 'text-[#138808]' : 'text-gray-600'}`} />
                  </div>
                  <div className="flex items-center gap-3 bg-[#1e1e1e] rounded-xl p-3">
                    <Shield className="w-5 h-5 text-[#138808]" />
                    <div>
                      <p className="text-sm font-semibold text-white">Police Verification</p>
                      <p className="text-xs text-gray-400 capitalize">{kyc.police_verification_status || 'Pending'}</p>
                    </div>
                    <CheckCircle className={`w-4 h-4 ml-auto ${kyc.police_verification_status === 'verified' ? 'text-[#138808]' : 'text-gray-600'}`} />
                  </div>
                </div>
              </div>
            )}

            {/* Reviews */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="font-bold text-white text-lg">Customer Reviews</h2>
                <div className="flex items-center gap-2">
                  <StarRating rating={provider.rating || 0} />
                  <span className="text-white font-bold">{(provider.rating || 0).toFixed(1)}</span>
                  <span className="text-gray-500 text-sm">/ 5</span>
                </div>
              </div>
              {reviews.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">No reviews yet. Be the first to review!</p>
              ) : (
                <div className="space-y-5">
                  {reviews.map((r, i) => (
                    <div key={i} className="pb-5 border-b border-[#222] last:border-0 last:pb-0">
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#FF9933] to-[#138808] flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                          {(r.profiles?.full_name || 'C').slice(0, 2).toUpperCase()}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-semibold text-white">{r.profiles?.full_name || 'Customer'}</span>
                            <span className="text-xs text-gray-500">{new Date(r.created_at).toLocaleDateString('en-IN')}</span>
                          </div>
                          <StarRating rating={r.rating} />
                          <p className="text-sm text-gray-300 mt-2 leading-relaxed">{r.comment}</p>
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
                  {(provider.hourly_rate || 0) > 0 && (
                    <p className="text-[#FF9933] font-black text-2xl mb-5">Rs {provider.hourly_rate}<span className="text-sm font-normal text-gray-400">/hour</span></p>
                  )}

                  <div className="space-y-4 mb-5">
                    <div>
                      <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-2">Service Type</label>
                      <div className="grid grid-cols-2 gap-2">
                        {['one-time', 'weekly', 'monthly', 'yearly'].map((t) => (
                          <button key={t} onClick={() => setServiceType(t)} className={`py-2 rounded-lg text-xs font-medium capitalize transition-all ${serviceType === t ? 'bg-[#FF9933] text-white' : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/50'}`}>
                            {t}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-2">Date</label>
                      <div className="flex items-center gap-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5">
                        <Calendar className="w-4 h-4 text-gray-500" />
                        <input type="date" value={bookingDate} onChange={(e) => setBookingDate(e.target.value)} min={new Date().toISOString().split('T')[0]} className="flex-1 bg-transparent text-white text-sm focus:outline-none" />
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-2">Time</label>
                      <div className="grid grid-cols-3 gap-2">
                        {['9:00 AM', '11:00 AM', '2:00 PM', '4:00 PM', '6:00 PM', '8:00 PM'].map((t) => (
                          <button key={t} onClick={() => setBookingTime(t)} className={`py-2 rounded-lg text-xs font-medium transition-all ${bookingTime === t ? 'bg-[#FF9933] text-white' : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/50'}`}>
                            {t}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-2">Payment</label>
                      <div className="space-y-2">
                        {[
                          { value: 'upi', label: 'UPI (GPay, PhonePe)', icon: <Smartphone className="w-4 h-4" /> },
                          { value: 'wallet', label: 'Seva Wallet', icon: <Wallet className="w-4 h-4" /> },
                          { value: 'cod', label: 'Cash on Delivery', icon: <Banknote className="w-4 h-4" /> },
                        ].map((pm) => (
                          <button key={pm.value} onClick={() => setPaymentMethod(pm.value)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-sm transition-all ${paymentMethod === pm.value ? 'bg-[#FF9933]/10 border-[#FF9933]/40 text-white' : 'bg-[#1e1e1e] border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/30'}`}>
                            {pm.icon}<span>{pm.label}</span>
                            {paymentMethod === pm.value && <CheckCircle className="w-4 h-4 text-[#FF9933] ml-auto" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {(provider.hourly_rate || 0) > 0 && (
                    <div className="bg-[#1e1e1e] rounded-xl p-3 mb-4">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-400">Rs {provider.hourly_rate} x 2 hrs</span>
                        <span className="text-white">Rs {totalAmount}</span>
                      </div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-400">Platform fee</span>
                        <span className="text-white">Rs 0</span>
                      </div>
                      <div className="flex justify-between text-sm font-bold border-t border-[#2a2a2a] pt-2 mt-2">
                        <span className="text-white">Total</span>
                        <span className="text-[#FF9933]">Rs {totalAmount}</span>
                      </div>
                    </div>
                  )}

                  <button onClick={handleBook} className="saffron-btn w-full rounded-xl py-3.5 font-semibold text-sm">
                    {user ? 'Book Now' : 'Sign In to Book'}
                  </button>
                  <div className="flex items-center gap-2 mt-4 justify-center">
                    <Shield className="w-4 h-4 text-[#138808]" />
                    <p className="text-xs text-gray-500">Secure booking · KYC verified</p>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="font-bold text-white text-lg mb-5">Confirm Booking</h3>
                  <div className="space-y-3 mb-5">
                    <div className="flex justify-between text-sm"><span className="text-gray-400">Provider</span><span className="text-white font-medium">{provider.business_name || provider.profiles?.full_name}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-gray-400">Service</span><span className="text-white font-medium">{provider.service_categories?.name}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-gray-400">Date</span><span className="text-white font-medium">{bookingDate}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-gray-400">Time</span><span className="text-white font-medium">{bookingTime}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-gray-400">Type</span><span className="text-white font-medium capitalize">{serviceType}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-gray-400">Payment</span><span className="text-white font-medium capitalize">{paymentMethod}</span></div>
                    {(provider.hourly_rate || 0) > 0 && (
                      <div className="flex justify-between text-sm font-bold pt-2 border-t border-[#222]">
                        <span className="text-white">Total</span>
                        <span className="text-[#FF9933]">Rs {totalAmount}</span>
                      </div>
                    )}
                  </div>
                  <button onClick={handleConfirmBook} className="saffron-btn w-full rounded-xl py-3.5 font-semibold text-sm mb-2">Confirm Booking</button>
                  <button onClick={() => setBookingStep('form')} className="w-full py-3 text-sm text-gray-400 hover:text-white transition-colors">Go Back</button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
