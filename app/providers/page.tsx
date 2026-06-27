'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Search, Star, MapPin, CheckCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export default function ProvidersPage() {
  const [providers, setProviders] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    supabase.from('service_providers')
      .select('*, profiles(full_name), service_categories(name, slug)')
      .eq('status', 'approved')
      .then(({ data }) => {
        if (data) setProviders(data);
        setLoading(false);
      });
  }, []);

  const filtered = providers.filter((p) => {
    const q = search.toLowerCase();
    return (
      !search ||
      (p.business_name || p.profiles?.full_name || '').toLowerCase().includes(q) ||
      (p.service_categories?.name || '').toLowerCase().includes(q) ||
      (p.city || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-3xl font-black text-white mb-2">Providers</h1>
        <p className="text-gray-400 text-sm mb-6">Browse all verified service professionals.</p>

        <div className="flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 mb-6 max-w-md">
          <Search className="w-5 h-5 text-gray-500" />
          <input
            type="text"
            placeholder="Search providers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
          />
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-gray-500">No providers found.</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {filtered.map((p) => (
              <Link
                key={p.id}
                href={`/providers/${p.id}`}
                className="bg-[#161616] border border-[#2a2a2a] rounded-xl p-4 hover:border-[#FF9933]/50 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#FF9933] to-[#138808] flex items-center justify-center text-sm font-bold text-white flex-shrink-0">
                    {(p.business_name || p.profiles?.full_name || 'P').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-white">{p.business_name || p.profiles?.full_name || 'Provider'}</h3>
                      {p.is_verified && <CheckCircle className="w-3.5 h-3.5 text-[#138808] flex-shrink-0" />}
                    </div>
                    <p className="text-xs text-[#FF9933]">{p.service_categories?.name}</p>
                    <div className="flex items-center gap-3 mt-2">
                      <span className="flex items-center gap-1 text-xs text-gray-400">
                        <Star className="w-3 h-3 fill-[#FF9933] text-[#FF9933]" />
                        {(p.rating || 0).toFixed(1)}
                      </span>
                      <span className="flex items-center gap-1 text-xs text-gray-400">
                        <MapPin className="w-3 h-3" />
                        {p.city || 'N/A'}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
