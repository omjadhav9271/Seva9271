/* Step 10 — client helpers for structured bargaining.

   Structured offers only: offer / counter / accept, never free-text price talk. That's what makes
   the agreed price auditable and floods the leak channel where "let's just settle in cash"
   happens (§7.3).

   Security note for anyone extending this: `floor_price` must never be fetched here. It carries
   no select grant, and no RPC returns it — the only legitimate read is the provider's own row
   through my_provider_profile (fetchMyPricing below). */

import { supabase, type Offer, type ProviderPricing } from '@/lib/supabase';

// The public pricing a customer is allowed to see before making an offer.
export type PublicPricing = {
  pricing_mode: 'fixed' | 'negotiable';
  list_price: number | null;
  auto_accept_threshold: number | null;   // shown as "instant accept" guidance, not the floor
  max_counter_rounds: number;
};

export async function fetchPublicPricing(providerId: string): Promise<PublicPricing | null> {
  const { data, error } = await supabase
    .from('service_providers')
    .select('pricing_mode, list_price, auto_accept_threshold, max_counter_rounds')
    .eq('id', providerId)
    .maybeSingle();
  if (error) { console.error('Failed to load pricing:', error.message); return null; }
  return (data as PublicPricing | null) ?? null;
}

// The provider's own settings, floor included — via the definer view filtered to auth.uid().
export async function fetchMyPricing(): Promise<ProviderPricing | null> {
  const { data, error } = await supabase
    .from('my_provider_profile')
    .select('pricing_mode, list_price, floor_price, auto_accept_threshold, max_counter_rounds')
    .maybeSingle();
  if (error) { console.error('Failed to load own pricing:', error.message); return null; }
  return (data as ProviderPricing | null) ?? null;
}

// Column grants allow exactly these five, and nothing else on the row.
export async function saveMyPricing(
  providerId: string,
  pricing: ProviderPricing,
): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase
    .from('service_providers')
    .update({
      pricing_mode: pricing.pricing_mode,
      list_price: pricing.list_price,
      floor_price: pricing.floor_price,
      auto_accept_threshold: pricing.auto_accept_threshold,
      max_counter_rounds: pricing.max_counter_rounds,
    })
    .eq('id', providerId);
  if (error) return { error: error.message };
  return { ok: true };
}

export type OfferInput = {
  providerId: string;
  amount: number;
  serviceType?: string;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  durationHours?: number;
  notes?: string | null;
  address?: string | null;
};

/* The only way into a negotiation. Returns the resulting offer — which may already be
   `accepted` (at or above the provider's instant-accept price) or `declined` (below their hidden
   floor). The caller must NOT infer anything from a decline beyond "not accepted": the copy is
   deliberately uniform so the floor can't be triangulated. */
export async function makeOffer(input: OfferInput): Promise<{ data: Offer } | { error: string }> {
  const { data, error } = await supabase.rpc('start_negotiation', {
    p_provider_id: input.providerId,
    p_amount: input.amount,
    p_service_type: input.serviceType ?? 'one-time',
    p_scheduled_date: input.scheduledDate ?? null,
    p_scheduled_time: input.scheduledTime ?? null,
    p_duration_hours: input.durationHours ?? 2,
    p_notes: input.notes ?? null,
    p_address: input.address ?? null,
  });
  if (error) return { error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { error: 'No offer was created. Please try again.' };
  return { data: row as Offer };
}

export async function respondToOffer(
  bookingId: string,
  action: 'accept' | 'counter' | 'decline',
  amount?: number,
): Promise<{ data: Offer } | { error: string }> {
  const { data, error } = await supabase.rpc('respond_offer', {
    p_booking_id: bookingId,
    p_action: action,
    p_amount: amount ?? null,
  });
  if (error) return { error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  return row ? { data: row as Offer } : { error: 'No response recorded.' };
}

export async function fetchOffers(bookingId: string): Promise<Offer[]> {
  const { data } = await supabase
    .from('offers')
    .select('*')
    .eq('booking_id', bookingId)
    .order('round', { ascending: true });
  return (data ?? []) as Offer[];
}

// Whose move is it? Returns null when the negotiation is over.
export function whoseTurn(offers: Offer[]): 'customer' | 'provider' | null {
  const open = offers.find((o) => o.status === 'pending');
  if (!open) return null;
  return open.actor_role === 'customer' ? 'provider' : 'customer';
}

export function hoursLeft(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 3600e3));
}
