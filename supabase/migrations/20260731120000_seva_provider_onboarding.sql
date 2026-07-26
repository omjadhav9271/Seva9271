/* Seva — Step 9: provider onboarding + verification. Run AFTER Step 8.

   Sections 1–5 are /docs/Seva-Step-9.md's SQL verbatim. Sections 6–9 are ADDITIONS the spec's
   "App wiring" section requires but its SQL block omits — documented here in the Step-8 DEV-x
   style (the precedent: implement what the step actually needs, and say so out loud).

   ADD-A (§6)  private 'kyc-docs' bucket + storage RLS. The spec mandates a private bucket with
               owner+admin reads; without it there is nowhere for the documents to go.
   ADD-B (§7)  my_provider_profile is recreated. It was defined as `SELECT *`, which Postgres
               EXPANDS AT CREATION TIME — so the kyc columns added in §2 would be invisible
               through it. That view is the only way a provider reads their own server-only
               columns (Step-7.5 column grants), i.e. the entire /become-provider status screen.
   ADD-C (§8)  the booking gate. insert_own_booking only checked `auth.uid() = customer_id`, and
               /providers/[id] never filtered status — so a PENDING provider was bookable via a
               direct link. The step's definition of done requires that closed.
   ADD-D       the §2 columns get NO SELECT grant, deliberately. kyc_documents / rejection_reason
               are application PII; the admin console reads them through a service-role API route
               (/api/admin/provider-applications), never the browser. Nothing to write here —
               noted so the omission reads as a decision, not an oversight.

   PREFLIGHT (done 2026-07-26): §2's uniq_provider_per_user fails if any user owns 2+ provider
   rows. test1@gmail.com had two identical "Test Provider" rows from a double-run seed; the
   later one's 2 bookings were repointed onto the surviving row and the empty duplicate dropped.
   Re-check before applying elsewhere:
     SELECT user_id, count(*) FROM service_providers GROUP BY 1 HAVING count(*) > 1; */

-- 1) 🔴 CLOSE THE SELF-VERIFICATION HOLE. A provider row must be born pending + unverified,
--    no matter what the client sends. Restrict INSERT to safe columns and force the rest.
REVOKE INSERT ON service_providers FROM authenticated;
GRANT  INSERT (user_id, category_id, business_name, bio, experience_years, hourly_rate,
               city, state, address, latitude, longitude, documents, gallery)
       ON service_providers TO authenticated;
-- status / is_verified / rating / reputation_score / total_* are NOT grantable → they take their
-- safe DEFAULTs (pending / false / 0). A client literally cannot set them at insert time.

-- Belt-and-suspenders: force safe birth state even if a default drifts.
CREATE OR REPLACE FUNCTION public.enforce_provider_birth_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.status := 'pending'; NEW.is_verified := false;
  NEW.rating := 0; NEW.reputation_score := 0;
  NEW.total_reviews := 0; NEW.total_bookings := 0;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_provider_birth ON service_providers;
CREATE TRIGGER trg_provider_birth BEFORE INSERT ON service_providers
FOR EACH ROW EXECUTE FUNCTION public.enforce_provider_birth_state();

-- 2) Application / verification metadata on the provider row.
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'unsubmitted'
  CHECK (kyc_status IN ('unsubmitted','submitted','verified','rejected'));
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS kyc_documents JSONB DEFAULT '[]';
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id);
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- one provider profile per user (enables upsert / resubmit)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_provider_per_user ON service_providers(user_id);

-- 3) submit_provider_application — the ONLY way a user starts onboarding. Upserts the caller's
--    row, marks KYC submitted. Always births/keeps status pending (birth trigger + no status set).
CREATE OR REPLACE FUNCTION public.submit_provider_application(
  p_category_id uuid, p_business_name text, p_bio text, p_experience_years int,
  p_hourly_rate numeric, p_city text, p_state text, p_address text,
  p_documents jsonb DEFAULT '[]'
) RETURNS service_providers LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sp service_providers;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'must be signed in'; END IF;
  INSERT INTO service_providers (user_id, category_id, business_name, bio, experience_years,
                                 hourly_rate, city, state, address, kyc_documents,
                                 kyc_status, applied_at)
  VALUES (auth.uid(), p_category_id, p_business_name, p_bio, p_experience_years,
          p_hourly_rate, p_city, p_state, p_address, p_documents, 'submitted', now())
  ON CONFLICT (user_id) DO UPDATE SET
    category_id=EXCLUDED.category_id, business_name=EXCLUDED.business_name, bio=EXCLUDED.bio,
    experience_years=EXCLUDED.experience_years, hourly_rate=EXCLUDED.hourly_rate,
    city=EXCLUDED.city, state=EXCLUDED.state, address=EXCLUDED.address,
    kyc_documents=EXCLUDED.kyc_documents, kyc_status='submitted', applied_at=now(),
    rejection_reason=NULL
  RETURNING * INTO sp;
  RETURN sp;
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_provider_application(uuid,text,text,int,numeric,text,text,text,jsonb) TO authenticated;

-- 4) review_provider_application — ADMIN ONLY. Approve → active + verified; reject → reason.
CREATE OR REPLACE FUNCTION public.review_provider_application(
  p_provider_id uuid, p_decision text, p_reason text DEFAULT NULL
) RETURNS service_providers LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sp service_providers;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  IF p_decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'decision must be approve/reject'; END IF;

  UPDATE service_providers SET
    status      = CASE WHEN p_decision='approve' THEN 'approved' ELSE 'rejected' END,
    is_verified = (p_decision='approve'),
    kyc_status  = CASE WHEN p_decision='approve' THEN 'verified' ELSE 'rejected' END,
    rejection_reason = CASE WHEN p_decision='reject' THEN p_reason ELSE NULL END,
    reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  WHERE id = p_provider_id RETURNING * INTO sp;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider not found'; END IF;

  INSERT INTO notifications (user_id, title, message, type, link) VALUES (
    sp.user_id,
    CASE WHEN p_decision='approve' THEN 'You''re verified!' ELSE 'Application needs changes' END,
    CASE WHEN p_decision='approve' THEN 'Your provider profile is live — you can now receive bookings.'
         ELSE COALESCE(p_reason, 'Your application was not approved. Please review and resubmit.') END,
    CASE WHEN p_decision='approve' THEN 'success' ELSE 'warning' END,
    '/become-provider');
  RETURN sp;
END; $$;
REVOKE EXECUTE ON FUNCTION public.review_provider_application(uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.review_provider_application(uuid,text,text) TO authenticated; -- is_admin() guards inside

-- 5) Aadhaar eKYC / background-check adapter — STUB. The gating (admin approval) is real now;
--    a real vendor (Digio/Signzy/Cashfree) is a later commercial integration.
CREATE OR REPLACE FUNCTION public.request_ekyc(p_provider_id uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT 'ekyc_stub_pending'::text;
$$;

-- ============================================================================================
-- 6) ADD-A: private 'kyc-docs' bucket + storage RLS.
--    ID documents are the most sensitive PII on the platform. Never public: the owner and the
--    admin reach them through short-lived SIGNED urls only. Object key is <user_id>/<uuid>.<ext>,
--    and the insert policy keys on that first path segment — a user can only write their own
--    folder, so paths can't be forged to land in someone else's.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('kyc-docs', 'kyc-docs', false, 10485760, ARRAY[
  'image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'
])
ON CONFLICT (id) DO NOTHING;

-- Helper: "are my KYC documents frozen?" (i.e. am I already verified). SECURITY DEFINER because
-- kyc_status carries NO select grant to authenticated (ADD-D) and a policy expression is
-- evaluated with the CALLER's column privileges — the Step-7.5 migration learned this the hard
-- way. Same trick as is_admin().
CREATE OR REPLACE FUNCTION public.kyc_docs_frozen()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM service_providers
                 WHERE user_id = auth.uid() AND kyc_status = 'verified');
$$;
GRANT EXECUTE ON FUNCTION public.kyc_docs_frozen() TO authenticated;

-- read: your own documents, or everything if you're the admin (who must actually see the ID).
DROP POLICY IF EXISTS "kyc_docs_read" ON storage.objects;
CREATE POLICY "kyc_docs_read" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'kyc-docs'
  AND (owner = auth.uid() OR split_part(name, '/', 1) = auth.uid()::text OR public.is_admin())
);

-- write: only into YOUR OWN folder.
DROP POLICY IF EXISTS "kyc_docs_insert" ON storage.objects;
CREATE POLICY "kyc_docs_insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'kyc-docs'
  AND split_part(name, '/', 1) = auth.uid()::text
);

-- delete: your own file, but only until you're verified — after approval the documents that
-- justified it stay put (mirrors "no evidence edits after a dispute resolves", Step 8.5).
DROP POLICY IF EXISTS "kyc_docs_delete" ON storage.objects;
CREATE POLICY "kyc_docs_delete" ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'kyc-docs'
  AND split_part(name, '/', 1) = auth.uid()::text
  AND NOT public.kyc_docs_frozen()
);

-- 7) ADD-B: refresh my_provider_profile so the owner can read their own kyc_* columns.
--    `SELECT *` was expanded when the view was created (Step 7.5), so it is frozen at the old
--    column list until replaced. ALTER TABLE appends, so the existing columns keep their names,
--    types and order — which is exactly what CREATE OR REPLACE VIEW allows.
CREATE OR REPLACE VIEW my_provider_profile WITH (security_barrier) AS
  SELECT * FROM service_providers WHERE user_id = auth.uid();
REVOKE ALL ON my_provider_profile FROM anon, authenticated;
GRANT SELECT ON my_provider_profile TO authenticated;

-- 8) ADD-C: the booking gate. A pending / rejected / suspended provider cannot be booked, not
--    even by a customer who guessed the id — the providers LIST filtered on status, but the
--    insert never did, so a direct link (or a raw POST) sailed straight through.
--    RLS rather than a trigger, on purpose: service-role seeding (verify scripts, fixtures)
--    must still be able to stage any state it likes.
--    `status` is column-granted to authenticated (Step 7.5), so this reads fine as the caller.
DROP POLICY IF EXISTS "insert_own_booking" ON bookings;
CREATE POLICY "insert_own_booking" ON bookings FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = customer_id
  AND EXISTS (SELECT 1 FROM service_providers sp
              WHERE sp.id = bookings.provider_id AND sp.status = 'approved')
);
