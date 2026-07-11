'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Search, Star, MapPin, Clock, CheckCircle, Users } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type ProviderRow = {
  id: string;
  business_name: string | null;
  bio: string | null;
  rating: number;
  total_reviews: number;
  hourly_rate: number;
  experience_years: number;
  city: string | null;
  is_verified: boolean;
  is_available: boolean;
  service_categories: { name: string; slug: string } | null;
};

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
  'appliance-repair': 'from-gray-500 to-slate-600',
  beauty: 'from-rose-500 to-pink-600',
};

function initials(name: string | null): string {
  if (!name) return '?';
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
}

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [cityFilter, setCityFilter] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase
        .from('service_providers')
        .select('id, business_name, bio, rating, total_reviews, hourly_rate, experience_years, city, is_verified, is_available, service_categories(name, slug)')
        .eq('status', 'approved')
        .order('rating', { ascending: false });
      if (!mounted) return;
      if (error) {
        console.error('Failed to load providers:', error.message);
        setProviders([]);
      } else {
        setProviders((data ?? []) as unknown as ProviderRow[]);
      }
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, []);

  const filtered = providers.filter((p) => {
    const name = p.business_name ?? '';
    const category = p.service_categories?.name ?? '';
    const matchesSearch = !search || name.toLowerCase().includes(search.toLowerCase()) || category.toLowerCase().includes(search.toLowerCase());
    const matchesCity = !cityFilter || (p.city ?? '').toLowerCase() === cityFilter.toLowerCase();
    return matchesSearch && matchesCity;
  });

  const cities = Array.from(new Set(providers.map((p) => p.city).filter(Boolean))) as string[];

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      {/* Header */}
      <div className="bg-[#0a0a0a] border-b border-[#1e1e1e] py-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3 mb-2">
            <Users className="w-8 h-8 text-[#FF9933]" />
            <h1 className="text-3xl font-black text-white">All Providers</h1>
          </div>
          <p className="text-gray-400 mb-6">Browse all verified service professionals on Seva</p>

          <div className="flex flex-col sm:flex-row gap-3 max-w-2xl">
            <div className="flex-1 flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3">
              <Search className="w-5 h-5 text-gray-500" />
              <input
                type="text"
                placeholder="Search by name or category..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
              />
            </div>
            <select
              value={cityFilter}
              onChange={(e) => setCityFilter(e.target.value)}
              className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#FF9933] min-w-[150px]"
            >
              <option value="">All Cities</option>
              {cities.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading ? (
          <div className="text-center py-20 text-gray-400">Loading providers…</div>
        ) : (
          <>
            <p className="text-gray-400 text-sm mb-6">
              Showing <span className="text-white font-semibold">{filtered.length}</span> providers
            </p>

            {filtered.length === 0 ? (
              <div className="text-center py-20">
                <Users className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                <p className="text-gray-400 text-lg mb-2">No providers found</p>
                <p className="text-gray-600 text-sm">Try adjusting your search or city filter.</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {filtered.map((p) => {
                  const gradient = categoryGradient[p.service_categories?.slug ?? ''] ?? 'from-slate-500 to-slate-600';
                  return (
                    <Link
                      key={p.id}
                      href={`/providers/${p.id}`}
                      className="group bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover block"
                    >
                      <div className="flex items-start gap-4 mb-4">
                        <div className="relative flex-shrink-0">
                          <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${gradient} flex items-center justify-center text-lg font-black text-white`}>
                            {initials(p.business_name)}
                          </div>
                          {p.is_available && (
                            <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between">
                            <h3 className="font-bold text-white group-hover:text-[#FF9933] transition-colors">{p.business_name}</h3>
                            {p.is_verified && <CheckCircle className="w-4 h-4 text-[#138808] flex-shrink-0" />}
                          </div>
                          <p className="text-xs text-[#FF9933] font-medium mt-0.5">{p.service_categories?.name ?? 'Service'}</p>
                          <div className="flex items-center gap-1 mt-1">
                            <Star className="w-3 h-3 fill-[#FF9933] text-[#FF9933]" />
                            <span className="text-xs font-semibold text-white">{Number(p.rating).toFixed(1)}</span>
                            <span className="text-xs text-gray-500">({p.total_reviews} reviews)</span>
                          </div>
                        </div>
                      </div>

                      <p className="text-xs text-gray-400 leading-relaxed mb-4 line-clamp-2">{p.bio}</p>

                      <div className="flex items-center gap-3 text-xs text-gray-500 mb-4">
                        <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{p.city}</span>
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{p.experience_years}y experience</span>
                      </div>

                      <div className="flex items-center justify-between pt-4 border-t border-[#222]">
                        {p.hourly_rate > 0 ? (
                          <p className="text-sm font-bold text-white">₹{p.hourly_rate}<span className="text-xs font-normal text-gray-500">/hr</span></p>
                        ) : (
                          <p className="text-sm font-bold text-[#138808]">Contact for pricing</p>
                        )}
                        <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${p.is_available ? 'bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/20' : 'bg-gray-800/50 text-gray-500'}`}>
                          {p.is_available ? 'Available' : 'Busy'}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
