'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Star, MapPin, Clock, CheckCircle, ArrowLeft, Shield, Calendar, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

export default function ProviderDetailPage() {
  const params = useParams<{ id: string }>();
  const { user } = useAuth();
  const [provider, setProvider] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [bookingDate, setBookingDate] = useState('');
  const [bookingTime, setBookingTime] = useState('');
  const [step, setStep] = useState<'info' | 'confirm'>('info');

  const providerId = params?.id;

  useEffect(() => {
    if (!providerId) return;
    supabase
      .from('service_providers')
      .select('*, profiles(full_name), service_categories(name)')
      .eq('id', providerId)
      .single()
      .then(({ data }) => {
        setProvider(data);
        setLoading(false);
      });
  }, [providerId]);

  async function handleBook() {
    if (!user) { toast.error('Please sign in'); return; }
    if (!bookingDate || !bookingTime) { toast.error('Select date and time'); return; }
    const { error } = await supabase.from('bookings').insert({
      customer_id: user.id,
      provider_id: providerId,
      category_id: provider.category_id,
      scheduled_date: bookingDate,
      scheduled_time: bookingTime,
      hourly_rate: provider.hourly_rate || 0,
      total_amount: (provider.hourly_rate || 0) * 2,
      address: provider.city || '',
    });
    if (error) {
      toast.error('Booking failed');
    } else {
      toast.success('Booking confirmed!');
      setStep('info');
      setBookingDate('');
      setBookingTime('');
    }
  }

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
        <p className="text-gray-400">Provider not found</p>
      </div>
    );
  }

  const total = (provider.hourly_rate || 0) * 2;

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/services" className="inline-flex items-center gap-2 text-gray-400 hover:text-white mb-6 text-sm">
          <ArrowLeft className="w-4 h-4" />Back to Services
        </Link>

        <div className="grid lg:grid-cols-2 gap-8">
          {/* Info */}
          <div className="space-y-6">
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6">
              <div className="flex items-start gap-4 mb-4">
                <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-[#FF9933] to-[#138808] flex items-center justify-center text-xl font-black text-white">
                  {(provider.business_name || provider.profiles?.full_name || 'P').slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h1 className="text-xl font-bold text-white">{provider.business_name || provider.profiles?.full_name || 'Provider'}</h1>
                  <p className="text-sm text-[#FF9933]">{provider.service_categories?.name}</p>
                  <div className="flex items-center gap-3 mt-2 text-sm text-gray-400">
                    <span className="flex items-center gap-1"><Star className="w-3 h-3 fill-[#FF9933] text-[#FF9933]" />{(provider.rating || 0).toFixed(1)}</span>
                    <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{provider.city || 'N/A'}</span>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{provider.experience_years || 0}y</span>
                  </div>
                </div>
              </div>

              <div className="flex gap-2 mb-4">
                {provider.is_verified && (
                  <span className="flex items-center gap-1 text-xs bg-[#138808]/10 text-[#138808] px-2 py-1 rounded-full">
                    <CheckCircle className="w-3 h-3" />Verified
                  </span>
                )}
                <span className="flex items-center gap-1 text-xs bg-[#22c55e]/10 text-[#22c55e] px-2 py-1 rounded-full">
                  <Shield className="w-3 h-3" />KYC
                </span>
              </div>

              <p className="text-sm text-gray-400">{provider.bio || 'A verified professional.'}</p>
            </div>
          </div>

          {/* Booking */}
          <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6 h-fit">
            {step === 'info' ? (
              <>
                <h3 className="font-bold text-white mb-4">Book Now</h3>
                {(provider.hourly_rate || 0) > 0 && (
                  <p className="text-[#FF9933] font-bold text-xl mb-4">Rs {provider.hourly_rate}<span className="text-sm font-normal text-gray-400">/hr</span></p>
                )}

                <div className="space-y-4 mb-4">
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Date</label>
                    <div className="flex items-center gap-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2">
                      <Calendar className="w-4 h-4 text-gray-500" />
                      <input type="date" value={bookingDate} onChange={(e) => setBookingDate(e.target.value)} min={new Date().toISOString().split('T')[0]} className="bg-transparent text-white text-sm flex-1 focus:outline-none" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Time</label>
                    <div className="grid grid-cols-3 gap-2">
                      {['9:00 AM', '11:00 AM', '2:00 PM', '4:00 PM', '6:00 PM', '8:00 PM'].map((t) => (
                        <button key={t} onClick={() => setBookingTime(t)} className={`py-2 rounded-lg text-xs ${bookingTime === t ? 'bg-[#FF9933] text-white' : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-400'}`}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {(provider.hourly_rate || 0) > 0 && (
                  <div className="bg-[#1e1e1e] rounded-xl p-3 mb-4 text-sm">
                    <div className="flex justify-between text-gray-400 mb-1"><span>Rs {provider.hourly_rate} x 2 hrs</span><span>Rs {total}</span></div>
                    <div className="flex justify-between font-bold text-white pt-2 border-t border-[#2a2a2a]"><span>Total</span><span className="text-[#FF9933]">Rs {total}</span></div>
                  </div>
                )}

                <button onClick={() => setStep('confirm')} className="saffron-btn w-full rounded-xl py-3 font-semibold text-sm">
                  {user ? 'Book Now' : 'Sign In to Book'}
                </button>
              </>
            ) : (
              <>
                <h3 className="font-bold text-white mb-4">Confirm</h3>
                <div className="space-y-2 text-sm mb-4">
                  <div className="flex justify-between"><span className="text-gray-400">Provider</span><span className="text-white">{provider.business_name || provider.profiles?.full_name}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Date</span><span className="text-white">{bookingDate}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Time</span><span className="text-white">{bookingTime}</span></div>
                  {(provider.hourly_rate || 0) > 0 && (
                    <div className="flex justify-between font-bold pt-2 border-t border-[#2a2a2a]"><span className="text-white">Total</span><span className="text-[#FF9933]">Rs {total}</span></div>
                  )}
                </div>
                <button onClick={handleBook} className="saffron-btn w-full rounded-xl py-3 font-semibold text-sm mb-2">Confirm</button>
                <button onClick={() => setStep('info')} className="w-full py-2 text-sm text-gray-400">Back</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
