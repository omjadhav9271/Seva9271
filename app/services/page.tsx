'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Search, MapPin, Star, Filter, SlidersHorizontal,
  Zap, Wrench, ChefHat, Sparkles, Heart, Car, Stethoscope,
  GraduationCap, Settings, Hammer, Leaf, Scissors, ShoppingBasket, Truck,
  PaintBucket, HardHat, Shirt, Home, Bike, Smartphone,
  Droplets, Flame, CheckCircle, Clock, X, Crosshair, LocateFixed
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useLocation } from '@/lib/location-context';
import { supabase } from '@/lib/supabase';

const iconMap: Record<string, any> = {
  Zap, Wrench, ChefHat, Sparkles, Heart, Car, Stethoscope, GraduationCap,
  Settings, Hammer, Leaf, Scissors, ShoppingBasket, Truck,
  PaintBucket, HardHat, Shirt, Home, Bike, Smartphone, Droplets, Flame,
};

const fallbackIcon = MapPin;

function getCategoryIcon(iconName: string) {
  return iconMap[iconName] || fallbackIcon;
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

function ServicesContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user } = useAuth();
  const { location, requestLocation } = useLocation();

  const [searchQuery, setSearchQuery] = useState(searchParams.get('q') || '');
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || '');
  const [sortBy, setSortBy] = useState('closest');
  const [showFilters, setShowFilters] = useState(false);
  const [minRating, setMinRating] = useState(0);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [providers, setProviders] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [cityFilter, setCityFilter] = useState('');

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    Promise.all([
      supabase.from('service_categories').select('*').order('name'),
      supabase.from('service_providers')
        .select('*, profiles(full_name, phone, avatar_url), service_categories(name, slug)')
        .eq('status', 'approved')
    ]).then(([catRes, provRes]) => {
      if (catRes.data) setCategories(catRes.data);
      if (provRes.data) setProviders(provRes.data);
      setLoading(false);
    });
  }, [user]);

  const filtered = providers.filter((p) => {
    const matchesSearch = !searchQuery ||
      (p.business_name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.service_categories?.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.bio || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.city || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = !selectedCategory ||
      (p.service_categories?.slug === selectedCategory) ||
      (p.category_id === selectedCategory);
    const matchesRating = (p.rating || 0) >= minRating;
    const matchesAvailable = !availableOnly || p.is_available;
    const matchesCity = !cityFilter || (p.city || '').toLowerCase() === cityFilter.toLowerCase();
    return matchesSearch && matchesCategory && matchesRating && matchesAvailable && matchesCity;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'rating') return (b.rating || 0) - (a.rating || 0);
    if (sortBy === 'price_low') return (a.hourly_rate || 0) - (b.hourly_rate || 0);
    if (sortBy === 'price_high') return (b.hourly_rate || 0) - (a.hourly_rate || 0);
    if (sortBy === 'reviews') return (b.total_reviews || 0) - (a.total_reviews || 0);
    if (sortBy === 'closest') {
      const distA = (a.latitude && a.longitude && location.lat)
        ? getDistanceFromLatLonInKm(location.lat, location.lng, a.latitude, a.longitude)
        : Infinity;
      const distB = (b.latitude && b.longitude && location.lat)
        ? getDistanceFromLatLonInKm(location.lat, location.lng, b.latitude, b.longitude)
        : Infinity;
      return distA - distB;
    }
    return 0;
  });

  const cities = Array.from(new Set(providers.map(p => p.city).filter(Boolean)));

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="bg-[#0a0a0a] border-b border-[#1e1e1e] py-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-black text-white mb-2">Browse Services</h1>
          <p className="text-gray-400 mb-6">
            {categories.length > 0 ? `${categories.length}+ services available` : 'Loading...'} — Find verified providers near you
          </p>

          <div className="flex flex-col sm:flex-row gap-3 max-w-2xl">
            <div className="flex-1 flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3">
              <Search className="w-5 h-5 text-gray-500 flex-shrink-0" />
              <input
                type="text"
                placeholder="Search services or providers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 min-w-[180px]">
              <button onClick={requestLocation} className="flex-shrink-0 text-gray-500 hover:text-[#FF9933] transition-colors">
                {location.loading ? <div className="w-4 h-4 border-2 border-[#FF9933]/30 border-t-[#FF9933] rounded-full animate-spin" /> : <Crosshair className="w-4 h-4" />}
              </button>
              <span className="text-sm text-gray-400 truncate">
                {location.city || 'Locating...'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex gap-3 overflow-x-auto pb-4 mb-8 scrollbar-hide">
          <button
            onClick={() => setSelectedCategory('')}
            className={`flex-shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              !selectedCategory
                ? 'bg-[#FF9933] text-white shadow-lg shadow-[#FF9933]/20'
                : 'bg-[#1a1a1a] border border-[#2a2a2a] text-gray-300 hover:border-[#FF9933]/50'
            }`}
          >
            All Services
          </button>
          {categories.map((cat) => {
            const Icon = getCategoryIcon(cat.icon);
            return (
              <button
                key={cat.slug}
                onClick={() => setSelectedCategory(selectedCategory === cat.slug ? '' : cat.slug)}
                className={`flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  selectedCategory === cat.slug
                    ? 'bg-[#FF9933] text-white shadow-lg shadow-[#FF9933]/20'
                    : 'bg-[#1a1a1a] border border-[#2a2a2a] text-gray-300 hover:border-[#FF9933]/50'
                }`}
              >
                <Icon className="w-4 h-4" style={{ color: selectedCategory === cat.slug ? 'white' : cat.color }} />
                {cat.name}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col lg:flex-row gap-8">
          <aside className="lg:w-64 flex-shrink-0">
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 sticky top-24">
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-semibold text-white flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 text-[#FF9933]" />
                  Filters
                </h3>
                <button
                  onClick={() => { setMinRating(0); setAvailableOnly(false); setSortBy('closest'); setCityFilter(''); }}
                  className="text-xs text-[#FF9933] hover:text-[#e8872e]"
                >
                  Reset
                </button>
              </div>

              <div className="mb-5">
                <label className="text-sm font-medium text-gray-300 block mb-3">Sort By</label>
                <div className="space-y-2">
                  {[
                    { value: 'closest', label: 'Nearest to Me' },
                    { value: 'rating', label: 'Highest Rated' },
                    { value: 'reviews', label: 'Most Reviewed' },
                    { value: 'price_low', label: 'Price: Low to High' },
                    { value: 'price_high', label: 'Price: High to Low' },
                  ].map((opt) => (
                    <label key={opt.value} className="flex items-center gap-2 cursor-pointer group">
                      <div
                        onClick={() => setSortBy(opt.value)}
                        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                          sortBy === opt.value ? 'border-[#FF9933] bg-[#FF9933]' : 'border-[#2a2a2a] group-hover:border-[#FF9933]/50'
                        }`}
                      >
                        {sortBy === opt.value && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                      </div>
                      <span className="text-sm text-gray-300">{opt.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="mb-5">
                <label className="text-sm font-medium text-gray-300 block mb-3">City</label>
                <select
                  value={cityFilter}
                  onChange={(e) => setCityFilter(e.target.value)}
                  className="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#FF9933]"
                >
                  <option value="">All Cities</option>
                  {cities.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div className="mb-5">
                <label className="text-sm font-medium text-gray-300 block mb-3">Minimum Rating</label>
                <div className="flex gap-2">
                  {[0, 3, 4, 4.5].map((r) => (
                    <button
                      key={r}
                      onClick={() => setMinRating(r)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        minRating === r
                          ? 'bg-[#FF9933] text-white'
                          : 'bg-[#1a1a1a] border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/50'
                      }`}
                    >
                      {r === 0 ? 'Any' : `${r}+`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-300">Available Now</span>
                <button
                  onClick={() => setAvailableOnly(!availableOnly)}
                  className={`relative w-10 rounded-full transition-colors ${availableOnly ? 'bg-[#FF9933]' : 'bg-[#2a2a2a]'}`}
                  style={{ height: '22px' }}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${availableOnly ? 'translate-x-5' : 'translate-x-0.5'}`}
                  />
                </button>
              </div>
            </div>
          </aside>

          <div className="flex-1">
            <div className="flex items-center justify-between mb-6">
              <p className="text-gray-400 text-sm">
                <span className="text-white font-semibold">{sorted.length}</span> providers found
                {sortBy === 'closest' && location.city && ` near ${location.city}`}
              </p>
            </div>

            {loading ? (
              <div className="grid sm:grid-cols-2 gap-5">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 h-40 animate-pulse" />
                ))}
              </div>
            ) : sorted.length === 0 ? (
              <div className="text-center py-20">
                <p className="text-gray-400 text-lg mb-2">No providers found</p>
                <p className="text-gray-600 text-sm">Try adjusting your filters or search query</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-5">
                {sorted.map((provider) => (
                  <Link
                    key={provider.id}
                    href={`/providers/${provider.id}`}
                    className="group bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover block"
                  >
                    <div className="flex items-start gap-4">
                      <div className="relative flex-shrink-0">
                        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#FF9933] to-[#138808] flex items-center justify-center text-lg font-black text-white">
                          {(provider.business_name || provider.profiles?.full_name || 'P').slice(0, 2).toUpperCase()}
                        </div>
                        {provider.is_available && (
                          <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h3 className="font-bold text-white group-hover:text-[#FF9933] transition-colors truncate">{provider.business_name || provider.profiles?.full_name || 'Provider'}</h3>
                            <p className="text-xs text-[#FF9933] font-medium">{provider.service_categories?.name || 'Service'}</p>
                          </div>
                          {provider.is_verified && (
                            <CheckCircle className="w-4 h-4 text-[#138808] flex-shrink-0 mt-0.5" />
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-1.5 line-clamp-2 leading-relaxed">{provider.bio || 'Verified professional ready to serve.'}</p>
                        <div className="flex items-center gap-4 mt-3">
                          <div className="flex items-center gap-1">
                            <Star className="w-3.5 h-3.5 fill-[#FF9933] text-[#FF9933]" />
                            <span className="text-sm font-semibold text-white">{(provider.rating || 0).toFixed(1)}</span>
                            <span className="text-xs text-gray-500">({provider.total_reviews || 0})</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <MapPin className="w-3 h-3 text-gray-500" />
                            <span className="text-xs text-gray-400">{provider.city || 'N/A'}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3 text-gray-500" />
                            <span className="text-xs text-gray-400">{provider.experience_years || 0}y exp</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between mt-4 pt-4 border-t border-[#222]">
                      <div>
                        {(provider.hourly_rate || 0) > 0 ? (
                          <p className="text-sm font-bold text-white">
                            Rs {provider.hourly_rate}<span className="text-xs text-gray-500 font-normal">/hr</span>
                          </p>
                        ) : (
                          <p className="text-sm font-bold text-[#138808]">Custom pricing</p>
                        )}
                      </div>
                      <span className={`text-xs px-3 py-1.5 rounded-full font-medium ${
                        provider.is_available
                          ? 'bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/20'
                          : 'bg-gray-800/50 text-gray-500 border border-gray-700/50'
                      }`}>
                        {provider.is_available ? 'Available' : 'Busy'}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ServicesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center"><div className="text-gray-400">Loading...</div></div>}>
      <ServicesContent />
    </Suspense>
  );
}
