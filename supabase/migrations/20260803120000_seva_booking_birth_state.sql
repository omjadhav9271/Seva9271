/* Seva — close the booking birth-state hole. Run AFTER 20260802120000_seva_category_kyc.sql.

   🔴 THE HOLE (found while grounding the Step-10 design in the real schema):

   Step 2 locked down booking mutation — `REVOKE UPDATE ON bookings FROM authenticated` — and a
   client genuinely cannot change a booking after the fact. But INSERT was never restricted, so a
   customer could simply CREATE a booking already in whatever state they wanted. Verified against
   the live database:

     payment_status:'held'            → ALLOWED   ← the expensive one
     status:'paid'                    → ALLOWED
     status:'accepted'                → ALLOWED
     price_charged: 1                 → ALLOWED

   The costly case is `payment_status='held'` with no payment. The Step-5 escrow gate in
   transition_booking asks only whether payment_status = 'held' before letting a provider start
   work, so a forged booking sails through it: the provider is told the money is secured, does
   the job, the customer confirms, and release_escrow_on_confirm credits the provider's wallet
   from an escrow that never existed. The PLATFORM funds it, silently, with no webhook and no
   payment_transactions row to reconcile against.

   This breaks invariant #4 (status changes go through ONE transition function — not if a row can
   be BORN at any status) and invariant #5 (money moves only via escrow — not if 'held' is
   client-assertable).

   Same shape as the Step-9 self-verification hole, and the same fix: restrict INSERT to the
   columns a customer legitimately supplies, and force a safe birth state for untrusted roles. */

-- 1) A customer may describe the JOB. They may not describe its STATE or its money.
REVOKE INSERT ON bookings FROM authenticated;
GRANT  INSERT (customer_id, provider_id, category_id, service_type,
               scheduled_date, scheduled_time, duration_hours,
               hourly_rate, total_amount, payment_method, notes, address)
       ON bookings TO authenticated;
-- status / payment_status / price_agreed / price_charged are NOT grantable → they take their
-- DEFAULTs ('requested' / 'pending' / trigger-computed / NULL). A client cannot send them at all.
-- price_agreed stays trigger-set: BEFORE INSERT triggers write NEW.* regardless of the caller's
-- column privileges, so trg_set_price_agreed keeps working untouched.

-- 2) Belt-and-braces, exactly like enforce_provider_birth_state: force the safe birth state for
--    untrusted roles even if a default drifts or a column grant is widened by accident.
--    Deliberately role-aware: the service role and SECURITY DEFINER functions (which run as the
--    owner) must still be able to stage any state — the verify scripts and every escrow/dispute
--    path depend on that.
CREATE OR REPLACE FUNCTION public.enforce_booking_birth_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.status         := 'requested';
    NEW.payment_status := 'pending';
    NEW.price_charged  := NULL;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_booking_birth ON bookings;
CREATE TRIGGER trg_booking_birth BEFORE INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION public.enforce_booking_birth_state();

-- 3) NOTE for Step 10 (structured bargaining), which is what surfaced this:
--    `total_amount` and `hourly_rate` remain client-supplied, so a customer can still propose a
--    ₹1 job. That is a WEAKER problem — the provider sees the amount before accepting, so it is
--    visible fraud rather than silent platform loss — but the agreed price must become
--    SERVER-AUTHORITATIVE when bargaining lands: derived from the provider's list price, or from
--    an accepted offer, never asserted by the browser.
