/* Shared admin-console vocabulary: the route guard, dispute label maps, and the admin refund
   call. Security lives in the DB (is_admin() policies + RPC guards) and the API route — the
   guard here is navigation UX, not a boundary. */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  supabase, type DisputeReason, type DisputeOutcome, type KycStatus, type ServiceProvider,
} from '@/lib/supabase';

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

/* ------------------------------------------------------------------ Step 9: provider applications
   The queue and its documents come from the service-role route: the kyc_* columns are not
   granted to `authenticated` and the IDs live in a private bucket. The DECISION goes straight to
   the DB instead — review_provider_application re-checks is_admin() itself, so the guard that
   matters is never the browser's. */

export type ProviderApplicationRow = {
  id: string;
  user_id: string;
  business_name: string | null;
  city: string | null;
  state: string | null;
  status: ServiceProvider['status'];
  kyc_status: KycStatus;
  hourly_rate: number;
  applied_at: string | null;
  reviewed_at: string | null;
  document_count: number;
  service_categories: { name: string } | null;
};

export type ProviderApplicationDocument = {
  path: string;
  label: string;
  name: string | null;
  mime: string | null;
  url: string | null;   // short-lived signed URL, minted server-side
};

export type ProviderApplicationDetail = {
  application: ProviderApplicationRow & {
    bio: string | null;
    experience_years: number;
    address: string | null;
    is_verified: boolean;
    rejection_reason: string | null;
    reviewed_by: string | null;
    created_at: string;
  };
  documents: ProviderApplicationDocument[];
  owner: {
    name: string | null;
    phone: string | null;
    email: string | null;
    location: string | null;
    member_since: string | null;
  };
};

async function adminGet<T>(path: string): Promise<{ data: T } | { error: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: 'Please sign in again.' };
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { error: json?.error ?? 'Request failed.' };
  return { data: json as T };
}

export function fetchProviderApplications() {
  return adminGet<{ applications: ProviderApplicationRow[] }>('/api/admin/provider-applications');
}

export function fetchProviderApplication(id: string) {
  return adminGet<ProviderApplicationDetail>(
    `/api/admin/provider-applications?id=${encodeURIComponent(id)}`,
  );
}

// Approve → approved + verified + notified + bookable. Reject → reason recorded + notified, and
// the provider can edit and resubmit. Admin-only, enforced inside the RPC.
export async function reviewProviderApplication(
  providerId: string,
  decision: 'approve' | 'reject',
  reason?: string,
): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase.rpc('review_provider_application', {
    p_provider_id: providerId,
    p_decision: decision,
    p_reason: reason?.trim() || null,
  });
  if (error) return { error: error.message };
  return { ok: true };
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
