/* Step 8.5 — client helpers for dispute evidence. Upload/list/sign/delete against the private
   'dispute-evidence' Storage bucket + the dispute_evidence table. Security lives in the DB
   (bucket type/size limits + storage & table RLS); these are the app-side conveniences + the
   validation that gives a friendly error before the request leaves the browser. */

import { supabase, type DisputeEvidence, type EvidenceKind } from '@/lib/supabase';

export const EVIDENCE_BUCKET = 'dispute-evidence';
export const MAX_FILE_BYTES = 52_428_800; // 50 MB — mirrors the bucket's file_size_limit
export const MAX_FILES_PER_PARTY = 8;

// Kept in sync with the bucket's allowed_mime_types (migration 20260729120000).
export const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/x-m4a',
  'application/pdf',
];
export const EVIDENCE_ACCEPT = 'image/*,video/*,audio/*,application/pdf';

export function kindFromMime(mime: string): EvidenceKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

const extFromName = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > -1 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : 'bin';
};

export function validateEvidenceFile(file: File): string | null {
  if (file.size > MAX_FILE_BYTES) return `“${file.name}” is over the 50 MB limit.`;
  if (file.type && !ALLOWED_MIME.includes(file.type)) return `“${file.name}” — unsupported type (${file.type || 'unknown'}).`;
  return null;
}

// Upload one file to the bucket, then record its metadata row. RLS on both the object and the
// row re-checks that the caller is a party and the dispute is still open — this can't be forged
// client-side. Returns the created row or an error message.
export async function uploadEvidence(opts: {
  disputeId: string;
  bookingId: string;
  uploaderRole: 'customer' | 'provider';
  file: File;
  caption?: string;
}): Promise<{ data: DisputeEvidence } | { error: string }> {
  const { disputeId, bookingId, uploaderRole, file, caption } = opts;
  const validationError = validateEvidenceFile(file);
  if (validationError) return { error: validationError };

  const uid = (await supabase.auth.getUser()).data.user?.id;
  if (!uid) return { error: 'Please sign in again.' };

  const key = `${disputeId}/${crypto.randomUUID()}.${extFromName(file.name)}`;
  const { error: upErr } = await supabase.storage.from(EVIDENCE_BUCKET).upload(key, file, {
    contentType: file.type || undefined,
    upsert: false,
  });
  if (upErr) return { error: upErr.message };

  const { data, error } = await supabase
    .from('dispute_evidence')
    .insert({
      dispute_id: disputeId,
      booking_id: bookingId,
      uploader_role: uploaderRole,
      uploaded_by: uid,
      file_path: key,
      mime_type: file.type || null,
      kind: kindFromMime(file.type || ''),
      caption: caption?.trim() || null,
    })
    .select('*')
    .single();
  if (error) {
    // Roll back the orphaned object so a failed insert doesn't leave a file with no row.
    await supabase.storage.from(EVIDENCE_BUCKET).remove([key]);
    return { error: error.message };
  }
  return { data: data as DisputeEvidence };
}

// Short-lived signed URL for viewing/streaming a private object (RLS still gates who can sign).
export async function evidenceSignedUrl(filePath: string, expiresIn = 3600): Promise<string | null> {
  const { data } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(filePath, expiresIn);
  return data?.signedUrl ?? null;
}

// Delete an evidence row + its object (uploader-only, while the dispute is open — enforced by RLS).
export async function deleteEvidence(row: Pick<DisputeEvidence, 'id' | 'file_path'>): Promise<{ error?: string }> {
  const { error } = await supabase.from('dispute_evidence').delete().eq('id', row.id);
  if (error) return { error: error.message };
  await supabase.storage.from(EVIDENCE_BUCKET).remove([row.file_path]);
  return {};
}

export async function listEvidence(disputeId: string): Promise<DisputeEvidence[]> {
  const { data } = await supabase
    .from('dispute_evidence')
    .select('*')
    .eq('dispute_id', disputeId)
    .order('created_at', { ascending: true });
  return (data as DisputeEvidence[] | null) ?? [];
}
