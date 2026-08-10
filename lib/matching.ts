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

export const DEFAULT_RADIUS_KM = 25;

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
}): Promise<{ data: ProviderSearchResult[] } | { error: string }> {
  const { data, error } = await supabase.rpc('search_providers', {
    p_lat: opts.origin.lat,
    p_lng: opts.origin.lng,
    p_category_id: opts.categoryId ?? null,
    p_radius_km: opts.radiusKm ?? DEFAULT_RADIUS_KM,
    p_limit: opts.limit ?? 30,
    p_query: opts.query?.trim() || null,
  });
  if (error) return { error: error.message };
  return { data: (data ?? []) as ProviderSearchResult[] };
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
