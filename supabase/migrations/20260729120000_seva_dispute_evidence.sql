/* Seva — Step 8.5: dispute evidence. Run AFTER Step 8 (20260728120000 + the lockdown).

   Why this exists: Step 8 let the RAISER type a description, but the accused party could only
   answer in chat — an asymmetry that makes the "losing" side feel railroaded and churn. Because
   Step 8 also made reputation FAULT-based, weak evidence means an honest party can take a
   permanent hit. So BOTH parties get a formal channel to attach evidence (images / video / audio
   / pdf) while a dispute is open; the admin weighs it to assign fault correctly.

   Boundaries (mirroring the disputes model):
     - Files live in a PRIVATE Storage bucket; everyone views via short-lived SIGNED urls.
     - A party sees ONLY THEIR OWN evidence (no peeking at / reacting to the other side mid-case);
       the ADMIN sees everything. This keeps the dispute from escalating into a side-argument.
     - Evidence is append-only for the record; the uploader may delete their own while the dispute
       is still open (a mis-upload), never after it's resolved.
     - Writes are a plain RLS-gated INSERT — evidence is descriptive content, not money or
       reputation, so the "one SECURITY DEFINER writer" rule (invariants #2/#4) doesn't apply. */

-- 1) Private bucket. 50 MB/file so short video/audio clips fit; type-restricted server-side.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('dispute-evidence', 'dispute-evidence', false, 52428800, ARRAY[
  'image/jpeg','image/png','image/webp','image/heic','image/heif',
  'video/mp4','video/webm','video/quicktime',
  'audio/mpeg','audio/mp4','audio/webm','audio/x-m4a',
  'application/pdf'
])
ON CONFLICT (id) DO NOTHING;

-- 2) Evidence metadata. One row per uploaded file; the file itself is the storage object at
--    <dispute_id>/<uuid>.<ext> inside the bucket (that path convention is what the storage
--    policies below key their party checks on).
CREATE TABLE IF NOT EXISTS dispute_evidence (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  dispute_id    UUID REFERENCES disputes(id) ON DELETE CASCADE NOT NULL,
  booking_id    UUID REFERENCES bookings(id) ON DELETE CASCADE NOT NULL,
  uploaded_by   UUID REFERENCES auth.users(id) NOT NULL,
  uploader_role TEXT NOT NULL CHECK (uploader_role IN ('customer','provider')),
  file_path     TEXT NOT NULL,   -- storage object key within the 'dispute-evidence' bucket
  mime_type     TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('image','video','audio','file')),
  caption       TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evidence_dispute ON dispute_evidence(dispute_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evidence_booking ON dispute_evidence(booking_id);

ALTER TABLE dispute_evidence ENABLE ROW LEVEL SECURITY;
REVOKE UPDATE ON dispute_evidence FROM authenticated, anon;  -- append-only; no edits after posting

-- read: your OWN rows, or everything if you're the admin.
DROP POLICY IF EXISTS "read_evidence" ON dispute_evidence;
CREATE POLICY "read_evidence" ON dispute_evidence FOR SELECT TO authenticated
USING (uploaded_by = auth.uid() OR public.is_admin());

-- insert: you must be a PARTY to the booking, your uploader_role must be TRUTHFUL, and the
-- dispute must still be open (not resolved). The role clauses double as the party check.
DROP POLICY IF EXISTS "insert_evidence" ON dispute_evidence;
CREATE POLICY "insert_evidence" ON dispute_evidence FOR INSERT TO authenticated
WITH CHECK (
  uploaded_by = auth.uid()
  AND EXISTS (SELECT 1 FROM disputes d
              WHERE d.id = dispute_id AND d.booking_id = dispute_evidence.booking_id
                AND d.status <> 'resolved')
  AND (
    (uploader_role = 'customer'
       AND EXISTS (SELECT 1 FROM bookings b WHERE b.id = booking_id AND b.customer_id = auth.uid()))
    OR
    (uploader_role = 'provider'
       AND EXISTS (SELECT 1 FROM bookings b JOIN service_providers sp ON sp.id = b.provider_id
                   WHERE b.id = booking_id AND sp.user_id = auth.uid()))
  )
);

-- delete: the uploader may remove their OWN file while the dispute is still open (mis-upload).
DROP POLICY IF EXISTS "delete_own_evidence" ON dispute_evidence;
CREATE POLICY "delete_own_evidence" ON dispute_evidence FOR DELETE TO authenticated
USING (uploaded_by = auth.uid()
       AND EXISTS (SELECT 1 FROM disputes d WHERE d.id = dispute_id AND d.status <> 'resolved'));

-- 3) Storage object policies (bucket 'dispute-evidence'). The object key's first path segment is
--    the dispute id, so party access derives from the dispute's booking. is_booking_party /
--    is_admin are SECURITY DEFINER and callable by authenticated.
DROP POLICY IF EXISTS "dispute_evidence_read" ON storage.objects;
CREATE POLICY "dispute_evidence_read" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'dispute-evidence'
  AND (owner = auth.uid() OR public.is_admin())
);

DROP POLICY IF EXISTS "dispute_evidence_insert" ON storage.objects;
CREATE POLICY "dispute_evidence_insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'dispute-evidence'
  AND EXISTS (
    SELECT 1 FROM disputes d
    WHERE d.id::text = split_part(name, '/', 1)
      AND public.is_booking_party(d.booking_id)
      AND d.status <> 'resolved'
  )
);

DROP POLICY IF EXISTS "dispute_evidence_delete" ON storage.objects;
CREATE POLICY "dispute_evidence_delete" ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'dispute-evidence'
  AND owner = auth.uid()
  AND EXISTS (
    SELECT 1 FROM disputes d
    WHERE d.id::text = split_part(name, '/', 1) AND d.status <> 'resolved'
  )
);
