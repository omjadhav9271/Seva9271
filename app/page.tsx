'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useLocation } from '@/lib/location-context';
import { useRequireAuth } from '@/lib/auth-guard';
import { useState } from 'react';
import Link from 'next/link';
import {
  Search, MapPin, Star, CheckCircle, Shield, Clock, Users, Zap, Wrench,
  ChefHat, Sparkles, Heart, Car, Stethoscope, GraduationCap, Settings,
  Hammer, Leaf, Scissors, ShoppingBasket, Truck, ArrowRight, Award,
  CreditCard, MessageCircle, PaintBucket, HardHat, Shirt, HomeIcon, Bike,
  Smartphone, Droplets, Flame, Crosshair, LocateFixed
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

const iconMap: Record<string, any> = {
  Zap, Wrench, ChefHat, Sparkles, Heart, Car, Stethoscope, GraduationCap,
  Settings, Hammer, Leaf, Scissors, ShoppingBasket, Truck,
  PaintBucket, HardHat, Shirt, HomeIcon, Bike, Smartphone, Droplets, Flame,
  BookOpen: MessageCircle, MapPin, Star, Shield, Clock, Users, ArrowRight,
  Award, CreditCard, MessageCircle, CheckCircle,
};

const fallbackIcon = MapPin;

const stats = [
  { icon: Users, value: '25+', label: 'Service Categories', color: '#FF9933', bg: 'rgba(255,153,51,0.25)' },
  { icon: Award, value: 'Verified', label: 'KYC Providers', color: '#FF9933', bg: 'rgba(255,153,51,0.25)' },
  { icon: MapPin, value: 'GPS', label: 'Location Tracking', color: '#138808', bg: 'rgba(19,136,8,0.3)' },
  { icon: Star, value: '4.8/5', label: 'Average Rating', color: '#138808', bg: 'rgba(19,136,8,0.3)' },
];

const features = [
  { icon: Shield, title: 'KYC Verified', desc: 'Every provider verified with Aadhaar, PAN, and background checks for your safety.', bg: '#22c55e' },
  { icon: Clock, title: 'Quick Booking', desc: 'Book services instantly or schedule for later. Get confirmed appointments within minutes.', bg: '#3b82f6' },
  { icon: CreditCard, title: 'Secure Payments', desc: 'Pay safely via UPI, Wallet, or Cash. Multiple payment options available.', bg: '#a855f7' },
  { icon: Star, title: 'Real Ratings', desc: 'Read genuine reviews from verified customers. No fake ratings ever.', bg: '#f59e0b' },
  { icon: MapPin, title: 'Closest First', desc: 'GPS-enabled search shows nearest providers. Track their arrival like Uber.', bg: '#ef4444' },
  { icon: MessageCircle, title: 'Direct Chat', desc: 'Communicate directly with service providers through in-app messaging.', bg: '#14b8a6' },
  { icon: Award, title: '25+ Services', desc: 'From electrician to cow dung manure, all Indian services under one roof.', bg: '#f97316' },
  { icon: Heart, title: 'Customer First', desc: 'Built for middle class India. Affordable, reliable, and transparent pricing.', bg: '#ec4899' },
];

export default function Home() {
  const { user, loading } = useAuth();
  const { location, requestLocation } = useLocation();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [categories, setCategories] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [catsLoading, setCatsLoading] = useState(true);
  const [providersLoading, setProvidersLoading] = useState(true);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/auth/signin');
    }
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    supabase.from('service_categories').select('*').order('name').then(({ data }) => {
      if (data) setCategories(data);
      setCatsLoading(false);
    });
    supabase.from('service_providers')
      .select('*, profiles(full_name), service_categories(name, slug)')
      .eq('status', 'approved')
      .eq('is_available', true)
      .order('rating', { ascending: false })
      .limit(3)
      .then(({ data }) => {
        if (data) setProviders(data);
        setProvidersLoading(false);
      });
  }, [user]);

  if (!user) return null;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    router.push(`/services?${params.toString()}`);
  };

  const getCategoryIcon = (iconName: string) => {
    const icon = iconMap[iconName];
    return icon || fallbackIcon;
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d]">
      {/* Hero Section */}
      <section className="relative min-h-screen flex items-center pt-16 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-20 left-0 w-[600px] h-[600px] bg-[#FF9933]/8 rounded-full blur-[120px]" />
          <div className="absolute bottom-0 right-0 w-[500px] h-[500px] bg-[#138808]/8 rounded-full blur-[120px]" />
          <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.03) 1px, transparent 0)', backgroundSize: '40px 40px' }} />
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 w-full">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div className="animate-fade-up">
              <div className="inline-flex items-center gap-2 bg-[#FF9933]/10 border border-[#FF9933]/20 rounded-full px-4 py-1.5 mb-8">
                <span className="text-sm font-medium text-[#FF9933]">India's Trusted Service Marketplace</span>
              </div>

              <div className="flex items-center gap-4 mb-4">
                <span className="text-5xl">🙏</span>
                <h1 className="text-5xl font-black text-[#138808] tracking-tight">Seva</h1>
                <span className="text-5xl">🙏</span>
              </div>

              <h2 className="text-4xl sm:text-5xl lg:text-6xl font-black text-white leading-tight mb-6">
                Trusted Service<br />Providers at Your<br />Doorstep
              </h2>

              <p className="text-lg text-gray-400 leading-relaxed mb-10 max-w-lg">
                From electricians to home cooks, find verified professionals for all your needs.
                Built for middle-class India. GPS-enabled, KYC-verified, affordable.
              </p>

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
                    <button onClick={requestLocation} type="button" className="flex-shrink-0 text-gray-500 hover:text-[#FF9933] transition-colors">
                      {location.loading ? <div className="w-4 h-4 border-2 border-[#FF9933]/30 border-t-[#FF9933] rounded-full animate-spin" /> : <Crosshair className="w-4 h-4" />}
                    </button>
                    <span className="text-sm text-gray-400 truncate">
                      {location.city ? `${location.city}, ${location.state}` : 'Locating...'}
                    </span>
                  </div>
                  <button type="submit" className="saffron-btn rounded-xl px-6 py-3 text-sm font-semibold whitespace-nowrap">
                    Find Services
                  </button>
                </div>
              </form>

              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm text-gray-500">Popular:</span>
                {['Electrician', 'Plumber', 'Home Cook', 'Cleaner', 'Tutor', 'Painter'].map((tag) => (
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

            <div className="animate-fade-right delay-200 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                {stats.map((stat, i) => (
                  <div
                    key={stat.label}
                    className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover animate-fade-up"
                    style={{ animationDelay: `${(i + 1) * 100}ms` }}
                  >
                    <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3" style={{ background: stat.bg }}>
                      <stat.icon className="w-6 h-6" style={{ color: stat.color }} />
                    </div>
                    <p className="text-2xl font-black text-white">{stat.value}</p>
                    <p className="text-sm text-gray-400 mt-0.5">{stat.label}</p>
                  </div>
                ))}
              </div>

              <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-white">Available Providers Near You</h3>
                  <span className="flex items-center gap-1.5 text-xs font-medium text-[#22c55e] bg-[#22c55e]/10 border border-[#22c55e]/20 rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse" />
                    Available Now
                  </span>
                </div>
                <div className="space-y-4">
                  {providersLoading ? (
                    <div className="text-center text-sm text-gray-500 py-4">Loading providers...</div>
                  ) : providers.length === 0 ? (
                    <div className="text-center text-sm text-gray-500 py-4">
                      <p>No providers available yet.</p>
                      <p className="text-xs mt-1">Providers will appear once they join!</p>
                    </div>
                  ) : (
                    providers.map((p) => (
                      <Link key={p.id} href={`/providers/${p.id}`} className="flex items-center justify-between group">
                        <div className="flex items-center gap-3">
                          <div className="relative">
                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#FF9933] to-[#138808] flex items-center justify-center text-sm font-bold text-white">
                              {(p.business_name || p.profiles?.full_name || 'P').slice(0, 2).toUpperCase()}
                            </div>
                            {p.is_available && (
                              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-white group-hover:text-[#FF9933] transition-colors">{p.business_name || p.profiles?.full_name || 'Provider'}</p>
                            <p className="text-xs text-gray-400">{p.service_categories?.name || 'Service'}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <Star className="w-3.5 h-3.5 fill-[#FF9933] text-[#FF9933]" />
                            <span className="text-sm font-semibold text-white">{p.rating?.toFixed(1) || '0.0'}</span>
                          </div>
                          <p className="text-xs text-gray-500">{p.total_reviews || 0} reviews</p>
                        </div>
                      </Link>
                    ))
                  )}
                </div>
                <Link href="/services" className="mt-4 flex items-center justify-center gap-2 text-sm font-medium text-[#FF9933] hover:text-[#e8872e] transition-colors">
                  View all providers <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Services Grid */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-black text-[#138808] mb-3">All Services</h2>
          <p className="text-gray-400 max-w-xl mx-auto">
            {categories.length > 0 ? `${categories.length}+ services available` : 'Loading services...'} for all your home and personal needs
          </p>
        </div>

        {catsLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6 h-32 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {categories.map((cat, i) => {
              const Icon = getCategoryIcon(cat.icon);
              return (
                <Link
                  key={cat.slug}
                  href={`/services?category=${cat.slug}`}
                  className="group rounded-2xl p-6 seva-card-hover border border-white/5 animate-fade-up"
                  style={{ background: cat.bg_color || '#161616', animationDelay: `${Math.min((i % 4) * 100, 400)}ms` }}
                >
                  <div
                    className="w-14 h-14 rounded-full flex items-center justify-center mb-4 transition-transform duration-300 group-hover:scale-110"
                    style={{ background: cat.color || '#FF9933' }}
                  >
                    <Icon className="w-7 h-7 text-white" />
                  </div>
                  <h3 className="font-semibold text-white text-sm mb-1 group-hover:text-[#FF9933] transition-colors">{cat.name}</h3>
                  <p className="text-xs text-gray-500 leading-relaxed">{cat.description}</p>
                </Link>
              );
            })}
          </div>
        )}

        <div className="text-center mt-10">
          <Link href="/services" className="inline-flex items-center gap-2 saffron-btn rounded-xl px-8 py-3.5 text-sm font-semibold">
            Browse All Services <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </section>

      {/* Why Choose Seva */}
      <section className="py-20 bg-[#0a0a0a]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-black text-[#138808] mb-3">Why Choose Seva?</h2>
            <p className="text-gray-400 max-w-2xl mx-auto">
              Built for middle-class India. Safe, affordable, and transparent. Every provider is KYC-verified.
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
            {features.map((f, i) => (
              <div
                key={f.title}
                className="group bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6 seva-card-hover text-center animate-fade-up"
                style={{ animationDelay: `${Math.min(i * 100, 400)}ms` }}
              >
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4 mx-auto transition-transform duration-300 group-hover:scale-110" style={{ background: f.bg }}>
                  <f.icon className="w-7 h-7 text-white" />
                </div>
                <h3 className="font-bold text-white mb-2 text-sm">{f.title}</h3>
                <p className="text-xs text-gray-400 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden">
        <div className="py-20 px-6" style={{ background: 'linear-gradient(135deg, #FF9933 0%, #f59e0b 25%, #22c55e 55%, #138808 75%, #054187 100%)' }}>
          <div className="max-w-3xl mx-auto text-center relative z-10">
            <h2 className="text-3xl sm:text-4xl font-black text-white mb-4">
              Ready to Find a Service?
            </h2>
            <p className="text-white/90 text-lg mb-10">
              Browse 25+ verified services. GPS-enabled, KYC-verified providers near you.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/services" className="bg-black/80 hover:bg-black text-[#FF9933] font-bold px-8 py-4 rounded-xl transition-all hover:scale-105">
                Book a Service Now
              </Link>
              <Link href="/how-it-works" className="border-2 border-white/80 text-white font-bold px-8 py-4 rounded-xl hover:bg-white/10 transition-all hover:scale-105">
                How It Works
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
