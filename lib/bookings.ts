/* Shared booking vocabulary for the list (/bookings) and the detail page (/bookings/[id]).
   The action tables and the transition RPC call live here and ONLY here — the pages own
   their optimistic-update state (the list holds two arrays, the detail holds one row), but
   neither decides what a role may do or how a transition is issued. */

import {
  Star, CheckCircle, XCircle, AlertCircle, RefreshCw, Truck, Wallet, MapPin, Clock, Shield, Handshake,
  type LucideIcon,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

export type BookingStatus =
  | 'requested' | 'negotiating' | 'accepted' | 'en_route' | 'arrived' | 'in_progress'
  | 'completed' | 'confirmed' | 'paid' | 'reviewed'
  | 'cancelled' | 'disputed' | 'expired';

export type Role = 'customer' | 'provider';

export type BookingRow = {
  id: string;
  customer_id: string;
  provider_id: string;
  scheduled_date: string | null;
  scheduled_time: string | null;
  // Bucket C (20): the detail view was missing the shape of the job itself — how long it was
  // booked for, at what rate, and when it was placed.
  duration_hours: number | null;
  hourly_rate: number | null;
  created_at: string | null;
  total_amount: number;
  price_agreed: number | null;
  price_charged: number | null;
  status: BookingStatus;
  payment_method: string;
  payment_status: string;
  service_type: string;
  notes: string | null;   // the customer's brief — "what was booked" on the dispute card
  service_providers: {
    business_name: string | null;
    city: string | null;
    service_categories: { name: string; slug: string } | null;
  } | null;
  service_categories: { name: string; slug: string } | null;
};

/* One select string for both pages — they were byte-identical copies before.

   🔴 `address` IS DELIBERATELY ABSENT. The service address, its pincode and its optional map pin
   lost their column grants in 20260823120000 and are readable only through
   booking_service_location(), which decides per caller and per booking status who sees what — the
   provider gets the precise address only once they have accepted the job. Adding `address` back
   here does not leak it (the grant is gone, so PostgREST fails the whole select with 42501) but it
   DOES break every page using this string. Read it with fetchServiceLocation instead. */
export const BOOKING_SELECT =
  'id, customer_id, provider_id, scheduled_date, scheduled_time, duration_hours, hourly_rate, created_at, total_amount, price_agreed, price_charged, status, payment_method, payment_status, service_type, notes, service_providers(business_name, city, service_categories(name, slug)), service_categories(name, slug)';

/* ── The service address: per booking, revealed by status ─────────────────────
   Captured when the booking is made, because a customer books for different places — their flat,
   a parent's home, their office. A single "home address" on the profile would be wrong for most
   bookings and would show the provider somewhere the job isn't. */

export type ServiceLocation = {
  booking_id: string;
  viewer_role: 'customer' | 'provider' | 'admin';
  /** False for a provider whose booking is not yet accepted: address/lat/lng come back NULL and
   *  only the pincode is populated. The UI renders the difference honestly. */
  revealed: boolean;
  address: string | null;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
};

/** Reads the address through the definer RPC — the only path that exists. Null = nothing to show
 *  (not a party, or no booking), which is a legitimate state, not an error to surface. */
export async function fetchServiceLocation(bookingId: string): Promise<ServiceLocation | null> {
  const { data, error } = await supabase.rpc('booking_service_location', { p_booking_id: bookingId });
  if (error) {
    console.error('booking_service_location failed:', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return (row as ServiceLocation) ?? null;
}

/** Sets the address on a booking the caller owns. Used by the OFFER path, which cannot write these
 *  columns itself (start_negotiation owns that INSERT), and by any later correction. */
export async function setServiceLocation(input: {
  bookingId: string;
  address?: string | null;
  pincode?: string | null;
  lat?: number | null;
  lng?: number | null;
}): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('set_booking_service_location', {
    p_booking_id: input.bookingId,
    p_address: input.address ?? null,
    p_pincode: input.pincode ?? null,
    p_lat: input.lat ?? null,
    p_lng: input.lng ?? null,
  });
  return error ? { error: error.message } : {};
}

/**
 * A Google Maps directions link. WE DO NOT GEOCODE — the typed address goes to Google, which is
 * far better at Indian addresses than anything we would wire up (our own geocoder cannot resolve
 * "Prem Auto" or "Don Bosco School"; see the decisions log). Navigation itself is delegated
 * entirely: no in-app map, no route, no ETA — that is Step 15.
 *
 * Address first because it is what the customer actually typed and what a human reads out at the
 * gate; the optional GPS pin is the fallback for when Google cannot place the text.
 */
export function mapsDirectionsUrl(loc: { address?: string | null; pincode?: string | null; lat?: number | null; lng?: number | null }): string | null {
  const text = [loc.address?.trim(), loc.pincode?.trim()].filter(Boolean).join(', ');
  if (text) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(text)}`;
  if (loc.lat != null && loc.lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`;
  return null;
}

/** The backup pin, offered alongside the address link when the customer supplied coordinates. */
export function mapsPinUrl(loc: { lat?: number | null; lng?: number | null }): string | null {
  if (loc.lat == null || loc.lng == null) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`;
}

/* Item 18 + item 22 — the payment methods shown at checkout but NOT selectable.
   Displayed rather than hidden so the list looks complete and a customer wondering "can I pay
   cash?" gets an answer instead of silence. Each says WHY it is off, because "Coming soon" with
   no reason reads as an arbitrary restriction.

   🔴 'wallet' here means a FUTURE CUSTOMER PREPAY BALANCE — money a customer loads and spends.
   It is NOT the wallet that exists today, which is the PROVIDER PAYOUT LEDGER (escrow releases
   into it; disputes claw back from it). They share a name and nothing else. Wiring this option
   to the existing ledger would let a customer pay with a provider's earnings.

   These are labels only. The database refuses both on INSERT regardless of what any client
   sends — see the COD guard (20260721120000) and the wallet guard (20260817120000) — because a
   disabled attribute is a UI affordance, never a control. The enablement preconditions for each
   are recorded in /docs/Seva-Decisions-Log.md; do not turn either on until they are met. */
export const COMING_SOON_PAYMENTS: { method: string; label: string; icon: string; why: string }[] = [
  {
    method: 'cod',
    label: 'Cash',
    icon: '💵',
    why: 'Cash can\'t be held in escrow, so we can\'t protect or refund it yet.',
  },
  {
    method: 'wallet',
    label: 'Seva Wallet',
    icon: '👛',
    why: 'A prepaid Seva balance for faster checkout. Not open to customers yet.',
  },
];

// How the money was (or will be) paid. 'upi' covers UPI/card/netbanking through Razorpay —
// the only method a customer can actually select (Bucket C item 18). The other two are legacy
// values on existing rows: 'cod' from before Step 5.5, 'wallet' from before Bucket C.
export const paymentMethodLabel = (method: string | null): string => {
  switch (method) {
    case 'upi':    return 'UPI · online';
    case 'cod':    return 'Cash on delivery';
    case 'wallet': return 'Seva Wallet (legacy)';
    default:       return method ?? '—';
  }
};

export const statusConfig: Record<BookingStatus, { label: string; color: string; bg: string; icon: LucideIcon }> = {
  requested:   { label: 'Requested',   color: 'text-yellow-400',  bg: 'bg-yellow-900/20 border-yellow-700/30',   icon: AlertCircle },
  // Step 10: a bounded offer/counter phase in front of Accepted. statusConfig is indexed
  // directly by the detail page, so a missing entry here would crash it.
  negotiating: { label: 'Negotiating', color: 'text-[#FF9933]',   bg: 'bg-[#FF9933]/10 border-[#FF9933]/30',     icon: Handshake },
  accepted:    { label: 'Accepted',    color: 'text-blue-400',    bg: 'bg-blue-900/20 border-blue-700/30',       icon: CheckCircle },
  en_route:    { label: 'On the way',  color: 'text-sky-400',     bg: 'bg-sky-900/20 border-sky-700/30',         icon: Truck },
  arrived:     { label: 'Arrived',     color: 'text-teal-400',    bg: 'bg-teal-900/20 border-teal-700/30',       icon: MapPin },
  in_progress: { label: 'In Progress', color: 'text-[#FF9933]',   bg: 'bg-[#FF9933]/10 border-[#FF9933]/30',     icon: RefreshCw },
  completed:   { label: 'Completed',   color: 'text-[#22c55e]',   bg: 'bg-[#138808]/10 border-[#138808]/30',     icon: CheckCircle },
  confirmed:   { label: 'Confirmed',   color: 'text-emerald-400', bg: 'bg-emerald-900/20 border-emerald-700/30', icon: CheckCircle },
  paid:        { label: 'Paid',        color: 'text-green-400',   bg: 'bg-green-900/20 border-green-700/30',     icon: Wallet },
  reviewed:    { label: 'Reviewed',    color: 'text-purple-400',  bg: 'bg-purple-900/20 border-purple-700/30',   icon: Star },
  cancelled:   { label: 'Cancelled',   color: 'text-red-400',     bg: 'bg-red-900/20 border-red-700/30',         icon: XCircle },
  disputed:    { label: 'Disputed',    color: 'text-orange-400',  bg: 'bg-orange-900/20 border-orange-700/30',   icon: AlertCircle },
  expired:     { label: 'Expired',     color: 'text-gray-400',    bg: 'bg-gray-800/40 border-gray-700/40',       icon: Clock },
};

// Payment lifecycle (bookings.payment_status). 'held' means funds are captured into platform
// escrow; 'released' means the provider's wallet was credited on customer-confirm.
export type PaymentStatus = 'pending' | 'held' | 'released' | 'refunded' | 'failed';

export const paymentStatusConfig: Record<PaymentStatus, { label: string; color: string; bg: string; icon: LucideIcon }> = {
  pending:  { label: 'Payment pending', color: 'text-yellow-400',  bg: 'bg-yellow-900/20 border-yellow-700/30',   icon: Clock },
  held:     { label: 'In escrow',       color: 'text-sky-400',     bg: 'bg-sky-900/20 border-sky-700/30',         icon: Shield },
  released: { label: 'Paid out',        color: 'text-green-400',   bg: 'bg-green-900/20 border-green-700/30',     icon: Wallet },
  refunded: { label: 'Refunded',        color: 'text-orange-400',  bg: 'bg-orange-900/20 border-orange-700/30',   icon: RefreshCw },
  failed:   { label: 'Payment failed',  color: 'text-red-400',     bg: 'bg-red-900/20 border-red-700/30',         icon: XCircle },
};

export const categoryGradient: Record<string, string> = {
  electrician: 'from-amber-500 to-orange-600',
  'house-cleaning': 'from-pink-500 to-rose-600',
  plumber: 'from-blue-500 to-cyan-600',
  'home-cook': 'from-red-500 to-orange-500',
  'farm-fresh': 'from-green-500 to-emerald-600',
  delivery: 'from-orange-500 to-amber-500',
};

export type Action = { label: string; next: BookingStatus; tone: 'primary' | 'danger' };

// Which button each role gets at each status. Every entry maps 1:1 to a transition
// allowed by the transition_booking RPC, so the UI can never offer an illegal move.
// Provider drives the job forward through `completed`; the customer confirms and pays.
const PROVIDER_ACTION: Partial<Record<BookingStatus, Action>> = {
  requested:   { label: 'Accept',        next: 'accepted',    tone: 'primary' },
  accepted:    { label: 'Start travel',  next: 'en_route',    tone: 'primary' },
  en_route:    { label: 'Arrived',       next: 'arrived',     tone: 'primary' },
  arrived:     { label: 'Start work',    next: 'in_progress', tone: 'primary' },
  in_progress: { label: 'Mark complete', next: 'completed',   tone: 'primary' },
};

const CUSTOMER_ACTION: Partial<Record<BookingStatus, Action>> = {
  completed: { label: 'Confirm done', next: 'confirmed', tone: 'primary' },
  // NOTE: no confirmed→'paid' action. As of Step 5 the system settles on confirm — for an
  // escrow (online) booking the release trigger pays out and moves it to 'paid'; for cash it
  // just marks 'paid'. 'paid' is system-only now; the customer's last action is "Confirm done".
};

// The customer may cancel while the job hasn't started yet.
const CUSTOMER_CANCELLABLE: BookingStatus[] = ['requested', 'accepted', 'en_route'];

export function actionsFor(role: Role, status: BookingStatus): Action[] {
  if (role === 'provider') {
    const action = PROVIDER_ACTION[status];
    return action ? [action] : [];
  }
  const actions: Action[] = [];
  const action = CUSTOMER_ACTION[status];
  if (action) actions.push(action);
  if (CUSTOMER_CANCELLABLE.includes(status)) {
    actions.push({ label: 'Cancel', next: 'cancelled', tone: 'danger' });
  }
  return actions;
}

// The only place the transition RPC is called. Callers own their own optimistic update and
// rollback; this just issues the move and hands back the authoritative row.
export async function runTransition(
  bookingId: string,
  next: BookingStatus,
): Promise<{ row: Partial<BookingRow> | null; error?: never } | { error: string; row?: never }> {
  const { data, error } = await supabase.rpc('transition_booking', {
    p_booking_id: bookingId,
    p_next_status: next,
  });
  if (error) return { error: error.message };
  return { row: (Array.isArray(data) ? data[0] : data) as Partial<BookingRow> | null };
}

// Kick off an escrow payment: ask the server (customer-only, amount from the DB) to create a
// Razorpay order. The access token is sent explicitly because our API routes authenticate via
// the Authorization header (this app has no SSR cookie session). The caller then opens Razorpay
// Checkout with the returned order — money state only changes later, via the webhook.
export type CreateOrderResult =
  | { orderId: string; amount: number; currency: string; keyId: string; error?: never }
  | { error: string; orderId?: never };

export async function createPaymentOrder(bookingId: string): Promise<CreateOrderResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: 'Please sign in again.' };
  const res = await fetch('/api/payments/create-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ bookingId }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { error: json?.error ?? 'Could not start payment.' };
  return json as CreateOrderResult;
}

// Does `userId` own the provider side of this booking? Deliberately a separate query rather
// than joining service_providers.user_id into BOOKING_SELECT — that column stays unexposed.
export async function ownsProviderSide(providerId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('service_providers')
    .select('id')
    .eq('id', providerId)
    .eq('user_id', userId)
    .maybeSingle();
  return Boolean(data);
}

export function initials(name: string | null): string {
  if (!name) return '?';
  return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
}

export function formatTime(t: string | null): string {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return t;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr ?? '00'} ${ampm}`;
}
