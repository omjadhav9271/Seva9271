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
 * A pincode is the unit Indians actually know and state, and it is roughly a LOCALITY — the right
 * grain for an 8 km proximity decay. A city is not: Greater Mumbai is ~12 million people across
 * 60 km, so ranking a Borivali customer from the Mumbai anchor (near Fort, ~17 km away) is not
 * approximate, it is wrong.
 *
 * The first version of this mapped a pincode to a CITY anchor by digit prefix, which threw away
 * the precision that made pincodes worth asking for — 400050 (Bandra) and 400097 (Malad) both
 * landed on the same point. resolve_pincode() replaces it with a real locality centroid derived
 * from our own providers (see 20260826120000), degrading through the sorting district when we
 * don't have enough supply in a pincode to place it. `precision` says which happened, because
 * "near 400097" and "near the 400 area" are different promises to make to a customer.
 *
 * Still NOT geocoding, and still nothing external on the customer's critical path. */

export const isPincode = (s: string): boolean => /^[1-9][0-9]{5}$/.test(s.trim());

export type ResolvedPincode = LatLng & {
  label: string;
  /** Named `granularity`, not `precision`: PRECISION is a reserved word in Postgres, so an OUT
   *  column called that will not parse. Kept identical on both sides to avoid a silent mismatch. */
  granularity: 'pincode' | 'district';
  provider_count: number;
};

/** Where to search from for a typed pincode, or null when we have no supply anywhere near it —
 *  in which case the caller says so honestly instead of guessing a point. */
export async function resolvePincode(pin: string): Promise<ResolvedPincode | null> {
  if (!isPincode(pin)) return null;
  const { data, error } = await supabase.rpc('resolve_pincode', { p_pincode: pin.trim() });
  if (error) {
    console.error('resolve_pincode failed:', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return (row as ResolvedPincode) ?? null;
}

export type PincodeAnchor = LatLng & { pincode: string; city: string; provider_count: number };

/** The pincodes we can actually search from. Used to SUGGEST real coverage when someone types a
 *  pincode we don't serve — a short list of places that work beats a dropdown of every Indian city. */
export async function fetchPincodeAnchors(): Promise<PincodeAnchor[]> {
  const { data, error } = await supabase.rpc('pincode_anchors');
  if (error) {
    console.error('pincode_anchors failed:', error.message);
    return [];
  }
  return (data ?? []) as PincodeAnchor[];
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
  /** Whether more providers matched than we asked for. Detected by asking for ONE more row than
   *  we intend to show — no count query, no second round trip, and it cannot disagree with the
   *  page because it comes from the same result set. */
  hasMore: boolean;
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
  // Ask for one more than we will show, purely to learn whether there IS more. Cheaper and more
  // honest than a separate count: a count can disagree with the page it labels.
  const want = opts.limit ?? PAGE_SIZE;
  const probe = want + 1;

  for (const radiusKm of RADIUS_STEPS_KM) {
    const res = await searchProviders({ ...opts, radiusKm, limit: probe });
    if ('error' in res) return res;
    last = res.data;
    lastRadius = radiusKm;
    if (res.data.length >= MIN_RESULTS) break;
  }

  const hasMore = last.length > want;
  return {
    data: hasMore ? last.slice(0, want) : last,
    radiusKm: lastRadius,
    widened: lastRadius > RADIUS_STEPS_KM[0],
    hasMore,
  };
}

/** How many providers a page shows at once, and how many more each "Load more" adds.
 *  Small on purpose: 555 electricians can sit within 15 km of one Mumbai junction, and a customer
 *  scanning for someone to trust does not read 555 cards. */
export const PAGE_SIZE = 30;

/**
 * How CATALOG MODE orders itself — the unranked list shown before a customer gives a location.
 *
 * 🔴 This returns a PostgREST order spec, not a comparator, and that is the whole point. It used
 * to be a client-side sort, justified by "catalog mode holds the COMPLETE list so ordering it
 * orders the entire set" — with a warning attached that adding a limit would turn it into the very
 * bug it was written to avoid. PostgREST added the limit for us: it caps at 1,000 rows, we passed
 * 1,085 approved providers, and the sort quietly became a sample of the set.
 *
 * So the catalog orders in the query now, exactly like the ranked path. 'match' and 'distance' are
 * absent because neither exists without a location.
 */
export function catalogOrder(mode: SortMode): { column: string; ascending: boolean; nullsFirst: boolean } {
  switch (mode) {
    case 'reviews':    return { column: 'total_reviews', ascending: false, nullsFirst: false };
    // price_sort is NULL for "custom pricing" providers (generated column, 20260827120000), so
    // nullsFirst:false keeps them LAST in BOTH directions — unpriced, not free and not dearest.
    case 'price_low':  return { column: 'price_sort', ascending: true, nullsFirst: false };
    case 'price_high': return { column: 'price_sort', ascending: false, nullsFirst: false };
    default:           return { column: 'rating', ascending: false, nullsFirst: false };
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
