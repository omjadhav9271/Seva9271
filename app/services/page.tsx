'use client';

import { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Search, MapPin, Star, Filter, ChevronDown, SlidersHorizontal,
  CheckCircle, Clock, X, Navigation, Loader2
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { ProviderSearchResult } from '@/lib/supabase';
import {
  DEFAULT_RADIUS_KM, fetchCityAnchors, formatDistance, requestBrowserLocation, searchProviders,
  type CityAnchor, type SearchOrigin,
} from '@/lib/matching';
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
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState(searchParams.get('q') || '');
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || '');
  const [sortBy, setSortBy] = useState('rating');
  const [showFilters, setShowFilters] = useState(false);
  const [minRating, setMinRating] = useState(0);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [catalog, setCatalog] = useState<ProviderCard[]>([]);
  const [ranked, setRanked] = useState<ProviderCard[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [locating, setLocating] = useState(false);
  const [origin, setOrigin] = useState<SearchOrigin | null>(null);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const [cityChoice, setCityChoice] = useState('');
  const [anchors, setAnchors] = useState<CityAnchor[]>([]);
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
        const mapped: ProviderCard[] = (data ?? []).map((p: any) => ({
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
  }, []);

  useEffect(() => {
    let mounted = true;
    fetchCityAnchors().then((list) => { if (mounted) setAnchors(list); });
    fetchCategories().then((list) => { if (mounted) setCategories(list); });
    return () => { mounted = false; };
  }, []);

  /* Step 11 — the ranked path. search_providers blends proximity, the Step-7 reputation_score and
     availability server-side; we keep its order and simply render it.

     The category AND the typed text both go INTO the query. Either one applied client-side to an
     unfiltered top-60 quietly hides most of the results: searching electricians near Kalyan
     returned 2 of the 7 within range, and the 5 it dropped included nearer ones. Measured again
     from Mumbai centre on 2026-08-10, the text box was worse — "electric" showed **2 of the 11**
     in range, because only 2 of the matches happened to sit in the 60 rows the browser was
     filtering. A filter applied after a ranked cut is not a filter, it is a sample. */
  const runSearch = useCallback(async (next: SearchOrigin, categorySlug = '', query = '') => {
    setOrigin(next);
    const res = await searchProviders({
      origin: next,
      categoryId: categorySlug ? categoryIds[categorySlug] ?? null : null,
      radiusKm: DEFAULT_RADIUS_KM,
      limit: 60,
      query,
    });
    if ('error' in res) {
      console.error('search_providers failed:', res.error);
      setRanked(null);
      setLocationNote('Could not rank by distance just now — showing all providers instead.');
      return;
    }
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
    setSortBy('match');
  }, [categoryIds]);

  // Changing the category while a location is known must re-query the server, not re-filter what
  // we already have — otherwise the category is applied to a ranked sample of the wrong set.
  useEffect(() => {
    if (!origin || !ranked) return;
    runSearch(origin, selectedCategory, searchQuery);
    // categoryIds is a dependency on purpose: if the slug→id map is still loading when a category
    // is picked, the first query goes out unfiltered — this re-runs it properly once ids arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory, categoryIds]);

  // Re-query as they type, but not on every keystroke.
  useEffect(() => {
    if (!origin || !ranked) return;
    const t = setTimeout(() => { runSearch(origin, selectedCategory, searchQuery); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const useMyLocation = async () => {
    setLocating(true);
    setLocationNote(null);
    const pos = await requestBrowserLocation();
    setLocating(false);
    if ('error' in pos) {
      // Declined or unavailable: fall back to the full list and say so plainly — never a dead end.
      setRanked(null);
      setOrigin(null);
      if (sortBy === 'match') setSortBy('rating');
      setLocationNote(pos.error);
      return;
    }
    setCityChoice('');
    await runSearch({ ...pos, label: 'your location' }, selectedCategory, searchQuery);
  };

  const onCityChoice = async (city: string) => {
    setCityChoice(city);
    if (!city) {
      setOrigin(null);
      setRanked(null);
      if (sortBy === 'match') setSortBy('rating');
      return;
    }
    const anchor = anchors.find((a) => a.city === city);
    if (!anchor) { setLocationNote(`We don't have enough providers in ${city} to search from yet.`); return; }
    setLocationNote(null);
    await runSearch({ lat: anchor.lat, lng: anchor.lng, label: city }, selectedCategory, searchQuery);
  };

  /* The homepage hero sends the city it was given as ?city=. Honouring it here is what makes that
     control real: the customer arrives already ranked from their city, rather than on the flat
     catalog with their choice silently dropped. Waits for the anchors, since the city is only
     meaningful once we have a point to search from; an unknown city says so rather than pretending. */
  const cityParam = searchParams.get('city') || '';
  const [cityParamApplied, setCityParamApplied] = useState(false);
  useEffect(() => {
    if (cityParamApplied || !cityParam || anchors.length === 0) return;
    setCityParamApplied(true);
    onCityChoice(cityParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors, cityParam, cityParamApplied]);

  const providers = ranked ?? catalog;

  const filtered = providers.filter((p) => {
    /* In ranked mode the SERVER already applied the text search across everything in range, so
       re-applying it here could only narrow a correct result set back down to a sample. The
       client-side match remains for catalog mode, where there is no query to push down. */
    const matchesSearch = ranked ? true : !searchQuery ||
      (p.business_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = !selectedCategory || p.slug === selectedCategory;
    const matchesRating = p.rating >= minRating;
    const matchesAvailable = !availableOnly || p.is_available;
    return matchesSearch && matchesCategory && matchesRating && matchesAvailable;
  });

  const sorted = [...filtered].sort((a, b) => {
    // 'match' = the server's blended ranking. Return 0 and let the stable sort preserve the exact
    // order search_providers gave us — re-sorting it here would quietly discard the ranking.
    if (sortBy === 'match') return 0;
    if (sortBy === 'distance') return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
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

          {/* Search Bar. The "Location" box here used to be an input wired to nothing — a dead
              control, which the honest-signposting principle forbids. It is now the real Step-11
              location choice: device location, or a city to search from if they'd rather not. */}
          <div className="flex flex-col sm:flex-row gap-3 max-w-3xl">
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
            <button
              type="button"
              onClick={useMyLocation}
              disabled={locating}
              className="flex items-center justify-center gap-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-white hover:border-[#FF9933] transition-colors disabled:opacity-60"
            >
              {locating
                ? <><Loader2 className="w-4 h-4 animate-spin" />Finding you…</>
                : <><Navigation className="w-4 h-4 text-[#FF9933]" />Use my location</>}
            </button>
            <select
              value={cityChoice}
              onChange={(e) => onCityChoice(e.target.value)}
              className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#FF9933] min-w-[150px]"
            >
              <option value="">Or pick a city</option>
              {anchors.map((a) => <option key={a.city} value={a.city}>{a.city} ({a.provider_count})</option>)}
            </select>
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
                  onClick={() => { setMinRating(0); setAvailableOnly(false); setSortBy(ranked ? 'match' : 'rating'); }}
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
                    // Only offered once we know where they are — it's the server's blended
                    // proximity + reputation + availability ranking, not a client-side sort.
                    ...(ranked ? [
                      { value: 'match', label: 'Best match' },
                      // "Best match" trades a little distance for reputation, which is right by
                      // default but not always what someone wants — if you need a plumber NOW,
                      // nearest is the question you are asking. Only offered when we know where
                      // the customer is; there is nothing to sort by otherwise.
                      { value: 'distance', label: 'Nearest first' },
                    ] : []),
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
                {origin && ranked
                  ? <> near <span className="text-white font-semibold">{origin.label}</span></>
                  : <> <span className="text-gray-500">— share your location to rank by distance.</span></>}
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
