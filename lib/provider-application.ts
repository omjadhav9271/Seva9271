/* Step 9 — client helpers for the provider application. Uploads to the PRIVATE 'kyc-docs' bucket
   and calls submit_provider_application; reads the caller's own row back through the
   my_provider_profile view (the kyc_* columns carry no SELECT grant to `authenticated`).

   Security lives in the DB: the RPC is the only way to start onboarding, the BEFORE INSERT
   trigger + INSERT column grants force status='pending' / is_verified=false whatever the client
   sends, and storage RLS confines each user to their own <user_id>/… folder. What's here is
   convenience plus the friendly pre-flight validation. */

import { supabase, type KycDocument, type ServiceProvider } from '@/lib/supabase';

export const KYC_BUCKET = 'kyc-docs';
export const MAX_KYC_BYTES = 10_485_760; // 10 MB — mirrors the bucket's file_size_limit
export const MAX_KYC_DOCS = 2;

// Kept in sync with the bucket's allowed_mime_types (migration 20260731120000).
export const KYC_ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
];
export const KYC_ACCEPT = 'image/*,application/pdf';

// The two document slots. One is enough to review; the second is optional corroboration.
export const KYC_SLOTS = [
  { key: 'Photo ID', hint: 'Aadhaar, PAN, passport or driving licence', required: true },
  { key: 'Address or trade proof', hint: 'Optional — utility bill, shop licence', required: false },
] as const;

// The provider's own row, as read back from my_provider_profile.
export type MyApplication = Pick<ServiceProvider,
  | 'id' | 'category_id' | 'business_name' | 'bio' | 'experience_years' | 'hourly_rate'
  | 'city' | 'state' | 'address' | 'status' | 'is_verified' | 'kyc_status' | 'kyc_documents'
  | 'rejection_reason' | 'applied_at' | 'reviewed_at'>;

const MY_APPLICATION_COLUMNS =
  'id, category_id, business_name, bio, experience_years, hourly_rate, city, state, address, ' +
  'status, is_verified, kyc_status, kyc_documents, rejection_reason, applied_at, reviewed_at';

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
