'use client';

import { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Search, Star, MapPin, Clock, CheckCircle, Users, Compass } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { ProviderSearchResult } from '@/lib/supabase';
import {
  MAX_RADIUS_KM, PAGE_SIZE, RADIUS_STEPS_KM, catalogOrder, effectiveSort,
  fetchCityAnchors, formatDistance, searchProvidersWidening,
  type CityAnchor, type SearchOrigin, type SortMode,
} from '@/lib/matching';
import SearchLocation from '@/components/search-location';
import SearchControls from '@/components/search-controls';
import { fetchCategories, styleFor, type CategoryRow } from '@/lib/categories';

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

function ProvidersContent() {
  /* This page is now the ONE ranked list, so it is also the one landing place for every link that
     carries a search: the home page's search box and popular tags, and every tile on the /services
     directory. It previously read no URL parameters at all — `?category=` and `?q=` arrived and
     were silently dropped, which made each of those links a dead control on arrival. */
  const searchParams = useSearchParams();

  const [catalog, setCatalog] = useState<ProviderRow[]>([]);
  const [ranked, setRanked] = useState<ProviderSearchResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState<SearchOrigin | null>(null);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [sortBy, setSortBy] = useState<SortMode>('match');
  const [availableOnly, setAvailableOnly] = useState(false);
  // Which radius produced the rows on screen — shown when it isn't the near one.
  const [radiusKm, setRadiusKm] = useState<number | null>(null);
  /* How many to show. Grows on "Load more" rather than paging by offset: the ordering is
     deterministic (20260824120000 added the id tie-break) so a growing limit returns a stable
     superset, and the customer never sees a provider jump pages. */
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /* WHAT they need, alongside WHERE they are. This page previously offered a city dropdown here
     and no category filter at all, which had it backwards: the city is the thing a customer knows
     least usefully (Greater Mumbai is 60 km wide) and the trade is the thing they came to filter
     on. Categories come from the DB — service_categories is admin-managed, so a mirrored list goes
     stale on the next insert. */
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [categorySlug, setCategorySlug] = useState(searchParams.get('category') || '');
  const [anchors, setAnchors] = useState<CityAnchor[]>([]);

  useEffect(() => {
    let mounted = true;
    fetchCategories().then((list) => { if (mounted) setCategories(list); });
    fetchCityAnchors().then((list) => { if (mounted) setAnchors(list); });
    return () => { mounted = false; };
  }, []);

  /* slug → id, memoised. An object literal rebuilt each render is a NEW identity each render, and
     this feeds the re-query effects below — /services was once measured at 13.5 search calls per
     second on an idle page for exactly that reason. Declared above both effects that read it. */
  const categoryIds = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.slug, c.id])),
    [categories],
  );

  /* The catalog: the honest fallback when we don't know where the customer is.

     🔴 BOUNDED AND SERVER-ORDERED. This used to be an unbounded select ordered client-side, which
     PostgREST silently capped at 1,000 rows — at 1,085 approved providers that hid 85 of them and,
     worse, turned the client-side sort into a sort of a SAMPLE. Now it asks for exactly one page
     more than it shows, in the order the customer chose, so the cut is taken from the right
     ordering and "is there more" is answered by the same query that drew the page. */
  const catalogSort = effectiveSort(sortBy, false);
  useEffect(() => {
    /* 🔴 Skip entirely once we are ranking — see the same guard on /services. `cards` reads from
       `ranked` when it exists, so every catalog query fired while ranked was a full round trip
       whose result was discarded on arrival.

       🔴 setLoading(false) BEFORE returning — omitting it HUNG THE PAGE. The catalog fetch starts
       on mount; the GPS prefill sets `origin` while it is still in flight; the effect re-runs, its
       cleanup marks the first run stale, and that run's `if (!mounted) return` skips its own
       setLoading(false). Without the line below the new run does nothing at all, so `loading`
       stays true and a returning customer who already granted location sits on
       "Loading providers…" forever. Caught by the assertion added alongside this guard. */
    if (origin) { setLoading(false); return; }
    let mounted = true;
    (async () => {
      const order = catalogOrder(catalogSort);
      let q = supabase
        .from('service_providers')
        .select('id, business_name, bio, rating, total_reviews, hourly_rate, experience_years, city, is_verified, is_available, service_categories(name, slug)')
        .eq('status', 'approved');
      /* Filter by category_id, NOT by the embedded service_categories.slug: a filter on an
         embedded resource without !inner narrows the EMBED, not the parent rows, so the page would
         still show every provider (with a null category on the non-matching ones). Wrong in a way
         that looks like it works. */
      if (categorySlug && categoryIds[categorySlug]) q = q.eq('category_id', categoryIds[categorySlug]);
      if (availableOnly) q = q.eq('is_available', true);
      // Name search belongs in the query too now the catalog is a CUT — filtering the page would
      // search the 30 rows we happened to fetch. Sanitised: PostgREST's or() is comma/paren
      // delimited, so raw punctuation from the box would corrupt the filter.
      const q2 = search.trim().replace(/[^\p{L}\p{N} ]/gu, '');
      if (q2) q = q.or(`business_name.ilike.*${q2}*,city.ilike.*${q2}*`);
      const { data, error } = await q
        .order(order.column, { ascending: order.ascending, nullsFirst: order.nullsFirst })
        .order('id', { ascending: true })          // deterministic tie-break, as the RPC has
        .limit(limit + 1);
      if (!mounted) return;
      if (error) {
        console.error('Failed to load providers:', error.message);
        setCatalog([]);
      } else {
        const rows = (data ?? []) as unknown as ProviderRow[];
        setCatalog(rows.slice(0, limit));
        if (!origin) setHasMore(rows.length > limit);
      }
      setLoading(false);
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, catalogSort, categorySlug, categoryIds, availableOnly, limit, search]);

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
      origin: next, query: search, sort: sortBy, availableOnly, limit,
      categoryId: categorySlug ? categoryIds[categorySlug] ?? null : null,
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
    setHasMore(res.hasMore);
    setLoadingMore(false);
    setLocationNote(null);
  }, [search, sortBy, availableOnly, categorySlug, categoryIds, limit]);

  /* ONE debounced re-query for everything that belongs in the query — the typed text, the sort and
     the availability filter. runSearch takes no filter arguments on purpose (the same shape
     /services adopted): it reads current state, so a new control cannot be half-wired by forgetting
     to thread it through one call site. */
  useEffect(() => {
    if (!origin || !ranked) return;
    const t = setTimeout(() => { runSearch(origin); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sortBy, availableOnly, categorySlug, categoryIds, limit]);

  /* Changing what you are searching for restarts the page count. Without this, narrowing from
     "all services" to one category would keep showing however many pages you had already loaded,
     so a 30-result category would silently render as one page of a 120-row request. */
  useEffect(() => { setLimit(PAGE_SIZE); }, [search, sortBy, availableOnly, categorySlug, origin]);

  const handleOrigin = useCallback((next: SearchOrigin | null) => {
    if (!next) { setOrigin(null); setRanked(null); setRadiusKm(null); return; }
    void runSearch(next);
  }, [runSearch]);

  /* `?city=` from the home page's city picker, honoured exactly as /services honours it — same
     shape deliberately, so the two landing pages cannot drift apart on what a link means. Waits
     for the anchors, because a city is only meaningful once there is a point to search from, and
     an unrecognised city says so rather than quietly ranking from nowhere. */
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

  /* Both modes filter in the QUERY now — the RPC in ranked mode, PostgREST in catalog mode — so
     there is nothing left to filter here. The one exception is the window before the slug→id map
     has loaded, when a category query necessarily goes out unfiltered; this catches that. */
  const filtered = cards.filter((p) => !categorySlug || p.categorySlug === categorySlug);

  /* NOTHING is sorted here. Both modes now order in the query — the RPC via p_sort, the catalog
     via .order() — so re-sorting either would re-shuffle a cut and answer a different question
     than the control asks. That was true of ranked mode from the start and became true of the
     catalog the moment PostgREST's 1,000-row cap made it a cut too. */
  const shownSort = effectiveSort(sortBy, Boolean(ranked));
  const visible = filtered;


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
            <div className="flex flex-col sm:flex-row gap-3">
              {/* WHAT they need. A dropdown rather than the chip strip /services uses, because
                  this page is a directory rather than a browse surface — and because it replaced
                  a city picker in this slot, which is the control that does not scale as we add
                  Indian cities. */}
              <select
                value={categorySlug}
                onChange={(e) => setCategorySlug(e.target.value)}
                aria-label="Service category"
                className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#FF9933] sm:min-w-[220px]"
              >
                <option value="">All services</option>
                {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
              {/* Name search stays: "the electrician my neighbour recommended" is a real journey.
                  It narrows WITHIN the category rather than being the primary way in. */}
              <div className="flex-1 flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3">
                <Search className="w-5 h-5 text-gray-500" />
                <input
                  type="text"
                  placeholder="Search by name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
                />
              </div>
            </div>
            <SearchLocation origin={origin} onOrigin={handleOrigin} />
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

            {/* "More exist" is answered by the same query that drew the page — we ask for one row
                past the page and show this if it comes back. No count query to disagree with the
                list, and no claim about a total we did not measure. */}
            {visible.length > 0 && hasMore && (
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
                  Showing the {visible.length} best matches so far — there are more.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* useSearchParams() forces this subtree to render on the client, and Next requires the boundary to
   be explicit — without it the whole route opts out of static generation at build time. Same
   wrapper /services has carried since it started reading ?q=. */
export default function ProvidersPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center"><div className="text-gray-400">Loading...</div></div>}>
      <ProvidersContent />
    </Suspense>
  );
}
