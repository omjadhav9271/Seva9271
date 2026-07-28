/* Seva — Step 9.5: category-aware KYC, trust tiers, portable experience.
   Run AFTER 20260801120000_seva_reverify_on_category_change.sql.
   Spec: /docs/Seva-Step-9.5.md

   Step 9 asked every provider for the same two generic files. This makes the gate know what it
   is checking — and keeps it light for the 11 of 25 categories that need nothing but an ID.

   Four documented additions beyond the spec's SQL block (the Step-8 DEV-x convention):
     ADD-A  record_provider_document / record_provider_experience — the spec says "writes go
            through the RPC only" but never defines them. Without them the table is unwritable.
     ADD-B  review_provider_document — the admin must be able to mark a document verified (with
            an expiry) before approval can check it. Approval-gating is meaningless otherwise.
     ADD-C  request_digilocker_pull / request_epfo_history — adapter STUBS. DigiLocker and EPFO
            need registered vendor credentials; the flow and gating are real, the vendor is a
            later commercial integration. Same pattern as Step 9's request_ekyc.
     ADD-D  provider_experience is created BEFORE recompute_trust_tier, which reads it. Safe
            either way (PL/pgSQL bodies resolve at run time) but ordered so it reads correctly.

   NOTE the invariant that matters most: compute_reputation must NEVER read provider_experience.
   Off-platform history is forgeable, and §7.3 depends on reputation accruing only on-platform. */

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) THE DOCUMENT LIBRARY. Adding a document type is a row, not a deploy.
CREATE TABLE IF NOT EXISTS kyc_document_types (
  code           TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  description    TEXT,
  capture_method TEXT NOT NULL CHECK (capture_method IN ('digilocker','api_number','upload','vendor')),
  carries_expiry BOOLEAN NOT NULL DEFAULT false,
  is_sensitive   BOOLEAN NOT NULL DEFAULT true,
  retention_days INT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE kyc_document_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_doc_types" ON kyc_document_types;
CREATE POLICY "read_doc_types" ON kyc_document_types FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON kyc_document_types FROM authenticated, anon;

INSERT INTO kyc_document_types (code, label, description, capture_method, carries_expiry, retention_days) VALUES
  ('photo_id',           'Government photo ID',     'Aadhaar via DigiLocker, or DL / Passport / Voter ID',            'digilocker', false, 1095),
  ('selfie',             'Selfie',                  'Enrollment photo — later checks match against THIS, not the ID', 'upload',     false, 1095),
  ('pan',                'PAN',                     'Needed to pay you — collected before your first payout',         'api_number', false, 2555),
  ('dl',                 'Driving licence',         'Commercial licence with badge where the vehicle needs one',      'digilocker', true,  1095),
  ('rc',                 'Vehicle RC',              'Registration certificate of the vehicle you use',                'digilocker', true,  1095),
  ('insurance',          'Vehicle insurance',       'Valid policy for the vehicle you use',                           'digilocker', true,  1095),
  ('fssai',              'FSSAI registration',      'Food business registration number',                              'api_number', true,  1095),
  ('council_reg',        'Council registration',    'NMC / State Medical Council / Nursing Council number',           'api_number', true,  1095),
  ('police_verification','Police verification',     'Background check — unlocks high-trust work',                     'vendor',     true,  1095),
  ('rpl_cert',           'Skill certificate (RPL)', 'Recognition of Prior Learning under PMKVY — free, govt-funded',   'upload',     false, 1095),
  ('epfo_history',       'Employment history',      'Verified from EPFO against your UAN',                            'api_number', false, 1095)
ON CONFLICT (code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) WHAT EACH CATEGORY NEEDS. Adding a category = insert rows here, no deploy.
--    'required' blocks approval · 'badge' never blocks, it unlocks a tier ·
--    'payout' is required before the first payout, not before going live.
CREATE TABLE IF NOT EXISTS category_kyc_requirements (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category_id  UUID REFERENCES service_categories(id) ON DELETE CASCADE NOT NULL,
  doc_code     TEXT REFERENCES kyc_document_types(code) NOT NULL,
  requirement  TEXT NOT NULL CHECK (requirement IN ('required','badge','payout','optional')),
  unlocks_tier INT,
  note         TEXT,
  UNIQUE (category_id, doc_code)
);
CREATE INDEX IF NOT EXISTS idx_cat_kyc_req ON category_kyc_requirements(category_id);
ALTER TABLE category_kyc_requirements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_cat_requirements" ON category_kyc_requirements;
CREATE POLICY "read_cat_requirements" ON category_kyc_requirements FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON category_kyc_requirements FROM authenticated, anon;

-- Base, for EVERY category.
INSERT INTO category_kyc_requirements (category_id, doc_code, requirement)
SELECT c.id, d.code, d.req
FROM service_categories c
CROSS JOIN (VALUES ('photo_id','required'), ('selfie','required'), ('pan','payout')) AS d(code, req)
ON CONFLICT DO NOTHING;

-- Driving: what Uber / Ola / Rapido / Swiggy all ask for.
INSERT INTO category_kyc_requirements (category_id, doc_code, requirement)
SELECT c.id, d.code, 'required'
FROM service_categories c CROSS JOIN (VALUES ('dl'), ('rc'), ('insurance')) AS d(code)
WHERE c.slug IN ('driver','auto-driver','delivery')
ON CONFLICT DO NOTHING;

-- Food & water: what Swiggy / Zomato ask for.
INSERT INTO category_kyc_requirements (category_id, doc_code, requirement)
SELECT c.id, 'fssai', 'required' FROM service_categories c
WHERE c.slug IN ('home-cook','farm-fresh','water-tanker')
ON CONFLICT DO NOTHING;

-- Medical: what Practo asks for.
INSERT INTO category_kyc_requirements (category_id, doc_code, requirement)
SELECT c.id, 'council_reg', 'required' FROM service_categories c
WHERE c.slug = 'doctor'
ON CONFLICT DO NOTHING;

-- In-home / vulnerable: a BADGE that unlocks tier 3 — never a gate.
INSERT INTO category_kyc_requirements (category_id, doc_code, requirement, unlocks_tier, note)
SELECT c.id, 'police_verification', 'badge', 3,
       'Optional. Unlocks live-in / childcare / elderly-overnight work and the Police Verified badge.'
FROM service_categories c
WHERE c.slug IN ('caretaker','maid','house-cleaning','beauty','tutor',
                 'driver','auto-driver','delivery','doctor','home-cook')
ON CONFLICT DO NOTHING;

-- Everything else (plumber, carpenter, painter, mason, appliance-repair, mobile-repair, tailor,
-- laundry, cycle-mechanic, gardening, cow-dung, electrician, security) needs NOTHING beyond base.
-- Deliberate: Urban Company trains and certifies rather than demanding a state trade licence.

-- New categories inherit the base requirements automatically.
CREATE OR REPLACE FUNCTION public.seed_base_kyc_for_category()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO category_kyc_requirements (category_id, doc_code, requirement)
  VALUES (NEW.id,'photo_id','required'), (NEW.id,'selfie','required'), (NEW.id,'pan','payout')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_seed_base_kyc ON service_categories;
CREATE TRIGGER trg_seed_base_kyc AFTER INSERT ON service_categories
FOR EACH ROW EXECUTE FUNCTION public.seed_base_kyc_for_category();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) PROVIDER DOCUMENTS — a real table, replacing the loose JSONB blob.
CREATE TABLE IF NOT EXISTS provider_documents (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_id         UUID REFERENCES service_providers(id) ON DELETE CASCADE NOT NULL,
  doc_code            TEXT REFERENCES kyc_document_types(code) NOT NULL,
  file_path           TEXT,
  reference_number    TEXT,                  -- masked: last 4 only, never the full number
  verification_status TEXT NOT NULL DEFAULT 'pending'
                      CHECK (verification_status IN ('pending','verified','rejected','expired')),
  verified_source     TEXT CHECK (verified_source IN ('digilocker','api','admin','vendor')),
  issued_at           DATE,
  expires_at          DATE,
  meta                JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  verified_at         TIMESTAMPTZ,
  verified_by         UUID REFERENCES auth.users(id),
  UNIQUE (provider_id, doc_code)
);
CREATE INDEX IF NOT EXISTS idx_provider_docs ON provider_documents(provider_id, verification_status);
CREATE INDEX IF NOT EXISTS idx_provider_docs_expiry ON provider_documents(expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE provider_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_own_or_admin_documents" ON provider_documents;
CREATE POLICY "read_own_or_admin_documents" ON provider_documents FOR SELECT TO authenticated
USING (public.is_admin()
       OR EXISTS (SELECT 1 FROM service_providers sp
                  WHERE sp.id = provider_id AND sp.user_id = auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON provider_documents FROM authenticated, anon;  -- RPC-only

-- Backfill Step 9's JSONB documents so nobody has to re-upload.
INSERT INTO provider_documents (provider_id, doc_code, file_path, verification_status, verified_source, verified_at)
SELECT sp.id, 'photo_id', d->>'path',
       CASE WHEN sp.kyc_status = 'verified' THEN 'verified' ELSE 'pending' END,
       'admin', sp.reviewed_at
FROM service_providers sp, jsonb_array_elements(COALESCE(sp.kyc_documents, '[]'::jsonb)) d
WHERE d->>'path' IS NOT NULL
ON CONFLICT (provider_id, doc_code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) ADD-D: PORTABLE EXPERIENCE — displayed, verified, and deliberately NOT scored.
CREATE TABLE IF NOT EXISTS provider_experience (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_id   UUID REFERENCES service_providers(id) ON DELETE CASCADE NOT NULL,
  employer_name TEXT NOT NULL,
  role          TEXT,
  from_date     DATE,
  to_date       DATE,
  source        TEXT NOT NULL CHECK (source IN ('epfo','employer_ref','rpl','self_declared')),
  verified      BOOLEAN NOT NULL DEFAULT false,
  verified_at   TIMESTAMPTZ,
  meta          JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON TABLE provider_experience IS
  'CAPABILITY, not reputation. compute_reputation must NEVER read this table: off-platform '
  'history is forgeable, and §7.3 depends on reputation accruing ONLY on-platform.';
CREATE INDEX IF NOT EXISTS idx_provider_experience ON provider_experience(provider_id);

ALTER TABLE provider_experience ENABLE ROW LEVEL SECURITY;
-- Verified experience is PUBLIC (it's a selling point); unverified is owner + admin only.
DROP POLICY IF EXISTS "read_experience" ON provider_experience;
CREATE POLICY "read_experience" ON provider_experience FOR SELECT TO anon, authenticated
USING (verified OR public.is_admin()
       OR EXISTS (SELECT 1 FROM service_providers sp
                  WHERE sp.id = provider_id AND sp.user_id = auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON provider_experience FROM authenticated, anon;  -- RPC-only

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) TRUST TIER — what a provider may be booked for. Server-computed (invariant #1).
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS trust_tier INT NOT NULL DEFAULT 1;
COMMENT ON COLUMN service_providers.trust_tier IS
  '1 identity-verified · 2 credential/experience-verified · 3 background-verified. Server-only.';

CREATE OR REPLACE FUNCTION public.recompute_trust_tier(p_provider_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tier int := 1; v_has_police boolean; v_has_credential boolean; v_has_experience boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM provider_documents
                 WHERE provider_id = p_provider_id AND doc_code = 'police_verification'
                   AND verification_status = 'verified'
                   AND (expires_at IS NULL OR expires_at > CURRENT_DATE)) INTO v_has_police;
  SELECT EXISTS (SELECT 1 FROM provider_documents
                 WHERE provider_id = p_provider_id
                   AND doc_code NOT IN ('photo_id','selfie','pan','police_verification')
                   AND verification_status = 'verified'
                   AND (expires_at IS NULL OR expires_at > CURRENT_DATE)) INTO v_has_credential;
  SELECT EXISTS (SELECT 1 FROM provider_experience
                 WHERE provider_id = p_provider_id AND verified) INTO v_has_experience;

  IF v_has_credential OR v_has_experience THEN v_tier := 2; END IF;
  IF v_has_police THEN v_tier := 3; END IF;
  UPDATE service_providers SET trust_tier = v_tier WHERE id = p_provider_id;
  RETURN v_tier;
END; $$;
GRANT EXECUTE ON FUNCTION public.recompute_trust_tier(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) What is this provider still missing? Drives the form AND the admin console.
--    SECURITY DEFINER, so it gates its OWN access — otherwise any signed-in user could
--    enumerate another provider's gaps. (The Step-9 lesson: a definer function bypasses
--    column grants and RLS, so it must carry its own check.)
CREATE OR REPLACE FUNCTION public.provider_missing_documents(p_provider_id uuid)
RETURNS TABLE (doc_code text, label text, requirement text, capture_method text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.doc_code, t.label, r.requirement, t.capture_method
  FROM service_providers sp
  JOIN category_kyc_requirements r ON r.category_id = sp.category_id
  JOIN kyc_document_types t ON t.code = r.doc_code
  WHERE sp.id = p_provider_id
    AND (public.is_admin() OR sp.user_id = auth.uid())
    AND r.requirement = 'required'
    AND NOT EXISTS (
      SELECT 1 FROM provider_documents pd
      WHERE pd.provider_id = sp.id AND pd.doc_code = r.doc_code
        AND pd.verification_status = 'verified'
        AND (pd.expires_at IS NULL OR pd.expires_at > CURRENT_DATE));
$$;
GRANT EXECUTE ON FUNCTION public.provider_missing_documents(uuid) TO authenticated;

-- Everything this provider's category asks for, with whatever they've supplied. Drives the form.
CREATE OR REPLACE FUNCTION public.provider_document_checklist(p_provider_id uuid)
RETURNS TABLE (doc_code text, label text, description text, requirement text, capture_method text,
               carries_expiry boolean, unlocks_tier int, note text,
               document_id uuid, verification_status text, expires_at date, file_path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.doc_code, t.label, t.description, r.requirement, t.capture_method,
         t.carries_expiry, r.unlocks_tier, r.note,
         pd.id, pd.verification_status, pd.expires_at, pd.file_path
  FROM service_providers sp
  JOIN category_kyc_requirements r ON r.category_id = sp.category_id
  JOIN kyc_document_types t ON t.code = r.doc_code
  LEFT JOIN provider_documents pd ON pd.provider_id = sp.id AND pd.doc_code = r.doc_code
  WHERE sp.id = p_provider_id
    AND (public.is_admin() OR sp.user_id = auth.uid())
  ORDER BY CASE r.requirement WHEN 'required' THEN 1 WHEN 'badge' THEN 2 ELSE 3 END, t.label;
$$;
GRANT EXECUTE ON FUNCTION public.provider_document_checklist(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) ADD-A: the write path. A provider records a document; it is ALWAYS born 'pending'.
CREATE OR REPLACE FUNCTION public.record_provider_document(
  p_doc_code text, p_file_path text DEFAULT NULL, p_reference_number text DEFAULT NULL,
  p_issued_at date DEFAULT NULL, p_expires_at date DEFAULT NULL, p_meta jsonb DEFAULT '{}'
) RETURNS provider_documents LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider uuid; d provider_documents;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'must be signed in'; END IF;
  SELECT id INTO v_provider FROM service_providers WHERE user_id = auth.uid();
  IF v_provider IS NULL THEN RAISE EXCEPTION 'no provider profile — apply first'; END IF;
  IF NOT EXISTS (SELECT 1 FROM kyc_document_types WHERE code = p_doc_code) THEN
    RAISE EXCEPTION 'unknown document type %', p_doc_code;
  END IF;
  -- A verified provider cannot silently swap the evidence behind their badge (Step-9 rule).
  IF EXISTS (SELECT 1 FROM provider_documents
             WHERE provider_id = v_provider AND doc_code = p_doc_code
               AND verification_status = 'verified') THEN
    RAISE EXCEPTION 'this document is already verified and cannot be replaced — contact support';
  END IF;

  INSERT INTO provider_documents (provider_id, doc_code, file_path, reference_number,
                                  issued_at, expires_at, meta, verification_status)
  VALUES (v_provider, p_doc_code, p_file_path,
          -- never store a full number: keep the last 4 only
          CASE WHEN p_reference_number IS NULL THEN NULL
               ELSE repeat('X', GREATEST(length(p_reference_number) - 4, 0))
                    || right(p_reference_number, 4) END,
          p_issued_at, p_expires_at, COALESCE(p_meta,'{}'::jsonb), 'pending')
  ON CONFLICT (provider_id, doc_code) DO UPDATE SET
    file_path = EXCLUDED.file_path, reference_number = EXCLUDED.reference_number,
    issued_at = EXCLUDED.issued_at, expires_at = EXCLUDED.expires_at,
    meta = EXCLUDED.meta, verification_status = 'pending',
    verified_source = NULL, verified_at = NULL, verified_by = NULL, created_at = NOW()
  RETURNING * INTO d;
  RETURN d;
END; $$;
GRANT EXECUTE ON FUNCTION public.record_provider_document(text,text,text,date,date,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_provider_experience(
  p_employer_name text, p_role text DEFAULT NULL,
  p_from_date date DEFAULT NULL, p_to_date date DEFAULT NULL
) RETURNS provider_experience LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider uuid; e provider_experience;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'must be signed in'; END IF;
  SELECT id INTO v_provider FROM service_providers WHERE user_id = auth.uid();
  IF v_provider IS NULL THEN RAISE EXCEPTION 'no provider profile — apply first'; END IF;
  -- Self-declared, and it stays unverified until EPFO/RPL/an admin says otherwise.
  INSERT INTO provider_experience (provider_id, employer_name, role, from_date, to_date, source, verified)
  VALUES (v_provider, p_employer_name, p_role, p_from_date, p_to_date, 'self_declared', false)
  RETURNING * INTO e;
  RETURN e;
END; $$;
GRANT EXECUTE ON FUNCTION public.record_provider_experience(text,text,date,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_provider_experience(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM provider_experience e
  USING service_providers sp
  WHERE e.id = p_id AND sp.id = e.provider_id AND sp.user_id = auth.uid() AND NOT e.verified;
  RETURN FOUND;
END; $$;
GRANT EXECUTE ON FUNCTION public.delete_provider_experience(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) ADD-B: the admin marks a document verified (with an expiry) or rejects it.
CREATE OR REPLACE FUNCTION public.review_provider_document(
  p_document_id uuid, p_status text, p_expires_at date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS provider_documents LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d provider_documents;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  IF p_status NOT IN ('verified','rejected') THEN RAISE EXCEPTION 'status must be verified/rejected'; END IF;

  UPDATE provider_documents SET
    verification_status = p_status,
    verified_source = 'admin',
    expires_at = COALESCE(p_expires_at, expires_at),
    verified_at = NOW(), verified_by = auth.uid(),
    meta = CASE WHEN p_note IS NULL THEN meta ELSE meta || jsonb_build_object('admin_note', p_note) END
  WHERE id = p_document_id RETURNING * INTO d;
  IF NOT FOUND THEN RAISE EXCEPTION 'document not found'; END IF;

  PERFORM public.recompute_trust_tier(d.provider_id);
  RETURN d;
END; $$;
REVOKE EXECUTE ON FUNCTION public.review_provider_document(uuid,text,date,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.review_provider_document(uuid,text,date,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.verify_provider_experience(p_id uuid, p_source text DEFAULT 'employer_ref')
RETURNS provider_experience LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e provider_experience;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  IF p_source NOT IN ('epfo','employer_ref','rpl') THEN RAISE EXCEPTION 'invalid source %', p_source; END IF;
  UPDATE provider_experience SET verified = true, source = p_source, verified_at = NOW()
  WHERE id = p_id RETURNING * INTO e;
  IF NOT FOUND THEN RAISE EXCEPTION 'experience row not found'; END IF;
  PERFORM public.recompute_trust_tier(e.provider_id);
  RETURN e;
END; $$;
REVOKE EXECUTE ON FUNCTION public.verify_provider_experience(uuid,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.verify_provider_experience(uuid,text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9) Approval now CHECKS the paperwork, and starts the provider at a real score.
CREATE OR REPLACE FUNCTION public.review_provider_application(
  p_provider_id uuid, p_decision text, p_reason text DEFAULT NULL
) RETURNS service_providers LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sp service_providers; v_missing text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  IF p_decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'decision must be approve/reject'; END IF;

  -- An admin can no longer approve a driver with no licence by accident.
  IF p_decision = 'approve' THEN
    SELECT string_agg(label, ', ') INTO v_missing
    FROM public.provider_missing_documents(p_provider_id);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'cannot approve — required documents missing or unverified: %', v_missing;
    END IF;
  END IF;

  UPDATE service_providers SET
    status      = CASE WHEN p_decision='approve' THEN 'approved' ELSE 'rejected' END,
    is_verified = (p_decision='approve'),
    kyc_status  = CASE WHEN p_decision='approve' THEN 'verified' ELSE 'rejected' END,
    rejection_reason = CASE WHEN p_decision='reject' THEN p_reason ELSE NULL END,
    reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  WHERE id = p_provider_id RETURNING * INTO sp;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider not found'; END IF;

  IF p_decision = 'approve' THEN
    PERFORM public.recompute_trust_tier(p_provider_id);
    -- Start them at the Bayesian prior (~4.3) instead of a blank 0 until the nightly cron runs.
    PERFORM public.compute_reputation('provider', p_provider_id);
  END IF;

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
GRANT EXECUTE ON FUNCTION public.review_provider_application(uuid,text,text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10) Expiry sweep — a badge backed by lapsed insurance is worse than no badge.
CREATE OR REPLACE FUNCTION public.expire_provider_documents()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; r RECORD;
BEGIN
  FOR r IN
    UPDATE provider_documents SET verification_status = 'expired'
    WHERE verification_status = 'verified'
      AND expires_at IS NOT NULL AND expires_at <= CURRENT_DATE
    RETURNING provider_id
  LOOP
    v_count := v_count + 1;
    PERFORM public.recompute_trust_tier(r.provider_id);
  END LOOP;
  RETURN v_count;
END; $$;
REVOKE EXECUTE ON FUNCTION public.expire_provider_documents() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_provider_documents() TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11) ADD-C: vendor adapters — STUBS, exactly like Step 9's request_ekyc.
--     The flow and the gating are real; DigiLocker and EPFO need registered credentials and
--     are a later commercial integration. Returning a documented sentinel keeps the UI honest.
CREATE OR REPLACE FUNCTION public.request_digilocker_pull(p_doc_code text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT 'digilocker_not_configured'::text;
$$;
GRANT EXECUTE ON FUNCTION public.request_digilocker_pull(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_epfo_history(p_uan text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT 'epfo_not_configured'::text;
$$;
GRANT EXECUTE ON FUNCTION public.request_epfo_history(text) TO authenticated;
