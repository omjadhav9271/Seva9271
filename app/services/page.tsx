'use client';

import { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Search, MapPin, Star, SlidersHorizontal, CheckCircle, Clock, Compass } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { ProviderSearchResult } from '@/lib/supabase';
import {
  MAX_RADIUS_KM, PAGE_SIZE, RADIUS_STEPS_KM, catalogOrder, effectiveSort, fetchCityAnchors,
  formatDistance, searchProvidersWidening,
  type CityAnchor, type SearchOrigin, type SortMode,
} from '@/lib/matching';
import SearchLocation from '@/components/search-location';
import SearchControls from '@/components/search-controls';
import { chipLabel, fetchCategories, styleFor, type CategoryRow } from '@/lib/categories';

type ProviderCard = {
  id: string;
  business_name: string | null;
  category: string;
  slug: string;
  rating: number;
  total_reviews: number;
  hourly_rate: number;
  experience_years: number;
  city: string | null;
  is_verified: boolean;
  is_available: boolean;
  avatar: string;
  color: string;
  bio: string | null;
  /* Step 11: null until we know where the customer is. Distance, never coordinates. */
  distanceKm: number | null;
};

function initials(name: string | null): string {
  if (!name) return '?';
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
}

function ServicesContent() {
  const searchParams = useSearchParams();
  const [searchQuery, setSearchQuery] = useState(searchParams.get('q') || '');
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || '');
  /* 'match' from the start, and never reassigned behind the customer's back. The old page flipped
     this to 'match' on the first successful rank, which meant the sort silently changed under
     anyone who had already chosen one. Catalog mode simply DISPLAYS 'rating' (see below) — it is
     the order the catalog query uses — without writing that into state. */
  const [sortBy, setSortBy] = useState<SortMode>('match');
  const [minRating, setMinRating] = useState(0);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [catalog, setCatalog] = useState<ProviderCard[]>([]);
  const [ranked, setRanked] = useState<ProviderCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState<SearchOrigin | null>(null);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  /* Which radius actually produced the rows on screen. Null until we have ranked. Rendered
     whenever it isn't the near one, because a customer looking at a provider 40 km away deserves
     to be told that is what happened rather than left to work it out from the distance labels. */
  const [radiusKm, setRadiusKm] = useState<number | null>(null);
  const [anchors, setAnchors] = useState<CityAnchor[]>([]);
  /* Paging. Grows rather than offsets: the ordering is deterministic (20260824120000), so a bigger
     limit returns a stable superset and nothing jumps between pages. */
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /* The category chips come from the DB, not a hardcoded array: service_categories is
     admin-managed, so a mirrored list goes stale on the next insert. It already had — 11 of 25
     categories (Laundry, Maid, Painter, Tailor, Security, Water Tanker…) could not be filtered
     here at all. slug → id is kept alongside so the choice can be pushed INTO the RPC rather than
     filtered out of its results afterwards. */
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  /* useMemo is load-bearing, not a micro-optimisation. This map is an effect dependency (below),
     and an object literal rebuilt every render is a NEW identity every render — so the effect
     re-queried, setRanked produced a new array, that re-rendered, and round it went: measured at
     **13.5 search_providers calls per second on a page nobody was touching**. Keyed to `categories`,
     the identity only changes when the categories actually do. */
  const categoryIds = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.slug, c.id])),
    [categories],
  );

  // The catalog always loads: it is the fallback when the customer won't share a location, and it
  // is what the city list is built from.
  /* 🔴 BOUNDED AND SERVER-ORDERED — see /providers for the write-up. The unbounded version was
     silently capped at 1,000 rows by PostgREST, hiding 85 of 1,085 providers and turning the
     client-side sort into a sort of a sample. */
  const catalogSort = effectiveSort(sortBy, false);
  useEffect(() => {
    /* 🔴 Don't fetch a catalog nobody will read. `providers = ranked ?? catalog`, so once we know
       where the customer is, the catalog is dead weight — yet this effect depends on every filter,
       so each sort/category/availability change was firing a SECOND full query whose result was
       discarded on arrival. Two round trips per interaction, one of them pure waste, and invisible
       to the existing "no re-query loop" assertion because that one only counts search_providers.
       Clearing the location re-runs this and the catalog comes back.

       🔴 setLoading(false) BEFORE returning — see /providers. If the prefill sets `origin` while
       the mount-time catalog fetch is still in flight, that run is marked stale and never clears
       `loading`, and this run would return without clearing it either: a page stuck on its
       loading state for exactly the customers who have already granted location. */
    if (origin) { setLoading(false); return; }
    let mounted = true;
    (async () => {
      const order = catalogOrder(catalogSort);
      let q = supabase
        .from('service_providers')
        .select('id, business_name, bio, rating, total_reviews, hourly_rate, experience_years, city, is_verified, is_available, service_categories(name, slug)')
        .eq('status', 'approved');
      if (availableOnly) q = q.eq('is_available', true);
      if (minRating > 0) q = q.gte('rating', minRating);
      // category_id, not the embedded slug: filtering an embed without !inner narrows the EMBED,
      // not the parent rows — every provider would still come back, just with a null category.
      if (selectedCategory && categoryIds[selectedCategory]) q = q.eq('category_id', categoryIds[selectedCategory]);
      // The text box belongs in the query now the catalog is a CUT. Sanitised because PostgREST's
      // or() is comma/paren delimited and raw punctuation would corrupt the filter.
      const term = searchQuery.trim().replace(/[^\p{L}\p{N} ]/gu, '');
      if (term) q = q.or(`business_name.ilike.*${term}*,city.ilike.*${term}*`);
      const { data, error } = await q
        .order(order.column, { ascending: order.ascending, nullsFirst: order.nullsFirst })
        .order('id', { ascending: true })
        .limit(limit + 1);
      if (!mounted) return;
      if (error) {
        console.error('Failed to load providers:', error.message);
        setCatalog([]);
      } else {
        const rows = (data ?? []).slice(0, limit);
        if (!origin) setHasMore((data ?? []).length > limit);
        const mapped: ProviderCard[] = rows.map((p: any) => ({
          id: p.id,
          business_name: p.business_name,
          category: p.service_categories?.name ?? 'Service',
          slug: p.service_categories?.slug ?? '',
          rating: Number(p.rating),
          total_reviews: p.total_reviews,
          hourly_rate: p.hourly_rate,
          experience_years: p.experience_years,
          city: p.city,
          is_verified: p.is_verified,
          is_available: p.is_available,
          avatar: initials(p.business_name),
          color: styleFor(p.service_categories?.slug).gradient,
          bio: p.bio,
          distanceKm: null,
        }));
        setCatalog(mapped);
      }
      setLoading(false);
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, catalogSort, availableOnly, minRating, limit, selectedCategory, categoryIds, searchQuery]);

  useEffect(() => {
    let mounted = true;
    fetchCityAnchors().then((list) => { if (mounted) setAnchors(list); });
    fetchCategories().then((list) => { if (mounted) setCategories(list); });
    return () => { mounted = false; };
  }, []);

  /* Step 11 — the ranked path. search_providers blends proximity, the Step-7 reputation_score and
     availability server-side; we keep its order and simply render it.

     EVERY filter goes INTO the query — category, text, rating floor, availability. Any one of them
     applied client-side to an unfiltered top-60 quietly hides most of the results: searching
     electricians near Kalyan returned 2 of the 7 within range, and the 5 it dropped included
     nearer ones. Measured again from Mumbai centre on 2026-08-10, the text box was worse —
     "electric" showed **2 of the 11** in range, because only 2 of the matches happened to sit in
     the 60 rows the browser was filtering. A filter applied after a ranked cut is not a filter, it
     is a sample.

     runSearch takes no filter arguments on purpose: it reads the current filter state directly, so
     a new filter cannot be half-wired by forgetting to thread it through one of the call sites.
     That is exactly how the rating and availability filters stayed client-side while the category
     and the text query were moved server-side. */
  const runSearch = useCallback(async (next: SearchOrigin) => {
    setOrigin(next);
    /* Widening, not a fixed radius. A 25 km cut-off returned an EMPTY PAGE the moment the nearest
       provider was 26 km away — which looks like a broken product rather than thin supply, and is
       the opposite of what this page is for. searchProvidersWidening tries 15 km, then 50, then
       150, stopping as soon as it has three; past 150 it returns nothing and we say so in words. */
    const res = await searchProvidersWidening({
      origin: next,
      categoryId: selectedCategory ? categoryIds[selectedCategory] ?? null : null,
      limit,
      query: searchQuery,
      minRating,
      availableOnly,
      sort: sortBy,
    });
    if ('error' in res) {
      console.error('search_providers failed:', res.error);
      setRanked(null);
      setRadiusKm(null);
      setLocationNote('Could not rank by distance just now — showing all providers instead.');
      return;
    }
    setRadiusKm(res.radiusKm);
    setHasMore(res.hasMore);
    setLoadingMore(false);
    setRanked(res.data.map((p: ProviderSearchResult) => ({
      id: p.id,
      business_name: p.business_name,
      category: p.category_name ?? 'Service',
      slug: p.category_slug ?? '',
      rating: Number(p.rating),
      total_reviews: p.total_reviews,
      hourly_rate: p.hourly_rate,
      experience_years: p.experience_years,
      city: p.city,
      is_verified: p.is_verified,
      is_available: p.is_available,
      avatar: initials(p.business_name),
      color: styleFor(p.category_slug).gradient,
      bio: p.bio,
      distanceKm: p.distance_km,
    })));
    setLocationNote(null);
  }, [categoryIds, selectedCategory, searchQuery, minRating, availableOnly, sortBy, limit]);

  /* ONE re-query path for every filter. Each of these belongs in the query rather than applied to
     what came back, so each must re-run the search; debounced together so a burst of adjustments
     (or typing) collapses into one round trip.
     categoryIds is a dependency on purpose: if the slug→id map is still loading when a category is
     picked, the first query goes out unfiltered — this re-runs it properly once the ids arrive. */
  useEffect(() => {
    if (!origin || !ranked) return;
    const t = setTimeout(() => { runSearch(origin); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory, categoryIds, searchQuery, minRating, availableOnly, sortBy, limit]);

  // Changing what you searched for restarts the page count, or a narrowed search would keep
  // rendering however many pages the previous, broader one had loaded.
  useEffect(() => { setLimit(PAGE_SIZE); },
    [selectedCategory, searchQuery, minRating, availableOnly, sortBy, origin]);

  /* One entry point for "where am I searching from", whichever of the three inputs produced it —
     device location, a typed pincode, or the city list. SearchLocation owns collecting it; this
     page owns what to do with it. */
  const handleOrigin = useCallback((next: SearchOrigin | null) => {
    if (!next) {
      setOrigin(null);
      setRanked(null);
      setRadiusKm(null);
      return;
    }
    void runSearch(next);
  }, [runSearch]);

  /* The homepage hero sends the city it was given as ?city=. Honouring it here is what makes that
     control real: the customer arrives already ranked from their city, rather than on the flat
     catalog with their choice silently dropped. Waits for the anchors, since the city is only
     meaningful once we have a point to search from; an unknown city says so rather than pretending. */
  const cityParam = searchParams.get('city') || '';
  const [cityParamApplied, setCityParamApplied] = useState(false);
  useEffect(() => {
    if (cityParamApplied || !cityParam || anchors.length === 0) return;
    setCityParamApplied(true);
    const anchor = anchors.find((a) => a.city === cityParam);
    if (!anchor) { setLocationNote(`We don't have enough providers in ${cityParam} to search from yet.`); return; }
    handleOrigin({ lat: anchor.lat, lng: anchor.lng, label: cityParam });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors, cityParam, cityParamApplied]);

  const providers = ranked ?? catalog;

  /* Every filter now runs in the QUERY — the RPC in ranked mode, PostgREST in catalog mode — so
     nothing is filtered here. The category check survives only to cover the window before the
     slug→id map has loaded, when the query necessarily goes out unfiltered. */
  const filtered = providers.filter((p) => !selectedCategory || p.slug === selectedCategory);

  /* In RANKED mode the ORDER BY ran in the query (p_sort), so these rows already arrived in the
     order the customer asked for — re-sorting them here would be the same mistake as re-filtering
     them: a client-side "Top rated" over a match-ranked cut shows the best rated OF THE 60
     NEAREST-AND-MOST-REPUTABLE, which is not what the control says.
     In CATALOG mode there is no cut — that query returns every approved provider — so ordering it
     here orders the whole set, which is honest. Two modes, two mechanisms, one reason. */
  const shownSort = effectiveSort(sortBy, Boolean(ranked));
  const sorted = filtered;

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      {/* Header */}
      <div className="bg-[#0a0a0a] border-b border-[#1e1e1e] py-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-black text-white mb-2">Browse Services</h1>
          <p className="text-gray-400 mb-6">Find verified professionals near you</p>

          {/* What to find, and where from. The location half is a shared control (device location,
              a typed pincode, or a city) so this page and /providers cannot drift apart — they
              already carried two copies of the city picker once. */}
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3">
              <Search className="w-5 h-5 text-gray-500 flex-shrink-0" />
              <input
                type="text"
                placeholder="Search services or providers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
              />
            </div>
            {/* Arriving with ?city= IS a location choice — don't let the passive GPS prefill
                overrule it. The homepage hero's whole point is that the city it was given survives
                the trip to this page. */}
            <SearchLocation origin={origin} onOrigin={handleOrigin} autoLocate={!cityParam} />
          </div>

          {locationNote && (
            <p className="text-xs text-gray-400 mt-3 flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-gray-500" />{locationNote}
            </p>
          )}
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
          {categories.map((cat) => {
            const { icon: Icon, color } = styleFor(cat.slug);
            const active = selectedCategory === cat.slug;
            return (
              <button
                key={cat.slug}
                onClick={() => setSelectedCategory(active ? '' : cat.slug)}
                title={cat.name}
                className={`flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  active
                    ? 'bg-[#FF9933] text-white shadow-lg shadow-[#FF9933]/20'
                    : 'bg-[#1a1a1a] border border-[#2a2a2a] text-gray-300 hover:border-[#FF9933]/50'
                }`}
              >
                <Icon className="w-4 h-4" style={{ color: active ? 'white' : color }} />
                {chipLabel(cat.name)}
              </button>
            );
          })}
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
                  onClick={() => { setMinRating(0); setAvailableOnly(false); setSortBy('match'); }}
                  className="text-xs text-[#FF9933] hover:text-[#e8872e]"
                >
                  Reset
                </button>
              </div>

              {/* Min Rating. A star floor is a control a normal person already understands ("4+"),
                  which is why it stays while a trust-score threshold is deliberately not offered:
                  ranking already weighs reputation, and asking the customer to set a minimum on a
                  manipulation-resistant composite hands them our job. */}
              <div>
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
                <p className="text-[11px] text-gray-600 mt-2 leading-relaxed">
                  A floor on the star average — providers with no reviews yet are excluded by any
                  rating filter.
                </p>
              </div>
            </div>
          </aside>

          {/* Results */}
          <div className="flex-1">
            <div className="flex flex-col gap-4 mb-6">
              <SearchControls
                sort={shownSort}
                onSort={setSortBy}
                availableOnly={availableOnly}
                onAvailableOnly={setAvailableOnly}
                ranked={Boolean(ranked)}
              />
              <p className="text-gray-400 text-sm">
                <span className="text-white font-semibold">{sorted.length}</span> providers found
                {origin && ranked
                  ? <> near <span className="text-white font-semibold">{origin.label}</span></>
                  : <> <span className="text-gray-500">— share your location to rank by distance.</span></>}
              </p>

              {/* Say it when we had to look further out. A customer scanning "12.4 km away" should
                  not have to infer that nobody nearer exists. */}
              {ranked && sorted.length > 0 && radiusKm !== null && radiusKm > RADIUS_STEPS_KM[0] && (
                <p className="text-xs text-[#FF9933] flex items-center gap-1.5">
                  <Compass className="w-3.5 h-3.5" />
                  Nobody within {RADIUS_STEPS_KM[0]} km — showing the nearest providers within {radiusKm} km.
                </p>
              )}
            </div>

            {sorted.length === 0 ? (
              /* The honest empty state. Ranked-and-empty means we looked as far as it is
                 reasonable to travel for a home service and found nobody — say that, rather than
                 leaving a blank column that reads as a broken page. */
              ranked ? (
                <div className="text-center py-20">
                  <Compass className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                  <p className="text-gray-300 text-lg mb-2">No providers serve your area yet — we&apos;re expanding.</p>
                  <p className="text-gray-500 text-sm">
                    We looked up to {MAX_RADIUS_KM} km from {origin?.label ?? 'your location'}
                    {(selectedCategory || searchQuery || minRating > 0 || availableOnly) && <> with your filters applied</>}.
                    {(selectedCategory || searchQuery || minRating > 0 || availableOnly)
                      ? ' Clearing a filter may help.'
                      : ' Try another location in the meantime.'}
                  </p>
                </div>
              ) : (
                <div className="text-center py-20">
                  <p className="text-gray-400 text-lg mb-2">No providers found</p>
                  <p className="text-gray-600 text-sm">Try adjusting your filters or search query</p>
                </div>
              )
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
                          {/* How far, never where — provider coordinates never reach the client. */}
                          <div className="flex items-center gap-1">
                            <MapPin className="w-3 h-3 text-gray-500" />
                            {formatDistance(provider.distanceKm)
                              ? <span className="text-xs text-[#FF9933] font-medium">{formatDistance(provider.distanceKm)}</span>
                              : <span className="text-xs text-gray-400">{provider.city}</span>}
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

            {/* More exist — detected by asking for one row past the page, so it can never disagree
                with the list it labels. */}
            {sorted.length > 0 && hasMore && (
              <div className="mt-8 text-center">
                <button
                  type="button"
                  onClick={() => { setLoadingMore(true); setLimit((n) => n + PAGE_SIZE); }}
                  disabled={loadingMore}
                  className="px-6 py-3 rounded-xl text-sm font-semibold bg-[#1a1a1a] border border-[#2a2a2a] text-white hover:border-[#FF9933] transition-colors disabled:opacity-60"
                >
                  {loadingMore ? 'Loading…' : `Show ${PAGE_SIZE} more`}
                </button>
                <p className="text-xs text-gray-600 mt-2">
                  Showing the {sorted.length} best matches so far — there are more.
                </p>
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
