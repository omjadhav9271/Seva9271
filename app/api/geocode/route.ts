/* GET /api/geocode?q=... — turn a typed address into coordinates for a provider's SERVICE BASE.
 *
 * Why a server proxy rather than calling the geocoder from the browser:
 *  - Nominatim's usage policy requires an identifying User-Agent and at most 1 request/second.
 *    A browser can't set User-Agent, and per-tab calls can't be throttled globally. Both are
 *    handled here, in one place.
 *  - It keeps the choice of geocoder swappable (Architecture §3 names Google/Mapbox as the
 *    eventual vendor) without touching the onboarding UI.
 *
 * Auth required: this is a write-path helper for someone filling in their provider application,
 * and an unauthenticated geocoding proxy is an open relay that would get our IP banned upstream.
 *
 * This route returns candidate coordinates to the PROVIDER for their OWN base. It is unrelated to
 * the customer-facing matching path, which never sees coordinates at all (see the Step-11 migration). */

import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GEOCODER = process.env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org/search';
// Nominatim asks for a real contact address in the UA so they can reach the operator.
const USER_AGENT = process.env.GEOCODER_USER_AGENT ?? 'Seva/0.1 (local-services marketplace; contact: omjadhav9271@gmail.com)';

// Nominatim allows 1 request/second. Serialize upstream calls behind a single promise chain so
// concurrent typers queue instead of firing in parallel and getting us rate-limited.
let lastCall = 0;
let chain: Promise<unknown> = Promise.resolve();
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = 1100 - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run as Promise<T>;
}

export type GeocodeHit = { label: string; lat: number; lng: number };

export async function GET(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (q.length < 3) {
    return NextResponse.json({ error: 'Type at least 3 characters of your address.' }, { status: 400 });
  }

  const url = new URL(GEOCODER);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'in'); // Mumbai-first launch; keeps results relevant.

  try {
    const res = await throttled(() =>
      fetch(url.toString(), {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
        cache: 'no-store',
      }),
    );
    if (!res.ok) {
      // Be honest about an upstream failure rather than pretending the address doesn't exist.
      return NextResponse.json(
        { error: 'The address lookup service is unavailable right now. Please try again in a moment.' },
        { status: 502 },
      );
    }
    const raw = (await res.json()) as Array<{ display_name?: string; lat?: string; lon?: string }>;
    const results: GeocodeHit[] = (Array.isArray(raw) ? raw : [])
      .map((r) => ({ label: r.display_name ?? '', lat: Number(r.lat), lng: Number(r.lon) }))
      .filter((r) => r.label && Number.isFinite(r.lat) && Number.isFinite(r.lng));

    return NextResponse.json({ results });
  } catch {
    return NextResponse.json(
      { error: 'The address lookup service is unavailable right now. Please try again in a moment.' },
      { status: 502 },
    );
  }
}
