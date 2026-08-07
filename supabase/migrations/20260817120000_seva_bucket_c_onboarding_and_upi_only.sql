/* Seva — Bucket C: onboarding UX + customer-payment simplification.
   Companion to /docs/Seva-Decisions-Log.md items 10, 14, 16, 18, 20. Run AFTER
   20260816120000_seva_list_price_is_a_job_total.sql.

   🔴 READ THIS BEFORE CHANGING ANYTHING BELOW.
   Item 18 removes the Seva Wallet as a CUSTOMER PAYMENT METHOD. It does NOT remove the wallet.
   The wallet is the PROVIDER PAYOUT LEDGER: release_escrow_on_confirm credits it on customer
   confirm, and resolve_dispute claws back from it on a favor_customer outcome. Deleting or
   disabling it breaks settlement. Nothing in this migration touches credit_wallet, debit_wallet,
   wallet_transactions, profiles.wallet_balance, release_escrow_on_confirm or resolve_dispute.

   Four changes:
     1) (18) customer payment = UPI only    — default flipped + an INSERT-only guard
     2) (16) sensible Indian IDs            — relabel photo_id; passport is no longer the copy
     3) (10) multiple documents, LABELED    — a bounded, optional second ID slot
     4) (14) live selfie                    — a new capture_method the form keys on
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) (18) THE CUSTOMER PAYS BY UPI. The wallet stays exactly where it is — on the PROVIDER side.
--
-- 'wallet' was never a working customer path: release_escrow_on_confirm settles a booking when
-- payment_status='held' (money captured into escrow by the Razorpay webhook) or when
-- payment_method='cod'. A 'wallet' booking matched neither, so it could reach 'confirmed' and
-- then never pay anyone. Worse, it was the COLUMN DEFAULT — an insert that omitted the method
-- silently created one of these dead bookings.
ALTER TABLE bookings ALTER COLUMN payment_method SET DEFAULT 'upi';

-- Defense in depth behind the UI change (the booking form no longer offers it), and modelled
-- exactly on 20260721120000's COD guard:
--   • INSERT-only on purpose. An INSERT-OR-UPDATE guard would reject every UPDATE against a
--     legacy wallet row — including transition_booking's status write — breaking bookings that
--     already exist. This blocks the CREATION of a new wallet booking; existing rows are untouched.
--   • 'wallet' deliberately stays legal in the payment_method CHECK, for the same reason.
CREATE OR REPLACE FUNCTION public.reject_wallet_as_customer_payment()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.payment_method = 'wallet' THEN
    RAISE EXCEPTION 'the Seva wallet is the provider payout ledger, not a customer payment method — use upi'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_reject_wallet_booking ON bookings;
CREATE TRIGGER trg_reject_wallet_booking BEFORE INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION public.reject_wallet_as_customer_payment();

COMMENT ON COLUMN bookings.payment_method IS
  'upi = online, into escrow (the only method offered to customers). cod = legacy cash, blocked '
  'for new bookings since 20260721120000. wallet = legacy only — the wallet is the PROVIDER '
  'payout ledger, never a customer payment method.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) (16) IDS INDIANS ACTUALLY HOLD.
-- The code stays 'photo_id': every category_kyc_requirements row and every provider_documents
-- row already points at it, and renaming a key to improve a label would be a migration that
-- breaks data for cosmetics. Only the human-facing copy changes.
--
-- Aadhaar / Voter ID (EPIC) / driving licence are the primary options — all carry a photo, and
-- between them cover essentially every adult in India. PAN is deliberately NOT here: it carries
-- no address and is weak alone, so it belongs in the secondary slot below. Passport is neither
-- default nor required — it is the last option in the picker, for the minority who hold one.
UPDATE kyc_document_types SET
  label       = 'Primary photo ID',
  description = 'Aadhaar, Voter ID (EPIC) or driving licence — a government ID that carries your photo.'
WHERE code = 'photo_id';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) (14) THE SELFIE IS CAPTURED LIVE, NOT UPLOADED.
-- A file upload proves someone owns a photo. A capture proves someone was in front of a camera
-- when they applied. That is the meaningful step now; blink/turn-head liveness is a later vendor
-- feature and deliberately NOT built here.
--
-- capture_method gains 'live_capture' so the FORM can key on data rather than on a hardcoded
-- doc_code — the same reason requirements live in a table at all.
ALTER TABLE kyc_document_types DROP CONSTRAINT IF EXISTS kyc_document_types_capture_method_check;
ALTER TABLE kyc_document_types ADD CONSTRAINT kyc_document_types_capture_method_check
  CHECK (capture_method IN ('digilocker','api_number','upload','vendor','live_capture'));

UPDATE kyc_document_types SET
  label          = 'Live selfie',
  capture_method = 'live_capture',
  description    = 'Taken with your camera as you apply — we don''t accept an uploaded photo. Later identity checks match against THIS, not against your ID.'
WHERE code = 'selfie';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) (10) MORE THAN ONE DOCUMENT — but LABELED and BOUNDED.
-- Not "attach as many files as you like": an unlabelled pile is worse for the reviewer than one
-- document, because nothing says what any of it is. One optional, named second slot instead, and
-- the form records WHICH id was supplied (meta.id_type) so the admin screen can say
-- "Primary photo ID · Aadhaar" rather than "document.jpg".
INSERT INTO kyc_document_types (code, label, description, capture_method, carries_expiry, retention_days)
VALUES ('id_secondary', 'Secondary ID',
        'Optional. PAN, or a second photo ID — a second document makes your identity easier to confirm.',
        'upload', false, 1095)
ON CONFLICT (code) DO NOTHING;

-- 'optional' (not 'badge'): it never blocks approval AND it must not unlock a capability tier.
INSERT INTO category_kyc_requirements (category_id, doc_code, requirement, note)
SELECT c.id, 'id_secondary', 'optional', 'Optional — speeds up review, never blocks approval.'
FROM service_categories c
ON CONFLICT DO NOTHING;

-- New categories inherit it too. Faithful copy of 20260802120000's trigger + the new slot.
CREATE OR REPLACE FUNCTION public.seed_base_kyc_for_category()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO category_kyc_requirements (category_id, doc_code, requirement)
  VALUES (NEW.id,'photo_id','required'), (NEW.id,'selfie','required'),
         (NEW.id,'pan','payout'), (NEW.id,'id_secondary','optional')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;

-- 🔴 A SECOND ID PHOTO IS NOT A CREDENTIAL. recompute_trust_tier promotes to tier 2 on ANY
-- verified document outside its exclusion list — so without this line, uploading a PAN copy as a
-- secondary ID would silently buy the "credential-verified" tier that a trade certificate or a
-- verified work history is supposed to mean. Faithful copy of 20260802120000's function; the
-- ONLY change is 'id_secondary' joining the excluded set.
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
                   AND doc_code NOT IN ('photo_id','selfie','pan','id_secondary','police_verification')
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
