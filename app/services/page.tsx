'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Search, MapPin, Star, Filter, ChevronDown, SlidersHorizontal,
  Zap, Wrench, ChefHat, Sparkles, Heart, Car, Stethoscope,
  GraduationCap, Settings, Hammer, Leaf, Scissors, ShoppingBasket, Truck,
  CheckCircle, Clock, X
} from 'lucide-react';
import { supabase, ServiceProvider } from '@/lib/supabase';

const categories = [
  { icon: Zap, name: 'Electrician', slug: 'electrician', color: '#FF9933' },
  { icon: Wrench, name: 'Plumber', slug: 'plumber', color: '#3b82f6' },
  { icon: ChefHat, name: 'Home Cook', slug: 'home-cook', color: '#ef4444' },
  { icon: Sparkles, name: 'Cleaning', slug: 'house-cleaning', color: '#22c55e' },
  { icon: Heart, name: 'Caretaker', slug: 'caretaker', color: '#ec4899' },
  { icon: Car, name: 'Driver', slug: 'driver', color: '#94a3b8' },
  { icon: Stethoscope, name: 'Doctor', slug: 'doctor', color: '#14b8a6' },
  { icon: GraduationCap, name: 'Tutor', slug: 'tutor', color: '#a855f7' },
  { icon: Settings, name: 'Appliance', slug: 'appliance-repair', color: '#6366f1' },
  { icon: Hammer, name: 'Carpenter', slug: 'carpenter', color: '#f59e0b' },
  { icon: Leaf, name: 'Gardening', slug: 'gardening', color: '#84cc16' },
  { icon: Scissors, name: 'Beauty', slug: 'beauty', color: '#f43f5e' },
  { icon: ShoppingBasket, name: 'Farm Fresh', slug: 'farm-fresh', color: '#10b981' },
  { icon: Truck, name: 'Delivery', slug: 'delivery', color: '#f97316' },
];

const mockProviders = [
  { id: '1', business_name: 'Amit Sharma', category: 'Electrician', slug: 'electrician', rating: 4.9, total_reviews: 156, hourly_rate: 350, experience_years: 8, city: 'Mumbai', is_verified: true, is_available: true, avatar: 'AS', color: 'from-amber-500 to-orange-600', bio: 'Expert electrician with 8+ years. Specializes in home wiring and electrical repairs.' },
  { id: '2', business_name: 'Priya Patel', category: 'Home Cleaning', slug: 'house-cleaning', rating: 4.8, total_reviews: 203, hourly_rate: 250, experience_years: 5, city: 'Mumbai', is_verified: true, is_available: true, avatar: 'PP', color: 'from-pink-500 to-rose-600', bio: 'Professional house cleaner. Deep cleaning, organizing, and maintenance expert.' },
  { id: '3', business_name: 'Ravi Kumar', category: 'Plumber', slug: 'plumber', rating: 4.9, total_reviews: 89, hourly_rate: 300, experience_years: 10, city: 'Pune', is_verified: true, is_available: true, avatar: 'RK', color: 'from-blue-500 to-cyan-600', bio: 'Senior plumber. Handles all types of plumbing — pipes, leaks, bathroom installations.' },
  { id: '4', business_name: 'Meena Devi', category: 'Home Cook', slug: 'home-cook', rating: 4.7, total_reviews: 312, hourly_rate: 200, experience_years: 7, city: 'Delhi', is_verified: true, is_available: false, avatar: 'MD', color: 'from-red-500 to-orange-500', bio: 'Home cook specializing in North Indian cuisine. Daily tiffin service available.' },
  { id: '5', business_name: 'Suresh Farm', category: 'Farm Fresh', slug: 'farm-fresh', rating: 4.8, total_reviews: 145, hourly_rate: 0, experience_years: 15, city: 'Nashik', is_verified: true, is_available: true, avatar: 'SF', color: 'from-green-500 to-emerald-600', bio: 'Direct farm-to-home delivery. Fresh milk, vegetables, fruits from our organic farm.' },
  { id: '6', business_name: 'Rajesh Deliveries', category: 'Delivery', slug: 'delivery', rating: 4.6, total_reviews: 78, hourly_rate: 0, experience_years: 3, city: 'Mumbai', is_verified: true, is_available: true, avatar: 'RD', color: 'from-orange-500 to-amber-500', bio: 'Quick delivery service. Available for gig deliveries within 10km radius.' },
  { id: '7', business_name: 'Dr. Anita Singh', category: 'Doctor', slug: 'doctor', rating: 4.9, total_reviews: 67, hourly_rate: 800, experience_years: 12, city: 'Bangalore', is_verified: true, is_available: true, avatar: 'AS', color: 'from-teal-500 to-cyan-600', bio: 'MBBS, MD. Home visit consultations for general medicine and elderly care.' },
  { id: '8', business_name: 'Vikram Sharma', category: 'Carpenter', slug: 'carpenter', rating: 4.7, total_reviews: 134, hourly_rate: 400, experience_years: 12, city: 'Hyderabad', is_verified: true, is_available: true, avatar: 'VS', color: 'from-yellow-500 to-amber-600', bio: 'Expert carpenter. Furniture making, repairs, modular kitchen installation.' },
];

function ServicesContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState(searchParams.get('q') || '');
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || '');
  const [sortBy, setSortBy] = useState('rating');
  const [showFilters, setShowFilters] = useState(false);
  const [minRating, setMinRating] = useState(0);
  const [availableOnly, setAvailableOnly] = useState(false);

  const filtered = mockProviders.filter((p) => {
    const matchesSearch = !searchQuery ||
      p.business_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = !selectedCategory || p.slug === selectedCategory;
    const matchesRating = p.rating >= minRating;
    const matchesAvailable = !availableOnly || p.is_available;
    return matchesSearch && matchesCategory && matchesRating && matchesAvailable;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'rating') return b.rating - a.rating;
    if (sortBy === 'price_low') return a.hourly_rate - b.hourly_rate;
    if (sortBy === 'price_high') return b.hourly_rate - a.hourly_rate;
    if (sortBy === 'reviews') return b.total_reviews - a.total_reviews;
    return 0;
  });

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      {/* Header */}
      <div className="bg-[#0a0a0a] border-b border-[#1e1e1e] py-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-black text-white mb-2">Browse Services</h1>
          <p className="text-gray-400 mb-6">Find verified professionals near you</p>

          {/* Search Bar */}
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
              <MapPin className="w-5 h-5 text-gray-500 flex-shrink-0" />
              <input
                type="text"
                placeholder="Location"
                className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Category Filters */}
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
          {categories.map((cat) => (
            <button
              key={cat.slug}
              onClick={() => setSelectedCategory(selectedCategory === cat.slug ? '' : cat.slug)}
              className={`flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                selectedCategory === cat.slug
                  ? 'bg-[#FF9933] text-white shadow-lg shadow-[#FF9933]/20'
                  : 'bg-[#1a1a1a] border border-[#2a2a2a] text-gray-300 hover:border-[#FF9933]/50'
              }`}
            >
              <cat.icon className="w-4 h-4" style={{ color: selectedCategory === cat.slug ? 'white' : cat.color }} />
              {cat.name}
            </button>
          ))}
        </div>

        <div className="flex flex-col lg:flex-row gap-8">
          {/* Sidebar Filters */}
          <aside className="lg:w-64 flex-shrink-0">
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 sticky top-24">
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-semibold text-white flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 text-[#FF9933]" />
                  Filters
                </h3>
                <button
                  onClick={() => { setMinRating(0); setAvailableOnly(false); setSortBy('rating'); }}
                  className="text-xs text-[#FF9933] hover:text-[#e8872e]"
                >
                  Reset
                </button>
              </div>

              {/* Sort */}
              <div className="mb-5">
                <label className="text-sm font-medium text-gray-300 block mb-3">Sort By</label>
                <div className="space-y-2">
                  {[
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

              {/* Min Rating */}
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

              {/* Available Only */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-300">Available Now</span>
                <button
                  onClick={() => setAvailableOnly(!availableOnly)}
                  className={`relative w-10 h-5.5 rounded-full transition-colors ${availableOnly ? 'bg-[#FF9933]' : 'bg-[#2a2a2a]'}`}
                  style={{ height: '22px' }}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${availableOnly ? 'translate-x-5' : 'translate-x-0.5'}`}
                  />
                </button>
              </div>
            </div>
          </aside>

          {/* Results */}
          <div className="flex-1">
            <div className="flex items-center justify-between mb-6">
              <p className="text-gray-400 text-sm">
                <span className="text-white font-semibold">{sorted.length}</span> providers found
              </p>
            </div>

            {sorted.length === 0 ? (
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
                        <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${provider.color} flex items-center justify-center text-lg font-black text-white`}>
                          {provider.avatar}
                        </div>
                        {provider.is_available && (
                          <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h3 className="font-bold text-white group-hover:text-[#FF9933] transition-colors truncate">{provider.business_name}</h3>
                            <p className="text-xs text-[#FF9933] font-medium">{provider.category}</p>
                          </div>
                          {provider.is_verified && (
                            <CheckCircle className="w-4 h-4 text-[#138808] flex-shrink-0 mt-0.5" />
                          )}
                        </div>

                        <p className="text-xs text-gray-400 mt-1.5 line-clamp-2 leading-relaxed">{provider.bio}</p>

                        <div className="flex items-center gap-4 mt-3">
                          <div className="flex items-center gap-1">
                            <Star className="w-3.5 h-3.5 fill-[#FF9933] text-[#FF9933]" />
                            <span className="text-sm font-semibold text-white">{provider.rating}</span>
                            <span className="text-xs text-gray-500">({provider.total_reviews})</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <MapPin className="w-3 h-3 text-gray-500" />
                            <span className="text-xs text-gray-400">{provider.city}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3 text-gray-500" />
                            <span className="text-xs text-gray-400">{provider.experience_years}y exp</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between mt-4 pt-4 border-t border-[#222]">
                      <div>
                        {provider.hourly_rate > 0 ? (
                          <p className="text-sm font-bold text-white">
                            ₹{provider.hourly_rate}<span className="text-xs text-gray-500 font-normal">/hr</span>
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
