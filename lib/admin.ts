/* Shared admin-console vocabulary: the route guard, dispute label maps, and the admin refund
   call. Security lives in the DB (is_admin() policies + RPC guards) and the API route — the
   guard here is navigation UX, not a boundary. */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  supabase, type KycStatus, type ServiceProvider,
  type DocumentStatus, type ProviderExperience,
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

// The dispute vocabulary is shared with the party side (lib/disputes.ts owns it) — the admin
// console and /bookings/[id] must never disagree about what a reason or an outcome is called.
export { REASON_LABELS, OUTCOME_LABELS } from '@/lib/disputes';

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
  category_id: string | null;
  business_name: string | null;
  city: string | null;
  state: string | null;
  status: ServiceProvider['status'];
  kyc_status: KycStatus;
  hourly_rate: number;
  trust_tier: number;
  applied_at: string | null;
  reviewed_at: string | null;
  // Step 9.5: completeness against what this provider's CATEGORY requires
  documents_required: number;
  documents_verified: number;
  service_categories: { name: string } | null;
};

// One row of the admin checklist: what the category asks for, plus whatever was supplied.
export type ProviderApplicationDocument = {
  doc_code: string;
  label: string;
  description: string | null;
  capture_method: string;
  carries_expiry: boolean;
  // Bucket C (10): 'optional' is the named second-ID slot. It never blocks approval, but the
  // reviewer must still see it — an extra document nobody looks at is not a document.
  requirement: 'required' | 'badge' | 'optional';
  note: string | null;
  document_id: string | null;
  verification_status: DocumentStatus | null;
  verified_source: string | null;
  reference_number: string | null;
  expires_at: string | null;
  // What the applicant said this is: meta.id_type ('aadhaar', 'pan', …) and, for the selfie,
  // meta.capture ('live' | 'upload_fallback'). Descriptive, client-asserted — it tells the
  // reviewer what they're looking at, it does not stand in for looking at it.
  meta: Record<string, unknown> | null;
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
  experience: ProviderExperience[];
  blocking: string[];   // required documents not yet verified — approval is refused while non-empty
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

/** The queue is BOUNDED server-side (200 pending / 100 decided), so `counts` reports the true
 *  totals alongside the page. Without them the console cannot distinguish "nothing waiting" from
 *  "we only sent you the first page" — the distinction that hid a real pending application when
 *  PostgREST silently truncated the old unbounded query at 1,000 rows. */
export function fetchProviderApplications() {
  return adminGet<{
    applications: ProviderApplicationRow[];
    counts?: { pending: number; decided: number; pending_shown: number; decided_shown: number };
  }>('/api/admin/provider-applications');
}

export function fetchProviderApplication(id: string) {
  return adminGet<ProviderApplicationDetail>(
    `/api/admin/provider-applications?id=${encodeURIComponent(id)}`,
  );
}

// Step 9.5: mark an individual document verified (with an expiry where it carries one) or
// rejected. Approval of the APPLICATION is refused by the DB until every required document here
// is verified — so this is the real gate, not the Approve button.
export async function reviewProviderDocument(
  documentId: string,
  status: 'verified' | 'rejected',
  expiresAt?: string | null,
  note?: string,
): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase.rpc('review_provider_document', {
    p_document_id: documentId,
    p_status: status,
    p_expires_at: expiresAt || null,
    p_note: note?.trim() || null,
  });
  if (error) return { error: error.message };
  return { ok: true };
}

// Confirm a provider's claimed work history. CAPABILITY only — it never moves their score.
export async function verifyProviderExperience(
  id: string,
  source: 'epfo' | 'employer_ref' | 'rpl' = 'employer_ref',
): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase.rpc('verify_provider_experience', { p_id: id, p_source: source });
  if (error) return { error: error.message };
  return { ok: true };
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
