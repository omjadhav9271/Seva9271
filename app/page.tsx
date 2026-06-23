'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Search, MapPin, Star, CheckCircle, Shield, Clock, Users, Zap, Wrench,
  ChefHat, Sparkles, Heart, Car, Stethoscope, GraduationCap, Settings,
  Hammer, Leaf, Scissors, ShoppingBasket, Truck, ArrowRight, Award,
  CreditCard, MessageCircle
} from 'lucide-react';

const categories = [
  { icon: Zap, name: 'Electrician', desc: 'Wiring, repairs, installations', slug: 'electrician', bg: '#FF9933', cardBg: 'rgba(40,30,8,0.9)' },
  { icon: Wrench, name: 'Plumber', desc: 'Pipes, leaks, bathroom fixes', slug: 'plumber', bg: '#3b82f6', cardBg: 'rgba(10,20,40,0.9)' },
  { icon: ChefHat, name: 'Home Cook / Tiffin', desc: 'Fresh meals, tiffin service', slug: 'home-cook', bg: '#ef4444', cardBg: 'rgba(40,8,8,0.9)' },
  { icon: Sparkles, name: 'House Cleaning', desc: 'Deep cleaning, maintenance', slug: 'house-cleaning', bg: '#22c55e', cardBg: 'rgba(8,30,15,0.9)' },
  { icon: Heart, name: 'Caretaker / Elderly Care', desc: 'Elderly care, companionship', slug: 'caretaker', bg: '#ec4899', cardBg: 'rgba(35,8,25,0.9)' },
  { icon: Car, name: 'Driver / Car Rental', desc: 'Personal driver, car rental', slug: 'driver', bg: '#94a3b8', cardBg: 'rgba(18,22,28,0.9)' },
  { icon: Stethoscope, name: 'Home-Visit Doctor', desc: 'Medical consultation at home', slug: 'doctor', bg: '#14b8a6', cardBg: 'rgba(6,28,26,0.9)' },
  { icon: GraduationCap, name: 'Tutor / Coaching', desc: 'Academic tutoring, skills', slug: 'tutor', bg: '#a855f7', cardBg: 'rgba(25,8,40,0.9)' },
  { icon: Settings, name: 'Appliance Repair', desc: 'Washing machine, laptop, WiFi', slug: 'appliance-repair', bg: '#6366f1', cardBg: 'rgba(15,15,40,0.9)' },
  { icon: Hammer, name: 'Carpenter & Handyman', desc: 'Furniture, repairs, installation', slug: 'carpenter', bg: '#f59e0b', cardBg: 'rgba(35,28,6,0.9)' },
  { icon: Leaf, name: 'Gardening & Pest Control', desc: 'Garden care, pest solutions', slug: 'gardening', bg: '#84cc16', cardBg: 'rgba(18,28,6,0.9)' },
  { icon: Scissors, name: 'Beauty & Wellness', desc: 'Salon at home, spa services', slug: 'beauty', bg: '#f43f5e', cardBg: 'rgba(35,8,15,0.9)' },
  { icon: ShoppingBasket, name: 'Farm Fresh Delivery', desc: 'Direct from farmers to you', slug: 'farm-fresh', bg: '#10b981', cardBg: 'rgba(6,28,20,0.9)' },
  { icon: Truck, name: 'Delivery Gigs', desc: 'Earn by delivering nearby', slug: 'delivery', bg: '#f97316', cardBg: 'rgba(38,20,6,0.9)' },
];

const popularTags = ['Electrician', 'Plumber', 'Cleaning', 'Cook', 'Tutor', 'Farm Fresh'];

const topProviders = [
  { name: 'Amit Sharma', category: 'Electrician', rating: 4.9, reviews: 156, available: true, avatar: 'AS', color: 'from-amber-500 to-orange-600' },
  { name: 'Priya Patel', category: 'Home Cleaning', rating: 4.8, reviews: 203, available: true, avatar: 'PP', color: 'from-pink-500 to-rose-600' },
  { name: 'Ravi Kumar', category: 'Plumber', rating: 4.9, reviews: 89, available: true, avatar: 'RK', color: 'from-blue-500 to-cyan-600' },
];

const stats = [
  { icon: Users, value: '10,000+', label: 'Verified Providers', color: '#FF9933', bg: 'rgba(255,153,51,0.25)' },
  { icon: Award, value: '1M+', label: 'Services Completed', color: '#FF9933', bg: 'rgba(255,153,51,0.25)' },
  { icon: MapPin, value: '50+', label: 'Cities Covered', color: '#138808', bg: 'rgba(19,136,8,0.3)' },
  { icon: Star, value: '4.8/5', label: 'Average Rating', color: '#138808', bg: 'rgba(19,136,8,0.3)' },
];

const features = [
  { icon: Shield, title: 'Verified Professionals', desc: 'All service providers undergo thorough background checks and KYC verification for your safety.', bg: '#22c55e' },
  { icon: Clock, title: 'Quick Booking', desc: 'Book services instantly or schedule for later. Get confirmed appointments within minutes.', bg: '#3b82f6' },
  { icon: CreditCard, title: 'Secure Payments', desc: 'Pay safely through our wallet system with 8% APR rewards. Multiple payment options available.', bg: '#a855f7' },
  { icon: Star, title: 'Quality Guaranteed', desc: 'Read real reviews from verified customers. Money-back guarantee on unsatisfactory services.', bg: '#f59e0b' },
  { icon: MapPin, title: 'Location-Based', desc: 'Find service providers in your exact area. Filter by distance and availability.', bg: '#ef4444' },
  { icon: MessageCircle, title: 'Real-Time Chat', desc: 'Communicate directly with service providers through our in-app messaging system.', bg: '#14b8a6' },
  { icon: Award, title: 'Tier Benefits', desc: 'Unlock exclusive benefits with Silver, Gold, and Platinum wallet tiers.', bg: '#f97316' },
  { icon: Heart, title: 'Customer Care', desc: '24/7 support team ready to help. Dedicated dispute resolution for peace of mind.', bg: '#ec4899' },
];

export default function Home() {
  const [searchQuery, setSearchQuery] = useState('');
  const [location, setLocation] = useState('');
  const router = useRouter();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (location) params.set('location', location);
    router.push(`/services?${params.toString()}`);
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d]">
      {/* Hero Section */}
      <section className="relative min-h-screen flex items-center pt-16 overflow-hidden">
        {/* Background Effects */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-20 left-0 w-[600px] h-[600px] bg-[#FF9933]/8 rounded-full blur-[120px]" />
          <div className="absolute bottom-0 right-0 w-[500px] h-[500px] bg-[#138808]/8 rounded-full blur-[120px]" />
          <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.03) 1px, transparent 0)', backgroundSize: '40px 40px' }} />
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 w-full">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            {/* Left Column */}
            <div className="animate-fade-up">
              {/* Badge */}
              <div className="inline-flex items-center gap-2 bg-[#FF9933]/10 border border-[#FF9933]/20 rounded-full px-4 py-1.5 mb-8">
                <span className="text-base">🚀</span>
                <span className="text-sm font-medium text-[#FF9933]">India's #1 Service Marketplace</span>
              </div>

              {/* Brand */}
              <div className="flex items-center gap-4 mb-4">
                <span className="text-5xl">🙏</span>
                <h1 className="text-5xl font-black text-[#138808] tracking-tight">Seva</h1>
                <span className="text-5xl">🙏</span>
              </div>

              {/* Headline */}
              <h2 className="text-4xl sm:text-5xl lg:text-6xl font-black text-white leading-tight mb-6">
                Trusted Service<br />Providers at Your<br />
                Doorstep
              </h2>

              <p className="text-lg text-gray-400 leading-relaxed mb-10 max-w-lg">
                From electricians to home cooks, find verified professionals for all your needs. Safe, reliable, and highly rated services.
              </p>

              {/* Search Bar */}
              <form onSubmit={handleSearch} className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-2xl p-2 mb-6 hover:border-[#FF9933]/30 transition-colors">
                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="flex items-center gap-3 flex-1 px-4 py-2">
                    <Search className="w-5 h-5 text-gray-500 flex-shrink-0" />
                    <input
                      type="text"
                      placeholder="What service do you need?"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
                    />
                  </div>
                  <div className="hidden sm:block w-px bg-[#2a2a2a] self-stretch" />
                  <div className="flex items-center gap-3 flex-1 px-4 py-2">
                    <MapPin className="w-5 h-5 text-gray-500 flex-shrink-0" />
                    <input
                      type="text"
                      placeholder="Your location"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    className="saffron-btn rounded-xl px-6 py-3 text-sm font-semibold whitespace-nowrap"
                  >
                    Find Services Near Me
                  </button>
                </div>
              </form>

              {/* Popular tags */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-gray-500">Popular:</span>
                {popularTags.map((tag) => (
                  <Link
                    key={tag}
                    href={`/services?q=${tag.toLowerCase()}`}
                    className="text-sm px-3 py-1.5 border border-[#2a2a2a] rounded-lg text-gray-300 hover:border-[#FF9933]/50 hover:text-[#FF9933] transition-all duration-200"
                  >
                    {tag}
                  </Link>
                ))}
              </div>
            </div>

            {/* Right Column - Stats + Top Providers */}
            <div className="animate-fade-right delay-200 space-y-6">
              {/* Stats Grid */}
              <div className="grid grid-cols-2 gap-4">
                {stats.map((stat, i) => (
                  <div
                    key={stat.label}
                    className={`bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover animate-fade-up delay-${(i + 1) * 100}`}
                  >
                    <div
                      className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
                      style={{ background: stat.bg }}
                    >
                      <stat.icon className="w-6 h-6" style={{ color: stat.color }} />
                    </div>
                    <p className="text-2xl font-black text-white">{stat.value}</p>
                    <p className="text-sm text-gray-400 mt-0.5">{stat.label}</p>
                  </div>
                ))}
              </div>

              {/* Top Providers Card */}
              <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-white">Top Rated Providers</h3>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-[#22c55e] bg-[#22c55e]/10 border border-[#22c55e]/20 rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse" />
                    Available Now
                  </span>
                </div>
                <div className="space-y-4">
                  {topProviders.map((p) => (
                    <div key={p.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <div className={`w-10 h-10 rounded-full bg-gradient-to-br ${p.color} flex items-center justify-center text-sm font-bold text-white`}>
                            {p.avatar}
                          </div>
                          {p.available && (
                            <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-white">{p.name}</p>
                          <p className="text-xs text-gray-400">{p.category}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="flex items-center gap-1 justify-end">
                          <Star className="w-3.5 h-3.5 fill-[#FF9933] text-[#FF9933]" />
                          <span className="text-sm font-semibold text-white">{p.rating}</span>
                        </div>
                        <p className="text-xs text-gray-500">{p.reviews} reviews</p>
                      </div>
                    </div>
                  ))}
                </div>
                <Link
                  href="/providers"
                  className="mt-4 flex items-center justify-center gap-2 text-sm font-medium text-[#FF9933] hover:text-[#e8872e] transition-colors"
                >
                  View all providers <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Popular Services Grid */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-black text-[#138808] mb-3">Popular Services</h2>
          <p className="text-gray-400 max-w-xl mx-auto">Connect with verified professionals for all your home and personal service needs</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {categories.map((cat, i) => (
            <Link
              key={cat.slug}
              href={`/services?category=${cat.slug}`}
              className={`group rounded-2xl p-6 seva-card-hover border border-white/5 animate-fade-up delay-${Math.min((i % 4) * 100, 400)}`}
              style={{ background: cat.cardBg }}
            >
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center mb-4 transition-transform duration-300 group-hover:scale-110"
                style={{ background: cat.bg }}
              >
                <cat.icon className="w-7 h-7 text-white" />
              </div>
              <h3 className="font-semibold text-white text-sm mb-1 group-hover:text-[#FF9933] transition-colors">{cat.name}</h3>
              <p className="text-xs text-gray-500 leading-relaxed">{cat.desc}</p>
            </Link>
          ))}
        </div>

        <div className="text-center mt-10">
          <Link
            href="/services"
            className="inline-flex items-center gap-2 saffron-btn rounded-xl px-8 py-3.5 text-sm font-semibold"
          >
            View All Services <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </section>

      {/* Why Choose Seva */}
      <section className="py-20 bg-[#0a0a0a]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-black text-[#138808] mb-3">Why Choose Seva?</h2>
            <p className="text-gray-400 max-w-2xl mx-auto">
              We've built a platform that prioritizes safety, convenience, and quality to ensure you get the best service experience every time.
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
            {features.map((f, i) => (
              <div
                key={f.title}
                className={`group bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6 seva-card-hover animate-fade-up delay-${Math.min(i * 100, 400)} text-center`}
              >
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4 mx-auto transition-transform duration-300 group-hover:scale-110"
                  style={{ background: f.bg }}
                >
                  <f.icon className="w-7 h-7 text-white" />
                </div>
                <h3 className="font-bold text-white mb-2 text-sm">{f.title}</h3>
                <p className="text-xs text-gray-400 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Banner */}
      <section className="relative overflow-hidden">
        <div
          className="py-20 px-6"
          style={{ background: 'linear-gradient(135deg, #FF9933 0%, #f59e0b 25%, #22c55e 55%, #138808 75%, #054187 100%)' }}
        >
          <div className="max-w-3xl mx-auto text-center relative z-10">
            <h2 className="text-3xl sm:text-4xl font-black text-white mb-4">
              Ready to Experience Premium Service?
            </h2>
            <p className="text-white/90 text-lg mb-10">
              Join thousands of satisfied customers who trust Seva for their daily needs
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/services"
                className="bg-black/80 hover:bg-black text-[#FF9933] font-bold px-8 py-4 rounded-xl transition-all hover:scale-105"
              >
                Book a Service Now
              </Link>
              <Link
                href="/become-provider"
                className="border-2 border-white/80 text-white font-bold px-8 py-4 rounded-xl hover:bg-white/10 transition-all hover:scale-105"
              >
                Become a Provider
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
