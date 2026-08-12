/* The signed-in home page's data, in one module.
 *
 * WHY THIS EXISTS. `/` is behind AuthGate (only the four /auth routes are public), so the homepage
 * is seen exclusively by members — yet it used to render a logged-out acquisition page whose
 * "statistics" were two words in a number's clothing (`ID`, `Escrow`) and whose "Top Rated
 * Providers" were three hardcoded strings. This module is the honest replacement: everything the
 * home page displays comes from here, and everything here comes from the database.
 */
import { supabase } from '@/lib/supabase';
import { actionsFor, BOOKING_SELECT, type BookingStatus } from '@/lib/bookings';
import { fetchCategories } from '@/lib/categories';
import { fetchCityAnchors, searchProvidersWidening } from '@/lib/matching';

/* ── Platform statistics ──────────────────────────────────────────────────────
 *
 * 🔴 EVERY FIGURE HERE READS FROM A SOURCE WHOSE RLS SELECT POLICY IS `true`
 * (`service_providers`, `service_categories`) or is derived from one (`city_anchors()`). That is
 * not fastidiousness — it is the difference between a true number and a confidently wrong one,
 * and the wrong ones are not subtle:
 *
 *   · `bookings` is `select_own_bookings`, so a client-side count returns the VIEWER'S bookings
 *     (~45 for a test account) while presenting itself as the platform's (30,672 completed).
 *   · `reviews` is `read_revealed_reviews` — recent un-reciprocated reviews are hidden until the
 *     14-day window closes — so a client-side count is a moving subset, never a total. The
 *     seed's recency skew makes this worse, not better.
 *
 * `service_providers.total_bookings` looks like the way around that and is not: it sums to 2,300
 * against 30,672 actually-completed bookings. Whatever that column counts, it is not completed
 * jobs, and a tile nobody can explain is precisely what this page is being rebuilt to delete.
 * If platform-wide job volume is wanted later, it needs a SECURITY DEFINER aggregate that is
 * audited for what it exposes — not a client count of a table the client cannot see.
 */
export type PlatformStats = { providers: number; categories: number; cities: number };

export async function fetchPlatformStats(): Promise<PlatformStats> {
  /* head: true — ask the server for the count and none of the rows. A plain select would also hit
     the 1000-row PostgREST cap and silently under-report at 1,085 providers. */
  const [providers, categories, anchors] = await Promise.all([
    supabase.from('service_providers').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    fetchCategories(),
    fetchCityAnchors(),
  ]);
  return {
    providers: providers.count ?? 0,
    categories: categories.length,
    cities: anchors.length,
  };
}

/* ── Bookings, as the home page shows them ──────────────────────────────────── */

/** Enough to recognise a booking and act on it. Deliberately not the full BookingRow. */
export type HomeBooking = {
  id: string;
  status: BookingStatus;
  scheduledDate: string | null;
  scheduledTime: string | null;
  amount: number;
  /** The provider's business name for a customer; the category for a provider. */
  title: string;
  category: string | null;
  /** What this role owes on this booking, or null if the ball is in the other court. */
  action: string | null;
};

/* Closed for everyone. 'paid' is deliberately NOT here: for a customer the review is still owed,
   and 'reviewed' is the status that records it having been left — so a 'paid' booking is exactly
   the set of "you still owe a review". */
const CLOSED: BookingStatus[] = ['cancelled', 'expired', 'reviewed'];

/** How many rows a band shows before it defers to /bookings. A home page is a prompt, not a list. */
export const BAND_LIMIT = 4;

type BookingJoin = {
  id: string;
  status: BookingStatus;
  scheduled_date: string | null;
  scheduled_time: string | null;
  total_amount: number | null;
  service_providers: { business_name: string | null; service_categories: { name: string } | null } | null;
  service_categories: { name: string } | null;
};

/* The action label comes from actionsFor() rather than a second table of statuses here. That
   function is already the single source mapping role+status → allowed move (each entry maps 1:1
   to a transition the RPC permits), so the home page cannot invent a button the booking page
   would refuse. The one addition is the review prompt, which is not a status transition the
   customer drives — the trigger moves 'paid' → 'reviewed' when the review lands. */
function actionLabel(role: 'customer' | 'provider', status: BookingStatus): string | null {
  if (role === 'customer' && status === 'paid') return 'Leave a review';
  const primary = actionsFor(role, status).find((a) => a.tone === 'primary');
  return primary ? primary.label : null;
}

function toHomeBooking(row: BookingJoin, role: 'customer' | 'provider'): HomeBooking {
  const category = row.service_categories?.name
    ?? row.service_providers?.service_categories?.name
    ?? null;
  return {
    id: row.id,
    status: row.status,
    scheduledDate: row.scheduled_date,
    scheduledTime: row.scheduled_time,
    amount: Number(row.total_amount ?? 0),
    title: role === 'customer'
      ? (row.service_providers?.business_name ?? 'Provider')
      : (category ?? 'Booking'),
    category,
    action: actionLabel(role, row.status),
  };
}

/** Sort so the rows that need this person come first; then soonest scheduled. */
function byUrgency(a: HomeBooking, b: HomeBooking): number {
  if (!!a.action !== !!b.action) return a.action ? -1 : 1;
  return (a.scheduledDate ?? '9999').localeCompare(b.scheduledDate ?? '9999');
}

/* ── Customer band ──────────────────────────────────────────────────────────── */

export type CustomerBand = { open: HomeBooking[]; needsYou: number; total: number };

export async function fetchCustomerBand(userId: string): Promise<CustomerBand> {
  const { data, error } = await supabase
    .from('bookings')
    .select(BOOKING_SELECT)
    .eq('customer_id', userId)
    .not('status', 'in', `(${CLOSED.join(',')})`)
    .order('scheduled_date', { ascending: true })
    .limit(50);
  if (error) {
    console.error('Failed to load your bookings:', error.message);
    return { open: [], needsYou: 0, total: 0 };
  }
  const all = ((data ?? []) as unknown as BookingJoin[]).map((r) => toHomeBooking(r, 'customer'));
  all.sort(byUrgency);
  return {
    open: all.slice(0, BAND_LIMIT),
    needsYou: all.filter((b) => b.action).length,
    total: all.length,
  };
}

/* ── Provider band ──────────────────────────────────────────────────────────── */

export type ProviderBand = {
  businessName: string | null;
  status: string;
  kycStatus: string | null;
  isAvailable: boolean;
  /** Server-computed by the Step-7 engine — displayed, never derived here (invariant 1). */
  reputationScore: number;
  rating: number;
  totalReviews: number;
  incoming: HomeBooking[];
  needsYou: number;
  total: number;
};

/**
 * The caller's own provider profile and the jobs waiting on them, or null if they have never
 * applied. Reads through `my_provider_profile` — the view filtered to auth.uid() — because
 * `service_providers` withholds kyc_status and friends from `authenticated` at the column level.
 *
 * Returns an ARRAY-tolerant result rather than .maybeSingle(): nothing stops one account owning
 * two provider rows, and maybeSingle() answers that by throwing, which would blank the whole
 * home page for the one user whose data is most interesting.
 */
export async function fetchProviderBand(): Promise<ProviderBand | null> {
  const { data: mine, error } = await supabase
    .from('my_provider_profile')
    .select('id, business_name, status, kyc_status, is_available, reputation_score, rating, total_reviews');
  if (error) {
    console.error('Failed to load your provider profile:', error.message);
    return null;
  }
  const rows = (mine ?? []) as Array<{
    id: string; business_name: string | null; status: string; kyc_status: string | null;
    is_available: boolean | null; reputation_score: number | null; rating: number | null;
    total_reviews: number | null;
  }>;
  if (!rows.length) return null;

  const primary = rows[0];
  const ids = rows.map((r) => r.id);

  const { data, error: bookErr } = await supabase
    .from('bookings')
    .select(BOOKING_SELECT)
    .in('provider_id', ids)
    .not('status', 'in', `(${CLOSED.join(',')})`)
    .order('scheduled_date', { ascending: true })
    .limit(50);
  if (bookErr) console.error('Failed to load your jobs:', bookErr.message);

  const all = ((data ?? []) as unknown as BookingJoin[]).map((r) => toHomeBooking(r, 'provider'));
  all.sort(byUrgency);

  return {
    businessName: primary.business_name,
    status: primary.status,
    kycStatus: primary.kyc_status,
    isAvailable: primary.is_available ?? false,
    reputationScore: Number(primary.reputation_score ?? 0),
    rating: Number(primary.rating ?? 0),
    totalReviews: Number(primary.total_reviews ?? 0),
    incoming: all.slice(0, BAND_LIMIT),
    needsYou: all.filter((b) => b.action).length,
    total: all.length,
  };
}

/* ── Top rated providers ────────────────────────────────────────────────────── */

export type TopProvider = {
  id: string;
  businessName: string | null;
  category: string | null;
  rating: number;
  totalReviews: number;
  isAvailable: boolean;
  distanceKm: number | null;
};

/** What the card is allowed to claim, so the heading can never over-state the query behind it. */
export type TopProviders = { rows: TopProvider[]; near: string | null };

/**
 * The three genuinely best-rated providers, replacing three hardcoded names.
 *
 * `near` is the honesty valve. When the viewer's profile city matches a real anchor we rank from
 * it and the heading may say "near <city>"; otherwise we fall back to a plain reputation ordering
 * and the heading says "on Seva". The old card asserted "Available Now" over invented people —
 * the point of this function is that every word above it is answerable from the query it ran.
 */
export async function fetchTopProviders(city: string | null): Promise<TopProviders> {
  const anchors = await fetchCityAnchors();
  const anchor = city ? anchors.find((a) => a.city.toLowerCase() === city.toLowerCase()) : undefined;

  if (anchor) {
    const res = await searchProvidersWidening({
      origin: { lat: anchor.lat, lng: anchor.lng }, sort: 'match', limit: 3, availableOnly: true,
    });
    if (!('error' in res)) {
      return {
        near: anchor.city,
        rows: res.data.map((r) => ({
          id: r.id,
          businessName: r.business_name,
          category: r.category_name,
          rating: Number(r.rating ?? 0),
          totalReviews: Number(r.total_reviews ?? 0),
          isAvailable: r.is_available,
          distanceKm: r.distance_km ?? null,
        })),
      };
    }
  }

  /* No usable city, or the RPC failed. Order by the Step-7 score rather than the star average:
     `rating` is an unshrunk mean, so a single 5★ review outranks a hundred 4.8★ ones. */
  const { data, error } = await supabase
    .from('service_providers')
    .select('id, business_name, rating, total_reviews, is_available, service_categories(name)')
    .eq('status', 'approved')
    .eq('is_available', true)
    .order('reputation_score', { ascending: false })
    .limit(3);
  if (error) {
    console.error('Failed to load top providers:', error.message);
    return { rows: [], near: null };
  }
  const rows = (data ?? []) as unknown as Array<{
    id: string; business_name: string | null; rating: number | null; total_reviews: number | null;
    is_available: boolean; service_categories: { name: string } | null;
  }>;
  return {
    near: null,
    rows: rows.map((r) => ({
      id: r.id,
      businessName: r.business_name,
      category: r.service_categories?.name ?? null,
      rating: Number(r.rating ?? 0),
      totalReviews: Number(r.total_reviews ?? 0),
      isAvailable: r.is_available,
      distanceKm: null,
    })),
  };
}

/* ── Admin band ─────────────────────────────────────────────────────────────── */

/* Two counts and two links. Admins already get a fully replaced navigation and the whole /admin
   console; a second console on the home page would be the same duplication this rebuild is
   removing everywhere else. This says "the queue needs you" and gets out of the way. */
export type AdminBand = { pendingApplications: number; openDisputes: number };

export async function fetchAdminBand(): Promise<AdminBand> {
  const [apps, disputes] = await Promise.all([
    supabase.from('service_providers').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open'),
  ]);
  return {
    pendingApplications: apps.count ?? 0,
    openDisputes: disputes.count ?? 0,
  };
}
