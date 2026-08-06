/* Step 9 — client helpers for the provider application. Uploads to the PRIVATE 'kyc-docs' bucket
   and calls submit_provider_application; reads the caller's own row back through the
   my_provider_profile view (the kyc_* columns carry no SELECT grant to `authenticated`).

   Security lives in the DB: the RPC is the only way to start onboarding, the BEFORE INSERT
   trigger + INSERT column grants force status='pending' / is_verified=false whatever the client
   sends, and storage RLS confines each user to their own <user_id>/… folder. What's here is
   convenience plus the friendly pre-flight validation. */

import {
  supabase, type KycDocument, type ServiceProvider,
  type CategoryKycRequirement, type DocumentChecklistItem, type ProviderExperience,
} from '@/lib/supabase';

export const KYC_BUCKET = 'kyc-docs';
export const MAX_KYC_BYTES = 10_485_760; // 10 MB — mirrors the bucket's file_size_limit
export const MAX_KYC_DOCS = 2;

// Kept in sync with the bucket's allowed_mime_types (migration 20260731120000).
export const KYC_ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
];
export const KYC_ACCEPT = 'image/*,application/pdf';

/* ── Step 9.5: which documents a category actually needs ─────────────────────
   Step 9 asked everyone for the same two generic slots. Requirements now live in data, so a
   plumber sees one ID and a selfie while a driver additionally sees DL, RC and insurance. */

// Readable by anyone (both tables carry a public SELECT policy) — the form needs this BEFORE a
// provider row exists, so it can't use the provider-scoped checklist RPC.
export async function fetchCategoryRequirements(categoryId: string): Promise<CategoryKycRequirement[]> {
  const { data, error } = await supabase
    .from('category_kyc_requirements')
    .select('id, category_id, doc_code, requirement, unlocks_tier, note, kyc_document_types(code, label, description, capture_method, carries_expiry, is_sensitive, retention_days)')
    .eq('category_id', categoryId);
  if (error) { console.error('Failed to load category requirements:', error.message); return []; }
  const order = { required: 1, badge: 2, payout: 3, optional: 4 } as Record<string, number>;
  return ((data ?? []) as unknown as CategoryKycRequirement[])
    .sort((a, b) => (order[a.requirement] ?? 9) - (order[b.requirement] ?? 9));
}

// Once the provider row exists: the same list, plus what's been supplied and its status.
export async function fetchDocumentChecklist(providerId: string): Promise<DocumentChecklistItem[]> {
  const { data, error } = await supabase.rpc('provider_document_checklist', { p_provider_id: providerId });
  if (error) { console.error('Failed to load document checklist:', error.message); return []; }
  return (data ?? []) as DocumentChecklistItem[];
}

// Record a document against the caller's own provider row. Always born 'pending' — the client
// cannot mark anything verified, and a verified document cannot be silently replaced.
export async function recordDocument(input: {
  docCode: string;
  filePath?: string | null;
  referenceNumber?: string | null;   // stored masked (last 4) by the RPC
  expiresAt?: string | null;
}): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase.rpc('record_provider_document', {
    p_doc_code: input.docCode,
    p_file_path: input.filePath ?? null,
    p_reference_number: input.referenceNumber ?? null,
    p_issued_at: null,
    p_expires_at: input.expiresAt ?? null,
    p_meta: {},
  });
  if (error) return { error: error.message };
  return { ok: true };
}

/* DigiLocker is the preferred capture path: issuer-signed, machine-readable, and it means we
   store no photocopy at all. It needs registered credentials, so it is an ADAPTER STUB for now
   (same pattern as Step 9's request_ekyc) — the UI offers it, and falls back to upload. */
export async function requestDigiLocker(docCode: string): Promise<{ configured: boolean; message: string }> {
  const { data, error } = await supabase.rpc('request_digilocker_pull', { p_doc_code: docCode });
  if (error) return { configured: false, message: error.message };
  return {
    configured: data !== 'digilocker_not_configured',
    message: 'DigiLocker isn\'t connected yet — upload the document instead and our team will check it.',
  };
}

/* ── Experience: CAPABILITY, never reputation (§7.3) ───────────────────────── */

export async function fetchExperience(providerId: string): Promise<ProviderExperience[]> {
  const { data } = await supabase
    .from('provider_experience')
    .select('*')
    .eq('provider_id', providerId)
    .order('from_date', { ascending: false });
  return (data ?? []) as ProviderExperience[];
}

export async function addExperience(input: {
  employerName: string; role?: string; fromDate?: string | null; toDate?: string | null;
}): Promise<{ ok: true } | { error: string }> {
  const { error } = await supabase.rpc('record_provider_experience', {
    p_employer_name: input.employerName,
    p_role: input.role ?? null,
    p_from_date: input.fromDate || null,
    p_to_date: input.toDate || null,
  });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function removeExperience(id: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc('delete_provider_experience', { p_id: id });
  return error ? { error: error.message } : {};
}

// EPFO verification of employment history — adapter stub, as above.
export async function requestEpfoHistory(uan: string): Promise<{ configured: boolean; message: string }> {
  const { data, error } = await supabase.rpc('request_epfo_history', { p_uan: uan });
  if (error) return { configured: false, message: error.message };
  return {
    configured: data !== 'epfo_not_configured',
    message: 'EPFO verification isn\'t connected yet — our team will confirm your history manually.',
  };
}

// Total verified years, for the "5 yrs verified experience" line. Display only.
export function verifiedYears(rows: ProviderExperience[]): number {
  const months = rows.filter((r) => r.verified && r.from_date).reduce((sum, r) => {
    const from = new Date(r.from_date as string);
    const to = r.to_date ? new Date(r.to_date) : new Date();
    return sum + Math.max(0, (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()));
  }, 0);
  return Math.floor(months / 12);
}

// The provider's own row, as read back from my_provider_profile.
export type MyApplication = Pick<ServiceProvider,
  | 'id' | 'category_id' | 'business_name' | 'bio' | 'experience_years' | 'hourly_rate'
  | 'city' | 'state' | 'address' | 'status' | 'is_verified' | 'kyc_status' | 'kyc_documents'
  | 'rejection_reason' | 'applied_at' | 'reviewed_at' | 'trust_tier'>;

// trust_tier needs no column grant here: my_provider_profile is a view filtered to auth.uid() and
// granted wholesale, so the owner reads their own tier through it.
const MY_APPLICATION_COLUMNS =
  'id, category_id, business_name, bio, experience_years, hourly_rate, city, state, address, ' +
  'status, is_verified, kyc_status, kyc_documents, rejection_reason, applied_at, reviewed_at, trust_tier';

const extFromName = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > -1 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : 'bin';
};

export function validateKycFile(file: File): string | null {
  if (file.size > MAX_KYC_BYTES) return `“${file.name}” is over the 10 MB limit.`;
  if (file.type && !KYC_ALLOWED_MIME.includes(file.type)) {
    return `“${file.name}” — please upload a photo or PDF.`;
  }
  return null;
}

// Read the caller's own application, or null if they've never applied. Uses the definer view:
// service_providers itself hides these columns from `authenticated`.
export async function fetchMyApplication(): Promise<MyApplication | null> {
  const { data, error } = await supabase
    .from('my_provider_profile')
    .select(MY_APPLICATION_COLUMNS)
    .maybeSingle();
  if (error) {
    console.error('Failed to load provider application:', error.message);
    return null;
  }
  return (data as MyApplication | null) ?? null;
}

// Upload one document into the caller's own folder. Storage RLS re-checks the path prefix, so a
// forged key can't land in someone else's folder.
export async function uploadKycDoc(
  file: File,
  label: string,
): Promise<{ data: KycDocument } | { error: string }> {
  const validationError = validateKycFile(file);
  if (validationError) return { error: validationError };

  const uid = (await supabase.auth.getUser()).data.user?.id;
  if (!uid) return { error: 'Please sign in again.' };

  const path = `${uid}/${crypto.randomUUID()}.${extFromName(file.name)}`;
  const { error } = await supabase.storage.from(KYC_BUCKET).upload(path, file, {
    contentType: file.type || undefined,
    upsert: false,
  });
  if (error) return { error: error.message };

  return {
    data: {
      path,
      label,
      name: file.name,
      mime: file.type || null,
      uploaded_at: new Date().toISOString(),
    },
  };
}

// Drop a document the user removed before submitting. Storage RLS refuses once they're verified.
export async function removeKycDoc(path: string): Promise<void> {
  await supabase.storage.from(KYC_BUCKET).remove([path]);
}

export type ApplicationInput = {
  categoryId: string;
  businessName: string;
  bio: string;
  experienceYears: number;
  hourlyRate: number;
  city: string;
  state: string | null;
  area: string;
  documents: KycDocument[];
};

// The ONE write path into onboarding. Upserts the caller's single row and marks KYC submitted —
// the row is always born (and stays) pending until an admin reviews it.
export async function submitApplication(
  input: ApplicationInput,
): Promise<{ data: MyApplication } | { error: string }> {
  const { error } = await supabase.rpc('submit_provider_application', {
    p_category_id: input.categoryId,
    p_business_name: input.businessName,
    p_bio: input.bio,
    p_experience_years: input.experienceYears,
    p_hourly_rate: input.hourlyRate,
    p_city: input.city,
    p_state: input.state,
    p_address: input.area,
    p_documents: input.documents,
  });
  if (error) return { error: error.message };

  // Re-read through the view rather than trusting the returned row — the status screen should
  // reflect what the DB actually stored (pending), not what the client hoped for.
  const row = await fetchMyApplication();
  if (!row) return { error: 'Application saved, but could not be read back. Please refresh.' };
  return { data: row };
}
