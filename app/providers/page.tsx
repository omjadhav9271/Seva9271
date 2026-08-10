'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Search, Star, MapPin, Clock, CheckCircle, Users, Compass } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { ProviderSearchResult } from '@/lib/supabase';
import {
  MAX_RADIUS_KM, RADIUS_STEPS_KM, catalogComparator, effectiveSort, fetchCityAnchors,
  formatDistance, searchProvidersWidening,
  type CityAnchor, type SearchOrigin, type SortMode,
} from '@/lib/matching';
import SearchLocation from '@/components/search-location';
import SearchControls from '@/components/search-controls';
import { styleFor } from '@/lib/categories';

/* Step 11: the list is now RANKED, not sorted by star average. Two sources feed the same card:
   the search_providers RPC once we know where the customer is (ranked by proximity + the Step-7
   reputation_score + availability, each row carrying a distance), and the plain catalog query when
   we don't (they declined, or haven't asked yet). Declining location must never dead-end them —
   it just costs the distance line and the ranking. Provider coordinates appear in neither path. */

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

/** One shape for the card, whichever source produced it. distanceKm is null in catalog mode. */
type Card = {
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
  categoryName: string;
  categorySlug: string;
  distanceKm: number | null;
};

/* Category colours live in lib/categories.ts — this page carried its own partial copy covering 12
   of 25 slugs, so half the catalog rendered slate-grey. One map, one place, with a default. */

function initials(name: string | null): string {
  if (!name) return '?';
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
}

export default function ProvidersPage() {
  const [catalog, setCatalog] = useState<ProviderRow[]>([]);
  const [ranked, setRanked] = useState<ProviderSearchResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState<SearchOrigin | null>(null);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortMode>('match');
  const [availableOnly, setAvailableOnly] = useState(false);
  // Which radius produced the rows on screen — shown when it isn't the near one.
  const [radiusKm, setRadiusKm] = useState<number | null>(null);
  // The cities we can actually rank from. Built from the data, so the dropdown can never offer a
  // city that then silently degrades to the unranked list.
  const [anchors, setAnchors] = useState<CityAnchor[]>([]);

  // The catalog always loads: it's the fallback, and it supplies the city list.
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
        setCatalog([]);
      } else {
        setCatalog((data ?? []) as unknown as ProviderRow[]);
      }
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    fetchCityAnchors().then((list) => { if (mounted) setAnchors(list); });
    return () => { mounted = false; };
  }, []);

  /* The typed text, the sort and the availability filter all go INTO the query. The text used to
     filter the 30 rows the RPC had already ranked, which meant "electrician" searched whatever
     happened to come back rather than the electricians in range — a nearer, better-rated one at
     rank 31 was invisible while the box looked like it worked.

     Widening, not a fixed radius: 15 km, then 50, then 150, stopping as soon as three come back.
     A hard 25 km cut showed a blank page the moment the nearest provider was 26 km away, which
     reads as a broken product rather than as thin supply. Filters ride along unchanged — widening
     finds more people, it must never quietly relax what the customer asked for. */
  const runSearch = useCallback(async (next: SearchOrigin) => {
    setOrigin(next);
    const res = await searchProvidersWidening({
      origin: next, query: search, sort: sortBy, availableOnly,
    });
    if ('error' in res) {
      console.error('search_providers failed:', res.error);
      setRanked(null);
      setRadiusKm(null);
      setLocationNote('Could not rank by distance just now — showing all providers instead.');
      return;
    }
    setRanked(res.data);
    setRadiusKm(res.radiusKm);
    setLocationNote(null);
  }, [search, sortBy, availableOnly]);

  /* ONE debounced re-query for everything that belongs in the query — the typed text, the sort and
     the availability filter. runSearch takes no filter arguments on purpose (the same shape
     /services adopted): it reads current state, so a new control cannot be half-wired by forgetting
     to thread it through one call site. */
  useEffect(() => {
    if (!origin || !ranked) return;
    const t = setTimeout(() => { runSearch(origin); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sortBy, availableOnly]);

  const handleOrigin = useCallback((next: SearchOrigin | null) => {
    if (!next) { setOrigin(null); setRanked(null); setRadiusKm(null); return; }
    void runSearch(next);
  }, [runSearch]);

  const cards: Card[] = ranked
    ? ranked.map((p) => ({
        id: p.id,
        business_name: p.business_name,
        bio: p.bio,
        rating: Number(p.rating),
        total_reviews: p.total_reviews,
        hourly_rate: p.hourly_rate,
        experience_years: p.experience_years,
        city: p.city,
        is_verified: p.is_verified,
        is_available: p.is_available,
        categoryName: p.category_name ?? 'Service',
        categorySlug: p.category_slug ?? '',
        distanceKm: p.distance_km,
      }))
    : catalog.map((p) => ({
        id: p.id,
        business_name: p.business_name,
        bio: p.bio,
        rating: Number(p.rating),
        total_reviews: p.total_reviews,
        hourly_rate: p.hourly_rate,
        experience_years: p.experience_years,
        city: p.city,
        is_verified: p.is_verified,
        is_available: p.is_available,
        categoryName: p.service_categories?.name ?? 'Service',
        categorySlug: p.service_categories?.slug ?? '',
        distanceKm: null,
      }));

  const filtered = cards.filter((p) => {
    const name = p.business_name ?? '';
    // In ranked mode the SERVER already applied the text search across everything in range, so
    // re-applying it here would only narrow a correct result set. The client-side match remains
    // for catalog mode, where there is no query to push down.
    const matchesSearch = ranked ? true
      : !search || name.toLowerCase().includes(search.toLowerCase()) || p.categoryName.toLowerCase().includes(search.toLowerCase());
    // Availability is a query parameter in ranked mode, for the same reason as the text: applied
    // here it could only sample the rows that came back.
    const matchesAvailable = ranked ? true : (!availableOnly || p.is_available);
    return matchesSearch && matchesAvailable;
  });

  /* Ranked mode arrives pre-ordered by the query (p_sort) and must not be re-sorted — that would
     re-shuffle a cut. Catalog mode is the COMPLETE approved list, so ordering it here orders the
     whole set. See lib/matching.ts. */
  const shownSort = effectiveSort(sortBy, Boolean(ranked));
  const visible = ranked ? filtered : [...filtered].sort(catalogComparator(shownSort));


  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      {/* Header */}
      <div className="bg-[#0a0a0a] border-b border-[#1e1e1e] py-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3 mb-2">
            <Users className="w-8 h-8 text-[#FF9933]" />
            <h1 className="text-3xl font-black text-white">All Providers</h1>
          </div>
          <p className="text-gray-400 mb-6">Browse independent professionals on Seva — every one ID-verified before approval</p>

          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3">
              <Search className="w-5 h-5 text-gray-500" />
              <input
                type="text"
                placeholder="Search by name or category..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
              />
            </div>
            <SearchLocation anchors={anchors} origin={origin} onOrigin={handleOrigin} />
          </div>

          {locationNote && (
            <p className="text-xs text-gray-400 mt-3 flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-gray-500" />{locationNote}
            </p>
          )}

          <div className="mt-5">
            <SearchControls
              sort={shownSort}
              onSort={setSortBy}
              availableOnly={availableOnly}
              onAvailableOnly={setAvailableOnly}
              ranked={Boolean(ranked)}
            />
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading ? (
          <div className="text-center py-20 text-gray-400">Loading providers…</div>
        ) : (
          <>
            <p className="text-gray-400 text-sm mb-2">
              Showing <span className="text-white font-semibold">{visible.length}</span> providers
              {origin && ranked
                ? <> near <span className="text-white font-semibold">{origin.label}</span></>
                : <> — sorted by rating. <span className="text-gray-500">Share your location to rank by distance.</span></>}
            </p>

            {/* Say it when we had to look further out, rather than leaving the customer to infer
                it from the distance labels. */}
            {ranked && visible.length > 0 && radiusKm !== null && radiusKm > RADIUS_STEPS_KM[0] && (
              <p className="text-xs text-[#FF9933] mb-4 flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5" />
                Nobody within {RADIUS_STEPS_KM[0]} km — showing the nearest providers within {radiusKm} km.
              </p>
            )}

            <div className="mb-6" />
            {visible.length === 0 ? (
              <div className="text-center py-20">
                {ranked ? (
                  <>
                    <Compass className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                    <p className="text-gray-300 text-lg mb-2">No providers serve your area yet — we&apos;re expanding.</p>
                    <p className="text-gray-500 text-sm">
                      We looked up to {MAX_RADIUS_KM} km from {origin?.label ?? 'your location'}
                      {(search || availableOnly) ? ' with your filters applied. Clearing a filter may help.' : '. Try another location in the meantime.'}
                    </p>
                  </>
                ) : (
                  <>
                    <Users className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                    <p className="text-gray-400 text-lg mb-2">No providers found</p>
                    <p className="text-gray-600 text-sm">Try adjusting your search.</p>
                  </>
                )}
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {visible.map((p) => {
                  const gradient = styleFor(p.categorySlug).gradient;
                  const distance = formatDistance(p.distanceKm);
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
                          <p className="text-xs text-[#FF9933] font-medium mt-0.5">{p.categoryName}</p>
                          {/* Step 9.5: an unrated provider is NEW, not 0.0 — the engine already
                              starts them at the Bayesian prior, the card just never said so. */}
                          <div className="flex items-center gap-1 mt-1">
                            {p.total_reviews > 0 ? (
                              <>
                                <Star className="w-3 h-3 fill-[#FF9933] text-[#FF9933]" />
                                <span className="text-xs font-semibold text-white">{Number(p.rating).toFixed(1)}</span>
                                <span className="text-xs text-gray-500">({p.total_reviews} reviews)</span>
                              </>
                            ) : (
                              <span className="text-xs font-semibold text-[#5da9ff] bg-[#054187]/20 border border-[#054187]/40 rounded-full px-2 py-0.5">
                                New on Seva
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <p className="text-xs text-gray-400 leading-relaxed mb-4 line-clamp-2">{p.bio}</p>

                      <div className="flex items-center gap-3 text-xs text-gray-500 mb-4">
                        {/* Distance, never a location: the customer learns how far, not where. */}
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {distance ? <span className="text-[#FF9933] font-medium">{distance}</span> : p.city}
                        </span>
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
