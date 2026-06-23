'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Star, MapPin, Clock, CheckCircle, ArrowLeft, Heart, Share2,
  Phone, MessageCircle, Calendar, Wallet, Banknote, Truck,
  Shield, Award, ThumbsUp
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

const mockProviders: Record<string, {
  id: string; name: string; category: string; rating: number; reviews: number;
  rate: number; exp: number; city: string; state: string; verified: boolean;
  available: boolean; avatar: string; gradient: string; bio: string; bookings: number;
  badge: string; specialties: string[]; languages: string[]; reviewsList: {name: string; rating: number; comment: string; date: string; avatar: string; color: string}[];
}> = {
  '1': {
    id: '1', name: 'Amit Sharma', category: 'Electrician', rating: 4.9, reviews: 156,
    rate: 350, exp: 8, city: 'Mumbai', state: 'MH', verified: true, available: true,
    avatar: 'AS', gradient: 'from-amber-500 to-orange-600', bookings: 847, badge: 'Top Rated',
    bio: 'I am a certified electrician with 8+ years of experience in home and commercial electrical work. I specialize in wiring, switchboard repairs, fan installations, inverter setups, and complete home rewiring. I use only ISI-marked materials and provide 6-month warranty on all work.',
    specialties: ['Home Wiring', 'Switchboard Repair', 'Fan Installation', 'Inverter Setup', 'MCB & Fuse'],
    languages: ['Hindi', 'Marathi', 'English'],
    reviewsList: [
      { name: 'Rohit Joshi', rating: 5, comment: 'Excellent work! Fixed my short circuit issue quickly and explained everything. Very professional.', date: '2 days ago', avatar: 'RJ', color: 'from-blue-500 to-cyan-500' },
      { name: 'Sneha Kulkarni', rating: 5, comment: 'Amit installed 4 fans in my new flat. Clean work, on time, reasonable price. Highly recommend!', date: '1 week ago', avatar: 'SK', color: 'from-pink-500 to-rose-500' },
      { name: 'Vikram Patil', rating: 4, comment: 'Good work overall. Slight delay but the quality of work was excellent. Would hire again.', date: '2 weeks ago', avatar: 'VP', color: 'from-green-500 to-emerald-500' },
    ],
  },
  '2': {
    id: '2', name: 'Priya Patel', category: 'House Cleaning', rating: 4.8, reviews: 203,
    rate: 250, exp: 5, city: 'Mumbai', state: 'MH', verified: true, available: true,
    avatar: 'PP', gradient: 'from-pink-500 to-rose-600', bookings: 654, badge: 'Super Provider',
    bio: 'Professional house cleaning expert with 5 years of experience. I offer deep cleaning, regular maintenance, post-renovation cleaning, and move-in/move-out cleaning. I bring my own eco-friendly cleaning supplies and follow a systematic room-by-room approach.',
    specialties: ['Deep Cleaning', 'Regular Maintenance', 'Post-Renovation', 'Bathroom Cleaning', 'Kitchen Scrub'],
    languages: ['Hindi', 'Gujarati', 'English'],
    reviewsList: [
      { name: 'Meera Shah', rating: 5, comment: 'My house was spotless after Priya left. She is thorough, trustworthy and very hardworking.', date: '3 days ago', avatar: 'MS', color: 'from-purple-500 to-violet-500' },
      { name: 'Amit Kapoor', rating: 5, comment: 'Excellent deep cleaning service. Every corner was cleaned perfectly. Will book again!', date: '1 week ago', avatar: 'AK', color: 'from-orange-500 to-amber-500' },
      { name: 'Ritu Nair', rating: 4, comment: 'Very professional. The kitchen and bathrooms especially were sparkling clean.', date: '2 weeks ago', avatar: 'RN', color: 'from-teal-500 to-cyan-500' },
    ],
  },
  '3': {
    id: '3', name: 'Ravi Kumar', category: 'Plumber', rating: 4.9, reviews: 89,
    rate: 300, exp: 10, city: 'Pune', state: 'MH', verified: true, available: true,
    avatar: 'RK', gradient: 'from-blue-500 to-cyan-600', bookings: 423, badge: 'Verified Expert',
    bio: '10 years of plumbing experience. I handle everything from minor leaks to complete bathroom installations. Specialize in pipeline work, geyser installations, bathroom fittings, and drainage solutions. Emergency services available 24/7.',
    specialties: ['Pipe Leaks', 'Bathroom Fitting', 'Geyser Installation', 'Drainage', 'Emergency Repairs'],
    languages: ['Hindi', 'Marathi'],
    reviewsList: [
      { name: 'Suresh Deshpande', rating: 5, comment: 'Ravi fixed a major pipe burst at midnight. Very responsive and professional. Lifesaver!', date: '1 week ago', avatar: 'SD', color: 'from-blue-500 to-indigo-500' },
      { name: 'Ananya Joshi', rating: 5, comment: 'Got my entire bathroom fitted by Ravi. Excellent workmanship and competitive pricing.', date: '2 weeks ago', avatar: 'AJ', color: 'from-rose-500 to-pink-500' },
      { name: 'Mohan Rane', rating: 4, comment: 'Good work, fixed the drainage issue efficiently. Will hire again.', date: '3 weeks ago', avatar: 'MR', color: 'from-green-500 to-teal-500' },
    ],
  },
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

export default function ProviderDetailPage({ params }: { params: { id: string } }) {
  const provider = mockProviders[params.id] || mockProviders['1'];
  const { user } = useAuth();
  const router = useRouter();
  const [bookingDate, setBookingDate] = useState('');
  const [bookingTime, setBookingTime] = useState('');
  const [serviceType, setServiceType] = useState('one-time');
  const [paymentMethod, setPaymentMethod] = useState('upi');
  const [isFavorited, setIsFavorited] = useState(false);
  const [bookingStep, setBookingStep] = useState<'form' | 'confirm'>('form');

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

  const handleConfirmBook = () => {
    toast.success('Booking confirmed! The provider will contact you shortly.');
    router.push('/bookings');
  };

  const totalAmount = provider.rate > 0 ? provider.rate * 2 : 0;

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
                    <div className={`w-20 h-20 rounded-2xl bg-gradient-to-br ${provider.gradient} flex items-center justify-center text-2xl font-black text-white`}>
                      {provider.avatar}
                    </div>
                    {provider.available && (
                      <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h1 className="text-2xl font-black text-white">{provider.name}</h1>
                      {provider.verified && <CheckCircle className="w-5 h-5 text-[#138808]" />}
                    </div>
                    <p className="text-[#FF9933] font-semibold mb-2">{provider.category}</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <StarRating rating={provider.rating} size="sm" />
                        <span className="font-bold text-white">{provider.rating}</span>
                        <span className="text-gray-500 text-sm">({provider.reviews} reviews)</span>
                      </div>
                      <span className="flex items-center gap-1 text-sm text-gray-400">
                        <MapPin className="w-4 h-4" />{provider.city}, {provider.state}
                      </span>
                      <span className="flex items-center gap-1 text-sm text-gray-400">
                        <Clock className="w-4 h-4" />{provider.exp} years exp.
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
                  <p className="text-xl font-black text-white">{provider.bookings}+</p>
                  <p className="text-xs text-gray-400 mt-0.5">Jobs Done</p>
                </div>
                <div className="bg-[#1e1e1e] rounded-xl p-4 text-center">
                  <p className="text-xl font-black text-[#FF9933]">{provider.rating}</p>
                  <p className="text-xs text-gray-400 mt-0.5">Avg Rating</p>
                </div>
                <div className="bg-[#1e1e1e] rounded-xl p-4 text-center">
                  <p className="text-xl font-black text-[#138808]">{provider.exp}y</p>
                  <p className="text-xs text-gray-400 mt-0.5">Experience</p>
                </div>
              </div>

              {/* Badge */}
              <div className="flex items-center gap-2 mb-4">
                <span className="flex items-center gap-1.5 bg-[#FF9933]/10 border border-[#FF9933]/20 rounded-full px-3 py-1 text-sm font-medium text-[#FF9933]">
                  <Award className="w-4 h-4" />{provider.badge}
                </span>
                <span className="flex items-center gap-1.5 bg-[#138808]/10 border border-[#138808]/20 rounded-full px-3 py-1 text-sm font-medium text-[#138808]">
                  <Shield className="w-4 h-4" />Verified
                </span>
                <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${provider.available ? 'bg-[#22c55e]/10 border border-[#22c55e]/20 text-[#22c55e]' : 'bg-gray-800 text-gray-500'}`}>
                  <span className={`w-2 h-2 rounded-full ${provider.available ? 'bg-[#22c55e] animate-pulse' : 'bg-gray-500'}`} />
                  {provider.available ? 'Available Now' : 'Currently Busy'}
                </span>
              </div>

              {/* Bio */}
              <p className="text-gray-300 text-sm leading-relaxed">{provider.bio}</p>
            </div>

            {/* Specialties */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6">
              <h2 className="font-bold text-white text-lg mb-4">Specialties</h2>
              <div className="flex flex-wrap gap-2">
                {provider.specialties.map((s) => (
                  <span key={s} className="px-3 py-1.5 bg-[#FF9933]/10 border border-[#FF9933]/20 rounded-lg text-sm text-[#FF9933]">
                    {s}
                  </span>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-[#222]">
                <h3 className="text-sm font-medium text-gray-300 mb-2">Languages</h3>
                <div className="flex gap-2">
                  {provider.languages.map((l) => (
                    <span key={l} className="px-3 py-1.5 bg-[#1e1e1e] rounded-lg text-sm text-gray-300">{l}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Reviews */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="font-bold text-white text-lg">Customer Reviews</h2>
                <div className="flex items-center gap-2">
                  <StarRating rating={provider.rating} />
                  <span className="text-white font-bold">{provider.rating}</span>
                  <span className="text-gray-500 text-sm">/ 5</span>
                </div>
              </div>
              <div className="space-y-5">
                {provider.reviewsList.map((r, i) => (
                  <div key={i} className="pb-5 border-b border-[#222] last:border-0 last:pb-0">
                    <div className="flex items-start gap-3">
                      <div className={`w-9 h-9 rounded-full bg-gradient-to-br ${r.color} flex items-center justify-center text-xs font-bold text-white flex-shrink-0`}>
                        {r.avatar}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-white">{r.name}</span>
                            <CheckCircle className="w-3.5 h-3.5 text-[#138808]" />
                          </div>
                          <span className="text-xs text-gray-500">{r.date}</span>
                        </div>
                        <StarRating rating={r.rating} />
                        <p className="text-sm text-gray-300 mt-2 leading-relaxed">{r.comment}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Booking Sidebar */}
          <div className="lg:col-span-1">
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 sticky top-24">
              {bookingStep === 'form' ? (
                <>
                  <h3 className="font-bold text-white text-lg mb-1">Book This Provider</h3>
                  {provider.rate > 0 && (
                    <p className="text-[#FF9933] font-black text-2xl mb-5">₹{provider.rate}<span className="text-sm font-normal text-gray-400">/hour</span></p>
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
                        {['9:00 AM', '11:00 AM', '2:00 PM', '4:00 PM', '6:00 PM', '8:00 PM'].map((t) => (
                          <button
                            key={t}
                            onClick={() => setBookingTime(t)}
                            className={`py-2 rounded-lg text-xs font-medium transition-all ${bookingTime === t ? 'bg-[#FF9933] text-white' : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/50'}`}
                          >
                            {t}
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

                  {provider.rate > 0 && (
                    <div className="bg-[#1e1e1e] rounded-xl p-3 mb-4">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-400">₹{provider.rate} × 2 hours</span>
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
                      <span className="text-white font-medium">{provider.name}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Service</span>
                      <span className="text-white font-medium">{provider.category}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Date</span>
                      <span className="text-white font-medium">{bookingDate}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Time</span>
                      <span className="text-white font-medium">{bookingTime}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Type</span>
                      <span className="text-white font-medium capitalize">{serviceType}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Payment</span>
                      <span className="text-white font-medium capitalize">{paymentMethod}</span>
                    </div>
                    {provider.rate > 0 && (
                      <div className="flex justify-between text-sm font-bold pt-2 border-t border-[#222]">
                        <span className="text-white">Total Amount</span>
                        <span className="text-[#FF9933]">₹{totalAmount}</span>
                      </div>
                    )}
                  </div>
                  <button onClick={handleConfirmBook} className="saffron-btn w-full rounded-xl py-3.5 font-semibold text-sm mb-2">
                    Confirm & Pay
                  </button>
                  <button onClick={() => setBookingStep('form')} className="w-full py-3 text-sm text-gray-400 hover:text-white transition-colors">
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
