/* Shared admin-console vocabulary: the route guard, dispute label maps, and the admin refund
   call. Security lives in the DB (is_admin() policies + RPC guards) and the API route — the
   guard here is navigation UX, not a boundary. */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { supabase, type DisputeReason, type DisputeOutcome } from '@/lib/supabase';

// Redirects non-admins away. Returns 'ok' only for a confirmed admin; render nothing (or a
// loading shell) while 'checking' — the profile row arrives async after the user does.
export function useAdminGuard(): 'checking' | 'ok' {
  const { user, profile, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace('/auth/signin'); return; }
    if (profile && profile.role !== 'admin') router.replace('/');
  }, [user, profile, loading, router]);
  return !loading && user && profile?.role === 'admin' ? 'ok' : 'checking';
}

export const REASON_LABELS: Record<DisputeReason, string> = {
  work_not_done: 'Work not done',
  poor_quality: 'Poor quality',
  overcharged: 'Overcharged',
  no_show: 'No-show',
  damage: 'Damage',
  payment_not_received: 'Payment not received',
  customer_behaviour: 'Customer behaviour',
  other: 'Other',
};

export const OUTCOME_LABELS: Record<DisputeOutcome, string> = {
  favor_customer: 'Favour customer (full refund)',
  favor_provider: 'Favour provider (release escrow)',
  partial: 'Partial refund (split)',
  no_fault: 'No fault (release escrow)',
};

export type PartyContact = {
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  business_name?: string | null;
};
export type DisputeContacts = { customer: PartyContact; provider: PartyContact };

// Fetch both parties' contact details for a dispute (admin-only server route — the provider's
// business phone/address + emails are otherwise unreachable from the client). For the admin
// console only; never surfaced to the other party.
export async function fetchDisputeContacts(
  disputeId: string,
): Promise<{ data: DisputeContacts } | { error: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: 'Please sign in again.' };
  const res = await fetch(`/api/admin/dispute-contacts?disputeId=${encodeURIComponent(disputeId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { error: json?.error ?? 'Could not load contacts.' };
  return { data: json as DisputeContacts };
}

// Issue the REAL gateway refund after resolve_dispute has recorded the decision (the RPC can't
// call Razorpay). Admin-only server-side; amount in RUPEES (the route converts to paise).
export async function adminDisputeRefund(
  bookingId: string,
  amountRupees?: number,
): Promise<{ ok: true; refunded?: boolean; skipped?: string } | { error: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: 'Please sign in again.' };
  const res = await fetch('/api/payments/refund', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ bookingId, amount: amountRupees, disputeResolution: true }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { error: json?.error ?? 'Refund failed at the gateway.' };
  return { ok: true, ...json };
}
