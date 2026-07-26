# Seva — Playbook Step 9: Provider Onboarding & Verification (KYC)

> Step 9 of `/docs/Seva-Claude-Code-Playbook.md` (architecture §7.1). Read `CLAUDE.md` first. This closes the gap you've hit all build long — there's no real way to *become* a provider — and adds the verification that makes "verified" mean something. Do this after Step 8 is committed.

---

## UX bar for this step — simple and efficient, like a good real-world service platform

The design principle: **friction should be asymmetric to intent.** The 95% who are customers should feel *nothing* new; the motivated few who become providers do a short, one-time application. Concretely:

- **Customers feel zero change.** This step is provider-side only. No new field, step, or verification touches customer signup or booking.
- **The provider application is ONE short form** — category, business name, service city/area, hourly rate, short bio, 1–2 ID documents. No portfolio, references, or long questionnaires. A provider finishes in a few minutes on a phone.
- **Save / resubmit without losing input** (the RPC upserts one row per user).
- **Status is honest and legible** — the #1 onboarding failure is silence. Pending → "Submitted, reviewed within 24–48h"; rejected → the exact reason + one-tap resubmit; approved → "You're live."
- **Admin console stays plain and functional** — a queue + approve/reject. Don't over-design it.
- **Keep the pending→approve GATE** — that's *safety, not friction*. The provider fills a form once and waits; nothing about that is complex for them, and it's what makes "verified" real.

Good platforms are **simple in the interface, strict in the guarantees.** Everything technical below is invisible plumbing that keeps the simple surface trustworthy — none of it adds user friction.

---

## Where you are (grounded in the current repo)

- **`/become-provider` is a fake.** Its `handleSubmit` does `setTimeout(2000)` then a success toast — it **never creates a `service_providers` row**. Every real provider so far was hand-inserted via SQL. That's the gap.
- **🔴 Self-verification hole.** `insert_own_provider` (`WITH CHECK auth.uid() = user_id`) lets a user insert their own provider row, and **INSERT column privileges were never restricted** (Step 1 only revoked *UPDATE*). So a user could insert a row with `status='approved', is_verified=true` and appear as a verified provider with zero reviews. The providers list shows anything `status='approved'`. This must be closed.
- **`profiles.role` is admin-capable and not client-writable**; the Step 8 admin console + `is_admin()` helper exist — an approval queue slots straight in.
- Providers are surfaced by `.eq('status','approved')`; `is_verified` drives the badge.

## Design: asymmetric verification (deliberate)

Not both sides equally — the risk isn't symmetric:

- **Customers → light.** A **verified phone (OTP)** is the anti-multi-account measure (SIMs cost money and tie to identity in India). Full KYC on every customer kills signup and is overkill — reviews already require a *paid* booking (real money trail). **No new customer KYC this step.**
- **Providers → strong.** Providers enter strangers' homes (cooks, childcare, elderly care) — this is physical safety, not just fraud. Real application → document upload → **admin approval** before they're ever `approved`/`is_verified`. Aadhaar eKYC / background checks are an **adapter stub** now (real integration is a business/vendor decision later); the *flow and gating* are what Step 9 builds.

---

## The migration (source of truth)

`supabase/migrations/20260731120000_seva_provider_onboarding.sql`:

```sql
/* Seva — Step 9: provider onboarding + verification. Run AFTER Step 8. */

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
```

---

## App wiring

**`app/become-provider/page.tsx` — make it real, keep it short.** Reuse the existing UI shell but collapse it to the essentials (category, business name, city/area, hourly rate, short bio, 1–2 ID docs). Replace the fake `handleSubmit` with `supabase.rpc('submit_provider_application', {...})`. Upload documents to a **private** Supabase Storage bucket `kyc-docs` and pass the paths in `p_documents`. Drive a real status screen from the row: `submitted` → "Under review, 24–48h"; `rejected` → show `rejection_reason` + resubmit; `approved` → "You're live." Prefill from the existing row if present.

**Storage bucket (private):** `kyc-docs`, RLS so a user reads/writes only their own folder and admins read all. KYC docs are **never** public — signed URLs for admins only.

**Admin console — extend Step 8's `/admin`:**
- `app/admin/providers/page.tsx` — queue of `kyc_status='submitted'` / `status='pending'` applications.
- `app/admin/providers/[id]/page.tsx` — application details + KYC docs (signed URLs) + **Approve / Reject (with reason)** → `review_provider_application`. Admin-only; non-admins redirected. Keep it plain.

**Booking gate:** confirm the booking/detail path only allows `status='approved'` providers (list already filters this — verify a `pending` provider can't be booked via a direct link).

**First admin** (if not already from Step 8):
```sql
UPDATE profiles SET role='admin' WHERE id=(SELECT id FROM auth.users WHERE email='you@example.com');
```

---

## Gotchas / decisions baked in

- **The self-verification hole is the security headline.** Two layers close it: INSERT column grants (client can't *send* `status`/`is_verified`) **and** a BEFORE INSERT trigger (forces safe birth state). Same belt-and-suspenders as the COD block.
- **Asymmetric by design** — heavy KYC for providers (safety), phone-only for customers (friction). Don't add customer KYC "for symmetry."
- **eKYC/background checks are a stub** — the *gating* is real and enforced; the *identity vendor* is a later commercial integration. Don't build real Aadhaar integration now.
- **KYC docs are private storage** — IDs/addresses are sensitive PII; signed URLs for admins only.
- **One provider profile per user** — resubmission updates the existing row, no duplicates.
- Existing hand-seeded providers already sit at `status='approved'` — they keep working; this only governs new applications.

---

## Definition of done

- A signed-in user completes `/become-provider` → a real `service_providers` row is created via `submit_provider_application`, **born `status='pending'`, `is_verified=false`, `kyc_status='submitted'`** — regardless of what the client sends.
- 🔴 A direct client insert (or the RPC) **cannot** create an `approved`/`is_verified` provider; a direct `insert({ status:'approved', is_verified:true })` is stripped/rejected.
- KYC documents upload to a **private** bucket; only the owner and admins can read them.
- An **admin** sees the application queue + documents and can **approve** (→ approved + verified, provider notified, now bookable) or **reject** (→ reason, provider notified, can resubmit). A non-admin calling `review_provider_application` is rejected.
- A `pending`/`rejected` provider is **not** listed and **not** bookable via a direct link.
- Customer signup/booking is **unchanged** (no added friction).
- `npm run typecheck` and `npm run build` pass.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read /docs/Seva-Architecture.md (§7.1) and CLAUDE.md first.
We are on Playbook Step 9: provider onboarding + verification (KYC). Step 8 is committed.

UX bar for this step — build it SIMPLE and EFFICIENT, like a good real-world service platform:
- Customers must feel ZERO change (provider-side only). Do not add any step, field, or
  verification to customer signup or the booking flow.
- The provider application is ONE short form: category, business name, service city/area, hourly
  rate, short bio, and 1-2 ID documents. NO portfolio, references, or long questionnaires. A
  provider should finish in a few minutes on a phone.
- Let providers save/resubmit without losing input (the RPC upserts one row per user).
- Status must be HONEST and legible: "Submitted - reviewed within 24-48h" for pending; on reject,
  show the exact reason + one-tap resubmit; on approve, "You're live."
- Admin console stays plain and functional - a queue + approve/reject. Don't over-design it.
- Keep the pending->approve GATE (that's safety, not friction) but make everything around it feel
  effortless. Prefer fewer fields and clearer copy over more options. If in doubt, cut it.

Read these first, then propose a short plan and WAIT for my OK before editing:
- CLAUDE.md and /docs/Seva-Step-9.md (this spec - the source of truth)
- app/become-provider/page.tsx (the fake handleSubmit - it never inserts a provider row)
- supabase/migrations/20260710120000_seva_security_hardening.sql (Step-1 provider column grants -
  INSERT was NOT restricted, so a client can currently self-set status/is_verified on insert)
- supabase/migrations/20260728120000_seva_disputes.sql (is_admin() helper + admin console pattern)
- app/providers/page.tsx (status='approved' filter), app/admin/* (existing admin console), lib/supabase.ts

Build:
1. Migration supabase/migrations/20260731120000_seva_provider_onboarding.sql EXACTLY as in
   /docs/Seva-Step-9.md: REVOKE INSERT + column-grant safe columns on service_providers; the
   enforce_provider_birth_state BEFORE INSERT trigger; kyc_status/kyc_documents/rejection_reason/
   applied_at/reviewed_by/reviewed_at columns; uniq_provider_per_user; submit_provider_application
   and review_provider_application (admin-only) RPCs; and the request_ekyc stub.
2. app/become-provider/page.tsx: collapse to the short essential form above; replace the fake
   setTimeout submit with supabase.rpc('submit_provider_application', ...); real KYC document
   upload to a PRIVATE Supabase Storage bucket 'kyc-docs' (owner+admin read only); an honest
   pending/rejected/approved status screen driven by the row; prefill + resubmit if a row exists.
3. Admin: app/admin/providers/page.tsx (submitted-application queue) and
   app/admin/providers/[id]/page.tsx (details + KYC docs via signed URLs + Approve/Reject(reason)
   -> review_provider_application). Admin-only, non-admins redirected. Keep it plain.
4. Verify the booking path only allows status='approved' providers (block booking a pending
   provider via direct link if not already blocked).
5. Types in lib/supabase.ts for the new provider fields.

Do NOT (later steps):
- Add ANY customer KYC (asymmetric by design - phone OTP is enough for customers).
- Build a REAL Aadhaar/background-check integration - request_ekyc stays a stub.
- Touch reputation math, escrow, disputes resolution, or the star rating.

Done when:
- /become-provider creates a real provider row, ALWAYS born pending + unverified + kyc submitted,
  no matter what the client sends; a direct insert of status='approved'/is_verified=true is
  stripped/rejected.
- KYC docs are in a private bucket; only owner + admins can read.
- Admin can approve (-> approved+verified, notified, bookable) or reject (-> reason, notified,
  resubmit); a non-admin calling review_provider_application is rejected.
- A pending/rejected provider is not listed and not bookable via direct link.
- Customer signup/booking is unchanged.
- npm run typecheck and npm run build pass.

I'll apply the migration, create the storage bucket, and ensure an admin account exists. After I
confirm, add scripts/verify-step9.mjs asserting: application creates a pending/unverified row;
a client CANNOT create an approved/verified provider (direct insert stripped/rejected);
review_provider_application is admin-only and flips status correctly; non-admin rejected; KYC-doc
storage RLS (owner/admin only).

Finish by reporting exactly what you changed and how you verified each "Done when" item -
especially the closed self-verification hole.
```
