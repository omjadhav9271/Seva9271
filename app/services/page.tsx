'use client';

/* /services — the category directory.
 *
 * WHAT THIS PAGE USED TO BE, AND WHY IT ISN'T. Until now /services and /providers were the same
 * page twice: both ranked providers through searchProvidersWidening(), both mounted SearchLocation
 * and SearchControls, both rendered the same card off the same fields, ~450 lines apart. Two tabs
 * that answer one question is a navigation that has to be guessed at rather than read.
 *
 * So the two questions are now split across the two routes. This one answers "what can I get?" —
 * the whole catalogue of trades, with how many people actually do each. /providers answers "who is
 * near me?" and keeps every ranking control. Each tile hands off to /providers?category=<slug>,
 * which that page now honours (it read no URL parameters at all before, so every such link was
 * dead on arrival).
 *
 * The list is the DB's, never a copy of it. The home page used to hardcode 14 of these 25, and the
 * eleven it omitted — mason, tailor, laundry, water tanker, cow dung, cycle repair, auto rickshaw,
 * maid, painter, security, mobile repair — are precisely the ones a marketplace built for India
 * has that a generic one doesn't.
 */

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Search, Layers, ArrowRight, Users } from 'lucide-react';
import { fetchCategories, fetchCategoryCounts, styleFor, type CategoryRow } from '@/lib/categories';

export default function ServicesPage() {
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let on = true;
    (async () => {
      const list = await fetchCategories();
      if (!on) return;
      setCategories(list);
      setLoading(false);
      // Counts arrive after the grid so the page paints immediately; tiles show "—" until they land.
      const c = await fetchCategoryCounts(list);
      if (on) setCounts(c);
    })();
    return () => { on = false; };
  }, []);

  /* Filtering 25 rows already in memory — no query, no round trip. Matches the slug too, so
     typing "cow" finds Cow Dung / Gobar whichever half of the name someone remembers. */
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(q) || c.slug.includes(q));
  }, [categories, filter]);

  const totalProviders = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="bg-[#0a0a0a] border-b border-[#1e1e1e] py-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3 mb-2">
            <Layers className="w-8 h-8 text-[#FF9933]" />
            <h1 className="text-3xl font-black text-white">Browse Services</h1>
          </div>
          <p className="text-gray-400 mb-6">
            {loading
              ? 'Loading the catalogue…'
              : <>Every trade on Seva{totalProviders > 0 && <> — {totalProviders.toLocaleString('en-IN')} verified providers across {categories.length} categories</>}. Pick one to see who is near you.</>}
          </p>

          <div className="max-w-md flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 focus-within:border-[#FF9933]/50 transition-colors">
            <Search className="w-5 h-5 text-gray-500 flex-shrink-0" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a service — plumber, tiffin, tailor…"
              aria-label="Filter services"
              className="flex-1 min-w-0 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-[#2a2a2a] bg-[#161616] p-6 animate-pulse">
                <div className="w-14 h-14 rounded-full bg-[#1e1e1e] mb-4" />
                <div className="h-4 w-2/3 bg-[#1e1e1e] rounded mb-2" />
                <div className="h-3 w-1/3 bg-[#1e1e1e] rounded" />
              </div>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-gray-400 mb-2">No service matches “{filter}”.</p>
            <button onClick={() => setFilter('')} className="text-sm font-medium text-[#FF9933] hover:text-[#e8872e] transition-colors">
              Clear the filter
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {shown.map((cat) => {
              const style = styleFor(cat.slug);
              const Icon = style.icon;
              // undefined = not loaded yet; 0 = genuinely nobody. They read differently on purpose.
              const n = counts[cat.slug];
              return (
                <Link
                  key={cat.slug}
                  href={`/providers?category=${cat.slug}`}
                  className="group rounded-2xl border border-[#2a2a2a] bg-[#161616] p-6 seva-card-hover flex flex-col"
                >
                  <div
                    className={`w-14 h-14 rounded-full bg-gradient-to-br ${style.gradient} flex items-center justify-center mb-4 transition-transform duration-300 group-hover:scale-110`}
                  >
                    <Icon className="w-7 h-7 text-white" />
                  </div>
                  <h2 className="font-semibold text-white text-sm mb-1 group-hover:text-[#FF9933] transition-colors">
                    {cat.name}
                  </h2>
                  <p className="text-xs text-gray-500 flex items-center gap-1.5 mt-auto pt-2">
                    <Users className="w-3.5 h-3.5" />
                    {n === undefined ? '—'
                      : n === 0 ? 'None yet'
                      : `${n.toLocaleString('en-IN')} provider${n === 1 ? '' : 's'}`}
                  </p>
                </Link>
              );
            })}
          </div>
        )}

        {!loading && (
          <div className="mt-10 flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-[#2a2a2a] bg-[#161616] p-6">
            <div>
              <p className="font-semibold text-white">Not sure which trade you need?</p>
              <p className="text-sm text-gray-400">See everyone near you and filter by distance, rating and availability.</p>
            </div>
            <Link href="/providers" className="inline-flex items-center gap-2 saffron-btn rounded-xl px-6 py-3 text-sm font-semibold self-start sm:self-auto whitespace-nowrap">
              Browse all providers <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
