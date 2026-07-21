/* Seva — Step 5 finalize: disable Cash-on-Delivery for the online-only launch.
   COD has no escrow protection and we can't enforce settlement until reputation + disputes
   exist (Steps 7–8), so a customer must not be able to create a NEW cash booking. This is the
   defense-in-depth layer behind the UI change (the booking form no longer offers 'cod'): a
   BEFORE INSERT trigger rejects any booking inserted with payment_method='cod', whatever the
   client sends.

   Deliberately NOT dropping 'cod' from the payment_method CHECK: legacy cod rows may still
   exist and must keep working — their status transitions and the 'cod' branch in
   release_escrow_on_confirm depend on the value staying legal — and Step 8 will re-enable COD.
   The guard is INSERT-only on purpose: an INSERT-OR-UPDATE guard on payment_method='cod' would
   also reject every UPDATE (e.g. transition_booking's status write) against a legacy cash row,
   breaking existing bookings. This blocks only the creation of a new cod row; existing rows and
   their updates are untouched. */

CREATE OR REPLACE FUNCTION public.reject_new_cod_booking()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.payment_method = 'cod' THEN
    RAISE EXCEPTION 'cash on delivery is disabled for the online-only launch; choose an online payment method'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_reject_new_cod_booking ON public.bookings;
CREATE TRIGGER trg_reject_new_cod_booking
  BEFORE INSERT ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.reject_new_cod_booking();
