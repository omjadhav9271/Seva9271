# Seva — Playbook Step 9.5: Category-aware KYC, trust tiers & portable experience

> Follows Step 9 (`/docs/Seva-Step-9.md`, migrations `20260731120000` + `20260801120000`). Architecture §7.1, §7.3, §6. Read `CLAUDE.md` first.
>
> Step 9 built the *gate*: apply → private documents → admin approves → verified. It asks every provider for the same two generic files. This step makes the gate **know what it is checking**, and — just as important — makes it **light for the 11 of 25 categories that need nothing more than an ID**.

---

## Design lens: what comparable Indian platforms do

Decided deliberately: we follow **peer practice**, not a regulation-first reading. In most categories the two agree anyway — Uber demands a commercial licence because the RTO does — so copying peers gets us most compliance for free, without a lawyer in the loop for every category.

| Segment | What peers require | Source of the norm |
|---|---|---|
| Everyone | Aadhaar/ID + PAN | Urban Company, Swiggy, Uber |
| Driving | Commercial DL, RC, insurance, police verification | Uber, Ola, Rapido, Swiggy |
| Food | FSSAI registration | Swiggy, Zomato |
| Medical | Council registration number | Practo |
| In-home / domestic | Police verification **sold as a badge**, not a gate | Bookmybai, Broomees, NoBroker |
| Trades (electrician, plumber…) | *No state licence* — platform trains and certifies instead | Urban Company |

That last row is the one that changes our build: Urban Company doesn't ask an electrician for a state wireman licence. They assess and train. We follow that.

---

## UX bar for this step

- **Nothing gets heavier for the 11 categories that need nothing.** A plumber still finishes in three minutes: one ID, one selfie. If a change makes that longer, it's wrong.
- **DigiLocker first, always.** Most providers should upload *no files at all*.
- **Documents unlock, they don't block** — except where a peer platform would also block (driving, food, medical).
- **Never ask twice.** A document verified once, with an expiry, is not re-requested until it expires.
- **An experienced provider must not look like a novice.** Verified experience shows on the profile from day one.

---

## Where you are (grounded in the current repo)

- `service_providers.kyc_documents` is a **JSONB array** of `{path,label,name,mime,uploaded_at}` — two generic slots, no type, no expiry, no verification source.
- Every category asks for the same thing. A driver is never asked for a licence; a home cook is never asked for FSSAI.
- Documents are **files in the `kyc-docs` bucket**. That is the pattern UIDAI is moving against for Aadhaar specifically, and it's the most expensive way to verify anything.
- `review_provider_application` approves on the admin's judgement alone — nothing stops approving a driver with no licence attached.
- **A new provider displays as `0.0 (0 reviews)`** even though `compute_reputation` would score them **4.3** (Bayesian prior `0.7×4.0 + 0.3×5`). The engine already refuses to start people at zero; the UI doesn't know that.
- `reputation_score` stays `0` until the nightly cron or a first review fires, so a freshly approved provider has **no trust badge at all**.

---

## Three decisions baked into this step

### 1. Identity, capability and reputation are three different things

| | Answers | Comes from | Feeds the score? |
|---|---|---|---|
| **Identity** | Who are you? | DigiLocker / ID / selfie | No |
| **Capability** | What can you do? | EPFO history, RPL cert, category licence | **No** |
| **Reputation** | How do you behave *here*? | Completed bookings + reviews | Yes — only this |

Experience is **capability**: verified and displayed, never scored. Two reasons, and the second is the one that matters — experience letters are cheap to forge, and per §7.3 *reputation only accruing on-platform is the lock-in that stops disintermediation*. Importing outside reputation would weaken the moat this whole product is built on.

### 2. Gate on exposure, not on job title

Two hours of dusting and a live-in carer for someone's grandmother are the same category and completely different risk. Documents gate **high-exposure work**; everything else is a badge the customer can filter on. This is what Bookmybai/Broomees/NoBroker do — they *sell* verification rather than mandating it — and it matches how the market actually behaves: most households hire domestic help on a neighbour's referral with no documents at all.

Our honest advantage over that status quo isn't paperwork. It's **escrow, the booking record, the chat log and a dispute process** — recourse the neighbourhood referral never had. Say that in the UI instead of pretending documents are the point.

### 3. Face match is triage, not a gate

An Aadhaar photo can be fifteen years old; failing an automated match against it is *expected*. Uber's answer: match the selfie against a **verified enrollment selfie**, not the ID. The ID→face comparison happens **once**, with a human resolving the middle band.

- High score → auto-pass. Middle → the admin is opening the application anyway. Low → retry.
- **Liveness is the real control** — it defeats holding up someone else's photo, whatever the ID's age.
- DigiLocker returns UIDAI's *current* photo, not a 2012 laminated card — another reason to prefer it.

---

## The migration (source of truth)

`supabase/migrations/20260802120000_seva_category_kyc.sql`:

```sql
/* Seva — Step 9.5: category-aware KYC, trust tiers, portable experience.
   Run AFTER 20260801120000_seva_reverify_on_category_change.sql. */

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) THE DOCUMENT LIBRARY. Adding a document type is a row, not a deploy.
CREATE TABLE IF NOT EXISTS kyc_document_types (
  code           TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  description    TEXT,
  -- how we OBTAIN it, cheapest and safest first
  capture_method TEXT NOT NULL CHECK (capture_method IN ('digilocker','api_number','upload','vendor')),
  carries_expiry BOOLEAN NOT NULL DEFAULT false,
  is_sensitive   BOOLEAN NOT NULL DEFAULT true,
  retention_days INT,                        -- purge this long after a provider leaves
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO kyc_document_types (code, label, description, capture_method, carries_expiry, retention_days) VALUES
  ('photo_id',           'Government photo ID',      'Aadhaar via DigiLocker, or DL / Passport / Voter ID', 'digilocker', false, 1095),
  ('selfie',             'Selfie with liveness',     'Enrollment photo; later checks match against THIS, not the ID', 'upload', false, 1095),
  ('pan',                'PAN',                      'Needed to pay you — collected before the first payout',        'api_number', false, 2555),
  ('dl',                 'Driving licence',          'Commercial licence with badge where the vehicle needs one',     'digilocker', true,  1095),
  ('rc',                 'Vehicle RC',               'Registration certificate of the vehicle used',                  'digilocker', true,  1095),
  ('insurance',          'Vehicle insurance',        'Valid policy for the vehicle used',                             'digilocker', true,  1095),
  ('fssai',              'FSSAI registration',       'Food business registration number',                             'api_number', true,  1095),
  ('council_reg',        'Council registration',     'NMC / State Medical Council / Nursing Council number',          'api_number', true,  1095),
  ('police_verification','Police verification',      'Background check — unlocks high-trust work',                    'vendor', true,  1095),
  ('rpl_cert',           'Skill certificate (RPL)',  'Recognition of Prior Learning under PMKVY — free, govt-funded', 'upload', false, 1095),
  ('epfo_history',       'Employment history',       'Verified from EPFO against the UAN',                            'api_number', false, 1095)
ON CONFLICT (code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) WHAT EACH CATEGORY NEEDS. Adding a category = insert rows here.
--    'required' blocks approval · 'badge' never blocks, it unlocks a tier · 'payout'
--    is required before the first payout, not before going live.
CREATE TABLE IF NOT EXISTS category_kyc_requirements (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category_id  UUID REFERENCES service_categories(id) ON DELETE CASCADE NOT NULL,
  doc_code     TEXT REFERENCES kyc_document_types(code) NOT NULL,
  requirement  TEXT NOT NULL CHECK (requirement IN ('required','badge','payout','optional')),
  unlocks_tier INT,                          -- for 'badge' rows
  note         TEXT,
  UNIQUE (category_id, doc_code)
);
CREATE INDEX IF NOT EXISTS idx_cat_kyc_req ON category_kyc_requirements(category_id);

-- Base, for EVERY category (including ones added later — see the trigger in §6).
INSERT INTO category_kyc_requirements (category_id, doc_code, requirement)
SELECT c.id, d.code, d.req
FROM service_categories c
CROSS JOIN (VALUES ('photo_id','required'), ('selfie','required'), ('pan','payout')) AS d(code, req)
ON CONFLICT DO NOTHING;

-- Driving: what Uber/Ola/Rapido/Swiggy all ask for.
INSERT INTO category_kyc_requirements (category_id, doc_code, requirement)
SELECT c.id, d.code, 'required'
FROM service_categories c
CROSS JOIN (VALUES ('dl'), ('rc'), ('insurance')) AS d(code)
WHERE c.slug IN ('driver','auto-driver','delivery')
ON CONFLICT DO NOTHING;

-- Food & water: what Swiggy/Zomato ask for.
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
       'Optional. Unlocks live-in / childcare / elderly-overnight work and the Police-Verified badge.'
FROM service_categories c
WHERE c.slug IN ('caretaker','maid','house-cleaning','beauty','tutor',
                 'driver','auto-driver','delivery','doctor','home-cook')
ON CONFLICT DO NOTHING;

-- Everything else (plumber, carpenter, painter, mason, appliance-repair, mobile-repair,
-- tailor, laundry, cycle-mechanic, gardening, cow-dung, electrician) needs NOTHING beyond base.
-- Deliberate: Urban Company trains and certifies rather than demanding a state trade licence.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) PROVIDER DOCUMENTS — a real table, replacing the loose JSONB blob.
CREATE TABLE IF NOT EXISTS provider_documents (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_id         UUID REFERENCES service_providers(id) ON DELETE CASCADE NOT NULL,
  doc_code            TEXT REFERENCES kyc_document_types(code) NOT NULL,
  file_path           TEXT,                  -- ONLY when capture_method='upload'
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
CREATE INDEX IF NOT EXISTS idx_provider_docs_expiry ON provider_documents(expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE provider_documents ENABLE ROW LEVEL SECURITY;
-- Owner reads their own; admins read all. NEVER readable by other customers.
DROP POLICY IF EXISTS "read_own_or_admin_documents" ON provider_documents;
CREATE POLICY "read_own_or_admin_documents" ON provider_documents FOR SELECT TO authenticated
USING (public.is_admin()
       OR EXISTS (SELECT 1 FROM service_providers sp
                  WHERE sp.id = provider_id AND sp.user_id = auth.uid()));
-- Writes go through the RPC only (verification status is not the client's to set).
REVOKE INSERT, UPDATE, DELETE ON provider_documents FROM authenticated, anon;

-- Backfill Step 9's JSONB documents as unverified photo IDs so nobody re-uploads.
INSERT INTO provider_documents (provider_id, doc_code, file_path, verification_status, verified_source, verified_at)
SELECT sp.id, 'photo_id', d->>'path',
       CASE WHEN sp.kyc_status = 'verified' THEN 'verified' ELSE 'pending' END,
       'admin', sp.reviewed_at
FROM service_providers sp, jsonb_array_elements(COALESCE(sp.kyc_documents, '[]'::jsonb)) d
WHERE d->>'path' IS NOT NULL
ON CONFLICT (provider_id, doc_code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) TRUST TIER — what a provider is allowed to be booked for.
--    1 identity-verified (default) · 2 credential-verified · 3 background-verified
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS trust_tier INT NOT NULL DEFAULT 1;
COMMENT ON COLUMN service_providers.trust_tier IS
  'Server-computed from verified documents. Never client-writable. 3 = police-verified.';

CREATE OR REPLACE FUNCTION public.recompute_trust_tier(p_provider_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tier int := 1; v_has_police boolean; v_has_credential boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM provider_documents
                 WHERE provider_id = p_provider_id AND doc_code = 'police_verification'
                   AND verification_status = 'verified'
                   AND (expires_at IS NULL OR expires_at > CURRENT_DATE))
    INTO v_has_police;
  SELECT EXISTS (SELECT 1 FROM provider_documents pd
                 JOIN kyc_document_types t ON t.code = pd.doc_code
                 WHERE pd.provider_id = p_provider_id
                   AND pd.doc_code NOT IN ('photo_id','selfie','pan')
                   AND pd.verification_status = 'verified'
                   AND (pd.expires_at IS NULL OR pd.expires_at > CURRENT_DATE))
    INTO v_has_credential;
  -- verified experience counts toward CAPABILITY (tier 2), never toward reputation
  IF v_has_credential OR EXISTS (SELECT 1 FROM provider_experience
                                 WHERE provider_id = p_provider_id AND verified) THEN v_tier := 2; END IF;
  IF v_has_police THEN v_tier := 3; END IF;
  UPDATE service_providers SET trust_tier = v_tier WHERE id = p_provider_id;
  RETURN v_tier;
END; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) PORTABLE EXPERIENCE — displayed, verified, and DELIBERATELY not scored.
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
  'CAPABILITY, not reputation. compute_reputation must never read this table: off-platform '
  'history is forgeable, and §7.3 depends on reputation accruing ONLY on-platform.';
CREATE INDEX IF NOT EXISTS idx_provider_experience ON provider_experience(provider_id);

ALTER TABLE provider_experience ENABLE ROW LEVEL SECURITY;
-- Verified experience is PUBLIC (it's a selling point); unverified is owner+admin only.
DROP POLICY IF EXISTS "read_experience" ON provider_experience;
CREATE POLICY "read_experience" ON provider_experience FOR SELECT TO authenticated, anon
USING (verified OR public.is_admin()
       OR EXISTS (SELECT 1 FROM service_providers sp
                  WHERE sp.id = provider_id AND sp.user_id = auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON provider_experience FROM authenticated, anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) New categories inherit the base requirements automatically.
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
-- 7) What is this provider still missing? Drives the form AND the admin console.
-- SECURITY DEFINER, so it must gate its OWN access: otherwise any signed-in user could
-- enumerate which documents any provider is missing. Owner or admin only.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) Approval now CHECKS the paperwork, and starts the provider at a real score.
CREATE OR REPLACE FUNCTION public.review_provider_application(
  p_provider_id uuid, p_decision text, p_reason text DEFAULT NULL
) RETURNS service_providers LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sp service_providers; v_missing text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  IF p_decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'decision must be approve/reject'; END IF;

  -- An admin can no longer approve a driver with no licence by accident.
  IF p_decision = 'approve' THEN
    SELECT string_agg(label, ', ') INTO v_missing FROM public.provider_missing_documents(p_provider_id);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'cannot approve — required documents missing or expired: %', v_missing;
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
-- 9) Expiry sweep — a badge backed by lapsed insurance is worse than no badge.
CREATE OR REPLACE FUNCTION public.expire_provider_documents()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  WITH expired AS (
    UPDATE provider_documents SET verification_status = 'expired'
    WHERE verification_status = 'verified'
      AND expires_at IS NOT NULL AND expires_at <= CURRENT_DATE
    RETURNING provider_id
  ) SELECT count(*) INTO v_count FROM expired;
  PERFORM public.recompute_trust_tier(provider_id)
    FROM (SELECT DISTINCT provider_id FROM provider_documents WHERE verification_status='expired') s;
  RETURN v_count;
END; $$;
REVOKE EXECUTE ON FUNCTION public.expire_provider_documents() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_provider_documents() TO service_role;
-- schedule nightly alongside recompute_all_reputation (pg_cron is already enabled)
```

---

## App wiring

**`/become-provider`** — after the category chip is chosen, call `provider_missing_documents` and render *only those slots*. A plumber sees one ID + selfie. A driver sees ID, selfie, DL, RC, insurance — with **"Fetch from DigiLocker"** as the primary button and upload demoted to "or upload instead". PAN is not asked for here at all; it's collected at first payout.

**Selfie step** — capture with liveness, store as the `selfie` document. This is the enrollment photo every later check compares against.

**Badges, not gates** — for `requirement='badge'` rows show an optional card: *"Get police-verified → unlock live-in and childcare work, and show the Police-Verified badge."* Never blocks submission.

**Experience** — "Add your work history": employer, role, dates. Offer **"Verify with EPFO"** (UAN → government-recorded employer list with joining/leaving dates) and **"I have an RPL certificate"**. Unverified entries show as *self-declared* to customers; verified ones carry a check.

**Admin console** — the detail page lists required vs supplied vs expired, straight from `provider_missing_documents`. Approve is disabled with the reason shown when something's missing (the RPC refuses anyway — this is just not letting the admin waste a click).

**Provider cards / detail** — two fixes for the cold-start problem:
- Show **"New"** instead of `0.0` when `total_reviews = 0`. A new provider is unrated, not zero-rated.
- Show the trust score as soon as it exists (approval now computes it, so it's ~4.3 on day one) plus **"5 yrs verified experience"** where present.

---

## Gotchas / decisions baked in

- **Aadhaar is never an upload.** DigiLocker or nothing. Other IDs may be uploaded. UIDAI is moving to bar private collection of Aadhaar copies, and you cannot legally mandate Aadhaar anyway — always accept DL/Passport/Voter ID.
- **PAN at payout, not signup.** TDS under §194-O is 0.1% with PAN and 5% without, so you need it before you *pay* someone — not before they fill a form. Framed as "needed to pay you", providers hand it over willingly.
- **`provider_experience` must never be read by `compute_reputation`.** It's asserted in the table comment and belongs in the verify script. This is the moat, not a detail.
- **Trust tier is server-computed**, like every other reputation field — invariant #1.
- **Documents expire.** DL, insurance, FSSAI, police verification all lapse. The nightly sweep demotes the tier automatically.
- **11 of 25 categories need nothing beyond base.** Resist adding "just one more document" to them.
- **Categories worth restructuring** (data, not code): split *Gardening & Pest Control*; split *Water Tanker / RO*; unbundle child care from *Caretaker*; capture profession + registration number separately for *Doctor*. **Defer Security Guard** — no consumer marketplace lists individual guards, and that absence is the signal.
- **Later, not now:** the state gig-worker acts (Rajasthan, Karnataka, Telangana) require aggregators to register and report onboarded workers. Maharashtra has none yet, so Mumbai-first buys time — but leave room for a per-state worker registration id.

### Notes for whoever applies this migration

- **`provider_missing_documents` gates itself.** It's `SECURITY DEFINER`, so without the `is_admin() OR sp.user_id = auth.uid()` clause any signed-in user could enumerate another provider's gaps. Same lesson as the Step-9 category hole: *a definer function bypasses column grants and RLS, so it must carry its own check.*
- **Ordering:** `recompute_trust_tier` (§4) references `provider_experience` (§5). That's safe — PL/pgSQL bodies aren't resolved until they run, and nothing calls it before §5 — but don't reorder the file so that it's *invoked* earlier.
- **`expire_provider_documents` recomputes tiers for every historically expired document,** not just newly expired ones. Harmless and idempotent; tighten if the table grows large.
- **The backfill is one-way.** Once `provider_documents` is populated, `service_providers.kyc_documents` becomes legacy. Leave the column in place for one release, then drop it in a follow-up rather than in this migration.

---

## Definition of done

- A **plumber** completes onboarding with one ID and one selfie, in about three minutes.
- A **driver** is asked for DL + RC + insurance, and an admin **cannot approve** them without those — the RPC refuses.
- **DigiLocker is the default path**; upload is visibly the fallback.
- A **maid** can go live with no police verification, and can *choose* to add one to earn the badge and unlock live-in work.
- An **electrician with 5 years at two companies** shows *"5 yrs verified experience"* from day one via EPFO — and still starts with an unwritten reputation.
- A brand-new approved provider shows a **trust score of ~4.3 and "New"**, never `0.0`.
- Documents that expire demote the trust tier automatically overnight.
- Adding a new category creates its base requirements with **no deploy**.
- `npm run typecheck` and `npm run build` pass; `node scripts/verify-all.mjs` stays green.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read CLAUDE.md, /docs/Seva-Step-9.md and /docs/Seva-Step-9.5.md (this spec) first.
Step 9 is committed and verified (278/278 via scripts/verify-all.mjs).

Build Step 9.5 EXACTLY as specified in /docs/Seva-Step-9.5.md:
1. Migration supabase/migrations/20260802120000_seva_category_kyc.sql as written — document
   library, category_kyc_requirements, provider_documents (+ backfill from the Step-9 JSONB),
   trust_tier + recompute_trust_tier, provider_experience, the new-category trigger,
   provider_missing_documents, the rewritten review_provider_application, and the expiry sweep.
2. /become-provider: render document slots from provider_missing_documents for the chosen
   category; DigiLocker primary, upload as fallback; liveness selfie; badge cards for optional
   documents; work-history section with EPFO/RPL verification.
3. Admin: show required vs supplied vs expired; disable Approve with the reason when incomplete.
4. Cold start: show "New" instead of 0.0 when total_reviews=0, and surface the trust score
   (approval now computes it) plus verified experience.
5. Types in lib/supabase.ts.

Do NOT:
- Let provider_experience feed compute_reputation, ever (§7.3 — this is the moat).
- Make Aadhaar mandatory or accept it as an upload.
- Ask for PAN, address proof or bank details during the application.
- Gate the domestic categories on police verification — it's a badge.
- Build the ranking/exploration boost — that's Step 11.

Done when: the Definition of done in /docs/Seva-Step-9.5.md holds, verify-all.mjs is green,
and scripts/verify-step9-5.mjs asserts: category-driven requirements; approval blocked when a
required document is missing/expired; trust tier recomputes; experience never moves the
reputation score; a new category inherits base requirements automatically.
```
