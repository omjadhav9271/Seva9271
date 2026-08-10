/* Step 11 — matching & ranking (client helpers).
 *
 * The invariant this module exists to preserve: the client asks "who is near ME", and gets back a
 * DISTANCE. It never receives, stores or renders provider coordinates. Everything geographic
 * happens inside the search_providers RPC. If you ever find yourself wanting lat/lng on a provider
 * card "to draw a map", re-read the Step-11 migration header first — that is the stalking risk.
 *
 * Live device position belongs to Step 15 (tracking). Here, the customer's location is a one-shot
 * read at search time and the provider's is a static service base set at onboarding. */

import { supabase } from '@/lib/supabase';
import type { ProviderSearchResult } from '@/lib/supabase';

export type LatLng = { lat: number; lng: number };
export type GeocodeHit = { label: string; lat: number; lng: number };

/** Where the customer is searching from, plus how we got it (shown back to them honestly). */
export type SearchOrigin = LatLng & { label: string };

/* How the search widens rather than returning nothing.

   A fixed 25 km radius produced a BLANK SCREEN whenever the nearest provider was 26 km away —
   which reads as "this product is broken", not as "nobody serves you yet", and is the opposite of
   what a marketplace should do while its supply is thin. But an unbounded search is worse: an
   electrician 600 km away is not a result, it is a joke at the customer's expense.

   So: try near, widen twice, then stop and say so. Three tries, hardcoded — not a configurable
   ladder, because the numbers only need to be right, not adjustable. */
export const RADIUS_STEPS_KM = [15, 50, 150] as const;
/** Below this, widen. Chosen so a customer always gets a real choice, not a single lonely card. */
export const MIN_RESULTS = 3;
/** Beyond the last step there is nothing honest left to show — the UI says so in words. */
export const MAX_RADIUS_KM = RADIUS_STEPS_KM[RADIUS_STEPS_KM.length - 1];

/** The sort modes, every one applied IN THE QUERY (see 20260822120000 — sorting a ranked cut is a
 *  sample, exactly like filtering one). 'match' is the server's blended ranking; the first three
 *  are the primary controls and the rest are the long tail the page has always offered. */
export type SortMode = 'match' | 'distance' | 'rating' | 'reviews' | 'price_low' | 'price_high';

/* ── The customer's search location ──────────────────────────────────────────── */

export type CityAnchor = LatLng & { city: string; provider_count: number };

/* Last-resort anchors, used only when city_anchors() cannot be reached. This list used to be the
   ONLY source, and that was a bug: the /providers dropdown was built from the cities present in
   the data, so any city missing here (Kalyan, Bengaluru and Mumbai Suburban — 312 of 485
   providers) silently fell through to the unranked catalog with no distances and no explanation.
   The live list now comes from the DB, so the cities offered and the cities that can rank are the
   same set by construction. Never re-introduce a hardcoded list as the primary source. */
export const CITY_ANCHORS: Record<string, LatLng> = {
  Mumbai: { lat: 19.076, lng: 72.8777 },
  Thane: { lat: 19.2183, lng: 72.9781 },
  'Navi Mumbai': { lat: 19.033, lng: 73.0297 },
  Pune: { lat: 18.5204, lng: 73.8567 },
};

/**
 * Cities a customer can search from, straight from the provider data. The RPC returns a coarse,
 * grid-snapped city point built from at least three providers — never an individual position.
 */
export async function fetchCityAnchors(): Promise<CityAnchor[]> {
  const { data, error } = await supabase.rpc('city_anchors');
  if (error) {
    console.error('city_anchors failed, falling back to the static list:', error.message);
    return Object.entries(CITY_ANCHORS).map(([city, p]) => ({ city, ...p, provider_count: 0 }));
  }
  return (data ?? []) as CityAnchor[];
}

/* ── Pincode → a point we can rank from ──────────────────────────────────────
 *
 * This is deliberately NOT geocoding. Ranking needs a COARSE origin — the difference between two
 * points 3 km apart barely moves an 8 km decay curve, and the widening search absorbs the rest.
 * So a pincode resolves to the same city anchor the dropdown already offers: a grid-snapped point
 * built from at least three providers, which we already trust and already show.
 *
 * Running the address through a geocoder would buy precision we do not need for ranking, at the
 * cost of an external dependency on the customer's critical path — and the one we have already
 * fails on exactly the Indian addresses that matter (see the decisions log: it cannot resolve
 * "Prem Auto" or "Don Bosco School"). The PRECISE address is captured at booking time and handed
 * to Google Maps, which geocodes far better than we would.
 *
 * Longest prefix wins, so Thane (400601-400615) and Navi Mumbai (400701-400710) are not swallowed
 * by Mumbai's 400. Every target is resolved against the LIVE anchor list, so this table can never
 * point at a city we cannot actually rank from — an unknown pincode falls through to the picker
 * rather than pretending. */
const PIN_PREFIX_CITY: [string, string][] = [
  ['4006', 'Thane'],
  ['4007', 'Navi Mumbai'],
  ['400', 'Mumbai'],
  ['401', 'Mumbai Suburban'],   // Vasai / Virar / Palghar — the suburban anchor is the nearest
  ['410', 'Navi Mumbai'],       // Panvel / Kharghar
  ['411', 'Pune'],
  ['412', 'Pune'],
  ['421', 'Kalyan'],            // Kalyan / Dombivli / Ambernath
  ['560', 'Bengaluru'],
  ['561', 'Bengaluru'],
  ['562', 'Bengaluru'],
];

export const isPincode = (s: string): boolean => /^[1-9][0-9]{5}$/.test(s.trim());

/** The anchor a pincode should search from, or null if we don't cover it (say so; don't guess). */
export function anchorForPincode(pin: string, anchors: CityAnchor[]): CityAnchor | null {
  const digits = pin.trim();
  if (!isPincode(digits)) return null;
  const match = [...PIN_PREFIX_CITY]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([prefix]) => digits.startsWith(prefix));
  if (!match) return null;
  return anchors.find((a) => a.city.toLowerCase() === match[1].toLowerCase()) ?? null;
}

/**
 * One-shot browser geolocation. Resolves to an error STRING rather than throwing, because every
 * failure here has a different sentence the customer needs to read — "you declined" and "your
 * device can't get a fix" are not the same problem, and neither is a dead end: the caller falls
 * back to the city list.
 */
export function requestBrowserLocation(timeoutMs = 10_000): Promise<LatLng | { error: string }> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ error: "This browser can't share your location. Pick your city instead." });
      return;
    }
    // Geolocation requires a secure context; on plain http it silently never calls back.
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      resolve({ error: 'Location needs a secure (https) connection. Pick your city instead.' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        const message =
          err.code === err.PERMISSION_DENIED
            ? 'No problem — pick your city and we\'ll search from there.'
            : err.code === err.POSITION_UNAVAILABLE
              ? "Your device couldn't get a location fix. Pick your city instead."
              : 'That took too long. Pick your city instead.';
        resolve({ error: message });
      },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 300_000 },
    );
  });
}

/* ── Searching ───────────────────────────────────────────────────────────────── */

export async function searchProviders(opts: {
  origin: LatLng;
  categoryId?: string | null;
  radiusKm?: number;
  limit?: number;
  /** Free text matched server-side against business name, category and city. Passing it here
   *  rather than filtering the returned rows is the point: filtering a ranked cut is a sample. */
  query?: string | null;
  /** Star-average floor. 0 / null means no floor. Same reasoning as `query`: it belongs in the
   *  query, because filtering the rows that came back can only ever return a sample of them. */
  minRating?: number | null;
  /** Restrict to providers currently marked available. Server-side, for the same reason. */
  availableOnly?: boolean;
  /** Which order to take the cut in. Also server-side, and for the identical reason: sorting the
   *  rows that came back re-orders a sample of the results, not the results. */
  sort?: SortMode;
}): Promise<{ data: ProviderSearchResult[] } | { error: string }> {
  const { data, error } = await supabase.rpc('search_providers', {
    p_lat: opts.origin.lat,
    p_lng: opts.origin.lng,
    p_category_id: opts.categoryId ?? null,
    p_radius_km: opts.radiusKm ?? RADIUS_STEPS_KM[0],
    p_limit: opts.limit ?? 30,
    p_query: opts.query?.trim() || null,
    p_min_rating: opts.minRating && opts.minRating > 0 ? opts.minRating : null,
    p_available_only: opts.availableOnly ?? false,
    p_sort: opts.sort ?? 'match',
  });
  if (error) return { error: error.message };
  return { data: (data ?? []) as ProviderSearchResult[] };
}

export type WideningResult = {
  data: ProviderSearchResult[];
  /** The radius that produced these rows — the UI says so when it isn't the near one. */
  radiusKm: number;
  /** True when we had to look past the near radius to find anybody. */
  widened: boolean;
};

/**
 * The same search, widened until it finds people — or until widening further would be dishonest.
 *
 * Stops at the FIRST radius returning at least MIN_RESULTS, so the common case (a customer in a
 * covered locality) costs exactly one round trip and is unchanged. A sparse area costs at most
 * three. Past the last step we return the empty set and let the page say plainly that we don't
 * cover them yet — never a blank screen, and never a provider 400 km away dressed up as a match.
 *
 * Filters are passed through untouched: widening finds MORE providers, it must never quietly relax
 * what the customer asked for. If they ticked "available now" and nobody available is within
 * 150 km, the honest answer is none — not a busy provider 8 km away.
 */
export async function searchProvidersWidening(
  opts: Parameters<typeof searchProviders>[0],
): Promise<WideningResult | { error: string }> {
  let last: ProviderSearchResult[] = [];
  let lastRadius: number = RADIUS_STEPS_KM[0];

  for (const radiusKm of RADIUS_STEPS_KM) {
    const res = await searchProviders({ ...opts, radiusKm });
    if ('error' in res) return res;
    last = res.data;
    lastRadius = radiusKm;
    if (res.data.length >= MIN_RESULTS) break;
  }

  return { data: last, radiusKm: lastRadius, widened: lastRadius > RADIUS_STEPS_KM[0] };
}

/**
 * Sorting for CATALOG MODE ONLY — the unranked list a customer sees before sharing a location.
 *
 * Client-side sorting is safe here and nowhere else, and the distinction is the whole lesson of
 * 20260822120000: catalog mode holds the COMPLETE list of approved providers, so ordering it
 * orders the entire set. Ranked mode holds a CUT — the top N by whatever the query ordered on —
 * and re-sorting a cut silently answers a different question. If you ever add a limit to the
 * catalog query, this function becomes the bug it was written to avoid.
 *
 * 'match' and 'distance' are absent on purpose: neither exists without a location.
 */
export function catalogComparator<T extends { rating: number; total_reviews: number; hourly_rate: number }>(
  mode: SortMode,
): (a: T, b: T) => number {
  // Mirrors the SQL: hourly_rate 0 means "custom pricing", not free, so those providers sort LAST
  // in both directions rather than heading the cheapest page.
  const price = (v: number) => (v > 0 ? v : Number.POSITIVE_INFINITY);
  switch (mode) {
    case 'reviews':    return (a, b) => b.total_reviews - a.total_reviews;
    case 'price_low':  return (a, b) => price(a.hourly_rate) - price(b.hourly_rate);
    case 'price_high': return (a, b) => (
      price(a.hourly_rate) === Infinity || price(b.hourly_rate) === Infinity
        ? price(a.hourly_rate) - price(b.hourly_rate)   // unpriced last, not first
        : b.hourly_rate - a.hourly_rate
    );
    default:           return (a, b) => b.rating - a.rating;
  }
}

/** What the sort control should show, and order by, given whether we know where the customer is.
 *  'match' and 'distance' need a location, so without one they degrade to 'rating' — displayed
 *  that way too, so the highlighted control is always the one actually in effect. */
export function effectiveSort(sort: SortMode, ranked: boolean): SortMode {
  if (ranked) return sort;
  return sort === 'match' || sort === 'distance' ? 'rating' : sort;
}

/**
 * distance_km comes from a ~250 m grid-snapped point, so it is good to roughly ±0.3 km. Render one
 * decimal — "2.31 km" would advertise a precision we deliberately do not have, and do not want.
 */
export function formatDistance(km: number | null | undefined): string | null {
  if (km === null || km === undefined || !Number.isFinite(km)) return null;
  /* Sub-kilometre results get metres, rounded to the nearest 100 m. "Under 1 km away" was the
     first cut and it fails exactly where this feature matters most: in a dense locality (the
     Kalyan scale test put 7 of the top 12 inside 1 km) it collapses 130 m and 920 m into one
     label, so the customer cannot tell the difference between next door and a 12-minute walk.
     100 m buckets sit just outside the ±139 m snap bound, so they inform without overclaiming. */
  if (km < 1) return `~${Math.max(100, Math.round((km * 1000) / 100) * 100)} m away`;
  return `${km.toFixed(1)} km away`;
}

/* ── The provider's static service base (onboarding) ─────────────────────────── */

export async function geocodeAddress(q: string): Promise<{ results: GeocodeHit[] } | { error: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: 'Please sign in again.' };

  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body?.error ?? 'Could not look up that address.' };
    return { results: (body?.results ?? []) as GeocodeHit[] };
  } catch {
    return { error: 'Could not reach the address lookup service. Please try again.' };
  }
}

/**
 * Writes ONLY coordinates (+ optional address/city) onto the caller's own provider row, through a
 * definer RPC. Deliberately separate from submitApplication: moving your base must not re-enter
 * the application/KYC gate, and adding parameters to that RPC would have created an overload
 * PostgREST could not resolve.
 */
export async function setServiceBase(input: {
  lat: number;
  lng: number;
  address?: string | null;
  city?: string | null;
}): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('set_provider_service_base', {
    p_lat: input.lat,
    p_lng: input.lng,
    p_address: input.address ?? null,
    p_city: input.city ?? null,
  });
  return error ? { error: error.message } : {};
}
