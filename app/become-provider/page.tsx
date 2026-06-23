'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle, ArrowRight, Zap, Wrench, ChefHat, Sparkles, Heart, Car,
  Stethoscope, GraduationCap, Settings, Hammer, Leaf, Scissors,
  ShoppingBasket, Truck, Shield, TrendingUp, Users, Award
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';

const categories = [
  { icon: Zap, name: 'Electrician', slug: 'electrician', color: '#FF9933' },
  { icon: Wrench, name: 'Plumber', slug: 'plumber', color: '#3b82f6' },
  { icon: ChefHat, name: 'Home Cook / Tiffin', slug: 'home-cook', color: '#ef4444' },
  { icon: Sparkles, name: 'House Cleaning', slug: 'house-cleaning', color: '#22c55e' },
  { icon: Heart, name: 'Caretaker', slug: 'caretaker', color: '#ec4899' },
  { icon: Car, name: 'Driver', slug: 'driver', color: '#94a3b8' },
  { icon: Stethoscope, name: 'Doctor', slug: 'doctor', color: '#14b8a6' },
  { icon: GraduationCap, name: 'Tutor', slug: 'tutor', color: '#a855f7' },
  { icon: Settings, name: 'Appliance Repair', slug: 'appliance-repair', color: '#6366f1' },
  { icon: Hammer, name: 'Carpenter', slug: 'carpenter', color: '#f59e0b' },
  { icon: Leaf, name: 'Gardening', slug: 'gardening', color: '#84cc16' },
  { icon: Scissors, name: 'Beauty & Wellness', slug: 'beauty', color: '#f43f5e' },
  { icon: ShoppingBasket, name: 'Farm Fresh', slug: 'farm-fresh', color: '#10b981' },
  { icon: Truck, name: 'Delivery', slug: 'delivery', color: '#f97316' },
];

const benefits = [
  { icon: TrendingUp, title: 'Grow Your Income', desc: 'Earn ₹15,000-₹80,000+ per month depending on your skills and availability.' },
  { icon: Users, title: 'Large Customer Base', desc: 'Access thousands of verified customers actively looking for your services.' },
  { icon: Shield, title: 'Safe & Secure', desc: 'All customers are verified. Get payment protection and dispute resolution.' },
  { icon: Award, title: 'Build Your Reputation', desc: 'Earn verified reviews and badges to stand out and attract more customers.' },
];

const steps = [
  { num: '01', title: 'Apply', desc: 'Fill out the provider application with your details and service category.' },
  { num: '02', title: 'Get Verified', desc: 'Submit documents for background check. Usually takes 24-48 hours.' },
  { num: '03', title: 'Go Live', desc: 'Once approved, your profile goes live and customers can book you.' },
  { num: '04', title: 'Earn', desc: 'Complete services, collect payments, and build your reputation.' },
];

export default function BecomeProviderPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    category: '',
    businessName: '',
    bio: '',
    experience: '',
    hourlyRate: '',
    city: '',
    state: '',
    phone: '',
    aadhar: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!user) {
      router.push('/auth/signup');
      return;
    }
    if (!form.category || !form.businessName || !form.city) {
      toast.error('Please fill all required fields');
      return;
    }
    setSubmitting(true);
    await new Promise(r => setTimeout(r, 2000));
    setSubmitting(false);
    setSubmitted(true);
    toast.success('Application submitted! We will review it within 24 hours.');
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center px-4">
        <div className="text-center max-w-lg">
          <div className="w-24 h-24 rounded-full bg-[#138808]/10 border-2 border-[#138808]/30 flex items-center justify-center mx-auto mb-6">
            <CheckCircle className="w-12 h-12 text-[#138808]" />
          </div>
          <h2 className="text-3xl font-black text-white mb-3">Application Submitted!</h2>
          <p className="text-gray-400 mb-8">Our team will review your application within 24-48 hours. You'll receive an email once approved.</p>
          <Link href="/" className="saffron-btn px-8 py-3.5 rounded-xl font-semibold text-sm inline-block">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-16">
      {/* Hero */}
      <section className="relative py-20 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-0 w-96 h-96 bg-[#FF9933]/8 rounded-full blur-[100px]" />
          <div className="absolute bottom-0 right-0 w-96 h-96 bg-[#138808]/8 rounded-full blur-[100px]" />
        </div>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative">
          <div className="inline-flex items-center gap-2 bg-[#FF9933]/10 border border-[#FF9933]/20 rounded-full px-4 py-1.5 mb-6">
            <span className="text-[#FF9933] text-sm font-medium">Join 10,000+ providers on Seva</span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-black text-white mb-6">
            Turn Your Skills Into<br />
            <span className="text-[#FF9933]">Steady Income</span>
          </h1>
          <p className="text-gray-400 text-lg mb-10 max-w-2xl mx-auto">
            Join India's fastest growing service marketplace. Set your own schedule, prices, and build a thriving business.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-2xl mx-auto">
            {[
              { value: '₹45K', label: 'Avg Monthly Earnings' },
              { value: '10K+', label: 'Active Providers' },
              { value: '24hrs', label: 'Verification Time' },
              { value: '0%', label: 'Joining Fee' },
            ].map((s) => (
              <div key={s.label} className="bg-[#161616] border border-[#2a2a2a] rounded-xl p-4 text-center">
                <p className="text-xl font-black text-[#FF9933]">{s.value}</p>
                <p className="text-xs text-gray-400 mt-1">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="py-16 bg-[#0a0a0a]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-black text-white mb-8 text-center">Why Join Seva?</h2>
          <div className="grid md:grid-cols-4 gap-5">
            {benefits.map((b) => (
              <div key={b.title} className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
                <div className="w-10 h-10 rounded-xl bg-[#FF9933]/10 flex items-center justify-center mb-4">
                  <b.icon className="w-5 h-5 text-[#FF9933]" />
                </div>
                <h3 className="font-bold text-white mb-2">{b.title}</h3>
                <p className="text-sm text-gray-400 leading-relaxed">{b.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Application Form */}
      <section className="py-16 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10">
          <h2 className="text-2xl font-black text-white mb-2">Apply to Become a Provider</h2>
          <p className="text-gray-400">It takes less than 5 minutes</p>
        </div>

        {/* Steps Progress */}
        <div className="flex items-center justify-center gap-3 mb-10">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${step >= s ? 'bg-[#FF9933] text-white' : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-500'}`}>
                {step > s ? <CheckCircle className="w-4 h-4" /> : s}
              </div>
              {s < 3 && <div className={`w-16 h-0.5 ${step > s ? 'bg-[#FF9933]' : 'bg-[#2a2a2a]'}`} />}
            </div>
          ))}
        </div>

        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-8">
          {step === 1 && (
            <div>
              <h3 className="font-bold text-white text-lg mb-6">Step 1: Choose Your Service</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
                {categories.map((cat) => (
                  <button
                    key={cat.slug}
                    onClick={() => setForm({ ...form, category: cat.slug })}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-sm font-medium transition-all ${form.category === cat.slug ? 'border-[#FF9933]/60 bg-[#FF9933]/10 text-white' : 'border-[#2a2a2a] bg-[#1e1e1e] text-gray-400 hover:border-[#FF9933]/40'}`}
                  >
                    <cat.icon className="w-4 h-4 flex-shrink-0" style={{ color: form.category === cat.slug ? '#FF9933' : cat.color }} />
                    <span className="text-xs">{cat.name}</span>
                    {form.category === cat.slug && <CheckCircle className="w-3.5 h-3.5 text-[#FF9933] ml-auto" />}
                  </button>
                ))}
              </div>
              <button
                onClick={() => form.category && setStep(2)}
                disabled={!form.category}
                className="saffron-btn w-full rounded-xl py-3.5 font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
              >
                Next Step <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {step === 2 && (
            <div>
              <h3 className="font-bold text-white text-lg mb-6">Step 2: Your Business Details</h3>
              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Business / Display Name *</label>
                  <input
                    value={form.businessName}
                    onChange={(e) => setForm({ ...form, businessName: e.target.value })}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                    placeholder="e.g., Ramesh Electricals"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">About You / Bio</label>
                  <textarea
                    value={form.bio}
                    onChange={(e) => setForm({ ...form, bio: e.target.value })}
                    rows={3}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933] resize-none"
                    placeholder="Describe your experience and skills..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Experience (years)</label>
                    <input
                      type="number"
                      value={form.experience}
                      onChange={(e) => setForm({ ...form, experience: e.target.value })}
                      className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                      placeholder="5"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Hourly Rate (₹)</label>
                    <input
                      type="number"
                      value={form.hourlyRate}
                      onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
                      className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                      placeholder="300"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">City *</label>
                    <input
                      value={form.city}
                      onChange={(e) => setForm({ ...form, city: e.target.value })}
                      className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                      placeholder="Mumbai"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">State</label>
                    <input
                      value={form.state}
                      onChange={(e) => setForm({ ...form, state: e.target.value })}
                      className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                      placeholder="Maharashtra"
                    />
                  </div>
                </div>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setStep(1)} className="flex-1 py-3 border border-[#2a2a2a] rounded-xl text-sm text-gray-300 hover:text-white transition-colors">Back</button>
                <button onClick={() => form.businessName && form.city && setStep(3)} disabled={!form.businessName || !form.city} className="saffron-btn flex-1 rounded-xl py-3 font-semibold flex items-center justify-center gap-2 disabled:opacity-40">
                  Next <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h3 className="font-bold text-white text-lg mb-6">Step 3: Verification Documents</h3>
              <div className="space-y-4 mb-6">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Phone Number *</label>
                  <input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                    placeholder="+91 98765 43210"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Aadhaar Number</label>
                  <input
                    value={form.aadhar}
                    onChange={(e) => setForm({ ...form, aadhar: e.target.value })}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                    placeholder="XXXX XXXX XXXX"
                  />
                </div>
                <div className="p-4 bg-[#FF9933]/5 border border-[#FF9933]/15 rounded-xl">
                  <p className="text-xs text-gray-400">By submitting, you agree that all information provided is accurate. Fake details will result in permanent ban. Your data is securely stored and never shared.</p>
                </div>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setStep(2)} className="flex-1 py-3 border border-[#2a2a2a] rounded-xl text-sm text-gray-300 hover:text-white transition-colors">Back</button>
                <button onClick={handleSubmit} disabled={submitting} className="saffron-btn flex-1 rounded-xl py-3 font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
                  {submitting ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'Submit Application'}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* How it works for providers */}
      <section className="py-16 bg-[#0a0a0a]">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-black text-white mb-8 text-center">How It Works</h2>
          <div className="grid md:grid-cols-4 gap-6">
            {steps.map((s, i) => (
              <div key={s.num} className="text-center">
                <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#FF9933] to-[#138808] flex items-center justify-center font-black text-white text-lg mx-auto mb-4 shadow-lg shadow-[#FF9933]/20">
                  {s.num}
                </div>
                <h3 className="font-bold text-white mb-2">{s.title}</h3>
                <p className="text-sm text-gray-400 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
