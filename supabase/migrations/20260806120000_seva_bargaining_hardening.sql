/* Seva — Step 10 hardening. Run AFTER 20260805120000_seva_bargaining_fixes.sql.

   Four findings from verifying Step 10 against the live DB.

   🔴 HARD-1  THE ANTI-PROBE CAP WAS FREE TO RESET. "delete_own_booking" — still standing from the
              initial schema — let a customer DELETE their own bookings. The 3-per-day cap in
              start_negotiation counts bookings in ('negotiating','expired'), so deleting them
              cleared it, and `offers` cascade away with the booking. Verified live: three
              below-floor probes, one DELETE, cap back to zero and no trace left. That makes
              binary-searching floor_price free — the exact defence decision 2 of
              /docs/Seva-Step-10.md rests on ("each probe costs a whole new booking").

              The same policy cascaded to reviews, booking_events, payment_transactions, disputes
              and dispute_evidence, so a customer could also scrub a cancellation out of their own
              reputation (invariant #1), erase a settled escrow record (#5), or delete a live
              dispute. Step 1's hardening (20260710120000) dropped the identical
              delete_own_transaction on wallet_transactions for exactly this reason — bookings was
              missed. Nothing in the app deletes a booking, so nothing legitimate breaks.

   HARD-2  A negotiation emitted BOTH its own notification and the generic status one, so an offer
           landed on the provider as three separate alerts ("New booking request", "Booking status
           is now negotiating", "New offer"), and a below-floor decline reached the customer as
           the careful uniform copy PLUS 'Booking status is now "expired"'. Step 10's RPCs address
           their own notifications with recipient-correct copy, so the generic path now steps
           aside for the negotiation statuses — the same precedent as the 'paid' skip in
           20260720120000. Every negotiation ending is given an explicit notification below so
           nothing goes silent.

   HARD-3  Every negotiation also fired trg_notify_new_booking, telling the provider "You have a
           new booking request. Open Bookings to accept." There is no request to accept — the
           booking is in 'negotiating' and the real alert is the "New offer" one. Suppressed.

   HARD-4  expire_stale_offers closed the offer and the booking but wrote NO booking_event and
           notified nobody, so a lapsed negotiation was silent to both parties and left a hole in
           the audit log the Step-8 evidence bundle reads (invariant #4: transitions emit events
           and notifications). It now does both. */

-- ─────────────────────────────────────────────────────────────────────────────
-- HARD-1 🔴 A booking is a financial and reputational record. It is never client-deletable.
DROP POLICY IF EXISTS "delete_own_booking" ON bookings;
REVOKE DELETE ON bookings FROM authenticated, anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- HARD-3 A booking born under negotiation is not a booking request.
CREATE OR REPLACE FUNCTION public.notify_on_new_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider_user uuid;
BEGIN
  -- Step 10: start_negotiation sends the provider a "New offer" notification with the amount.
  -- Telling them they have a request to "accept" is both duplicate and wrong.
  IF NEW.status = 'negotiating' THEN RETURN NEW; END IF;

  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = NEW.provider_id;
  IF v_provider_user IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (v_provider_user, 'New booking request',
            'You have a new booking request. Open Bookings to accept.', 'info');
  END IF;
  RETURN NEW;
END; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- HARD-2 The generic status notifier steps aside for the negotiation phase.
--        Byte-identical to 20260720120000 except the added early return.
--        ('expired' on bookings is written ONLY by the Step-10 functions, so this narrows nothing
--         else. Each of those paths carries its own explicit notification, below.)
CREATE OR REPLACE FUNCTION public.notify_on_booking_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer uuid; v_provider_user uuid; v_recipient uuid;
  v_title text; v_type text;
BEGIN
  -- Money settlement ('paid') is notified with explicit recipients by release_escrow_on_confirm.
  IF NEW.to_status = 'paid' THEN
    RETURN NEW;
  END IF;
  -- Step 10: the bargaining RPCs notify explicitly, with copy that is careful never to leak how
  -- far a declined offer was from the provider's floor. A generic 'status is now "expired"' both
  -- duplicates that and undoes the care taken over it.
  IF NEW.to_status IN ('negotiating', 'expired') THEN
    RETURN NEW;
  END IF;

  SELECT b.customer_id, sp.user_id INTO v_customer, v_provider_user
  FROM bookings b JOIN service_providers sp ON sp.id = b.provider_id
  WHERE b.id = NEW.booking_id;

  IF    NEW.actor_role = 'customer' THEN v_recipient := v_provider_user;
  ELSIF NEW.actor_role = 'provider' THEN v_recipient := v_customer;
  ELSE  v_recipient := v_customer;   -- system/admin: default to the customer
  END IF;

  v_title := CASE NEW.to_status
    WHEN 'accepted'    THEN 'Booking accepted'
    WHEN 'en_route'    THEN 'Provider is on the way'
    WHEN 'arrived'     THEN 'Provider has arrived'
    WHEN 'in_progress' THEN 'Work has started'
    WHEN 'completed'   THEN 'Job marked complete'
    WHEN 'confirmed'   THEN 'Job confirmed'
    WHEN 'cancelled'   THEN 'Booking cancelled'
    WHEN 'disputed'    THEN 'A dispute was raised'
    ELSE 'Booking updated'
  END;
  v_type := CASE NEW.to_status
    WHEN 'accepted' THEN 'success' WHEN 'confirmed' THEN 'success'
    WHEN 'cancelled' THEN 'warning' WHEN 'disputed' THEN 'error'
    ELSE 'info'
  END;

  IF v_recipient IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, type, link)
    VALUES (v_recipient, v_title, 'Booking status is now "' || NEW.to_status || '".', v_type,
            '/bookings/' || NEW.booking_id);
  END IF;
  RETURN NEW;
END; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- HARD-2 (cont.) respond_offer: every ending now notifies explicitly.
--        Identical to the 20260805120000 version except the two added notifications.
CREATE OR REPLACE FUNCTION public.respond_offer(
  p_booking_id uuid, p_action text, p_amount numeric DEFAULT NULL
) RETURNS offers LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b bookings; sp service_providers; o offers; v_role text; v_next offers;
BEGIN
  IF p_action NOT IN ('accept','counter','decline') THEN RAISE EXCEPTION 'invalid action'; END IF;
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.status <> 'negotiating' THEN
    RAISE EXCEPTION 'this booking is not under negotiation';
  END IF;
  SELECT * INTO sp FROM service_providers WHERE id = b.provider_id;

  IF    auth.uid() = b.customer_id THEN v_role := 'customer';
  ELSIF auth.uid() = sp.user_id    THEN v_role := 'provider';
  ELSE  RAISE EXCEPTION 'not a party to this booking'; END IF;

  SELECT * INTO o FROM offers WHERE booking_id = p_booking_id AND status = 'pending'
   ORDER BY round DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'no open offer'; END IF;
  IF o.actor_role = v_role THEN RAISE EXCEPTION 'waiting on the other party'; END IF;
  IF o.expires_at <= now() THEN RAISE EXCEPTION 'that offer has expired'; END IF;

  IF p_action = 'accept' THEN
    PERFORM public.accept_offer_internal(o.id, v_role);
    SELECT * INTO o FROM offers WHERE id = o.id;
    RETURN o;
  END IF;

  IF p_action = 'decline' THEN
    UPDATE offers SET status='declined', responded_at=now() WHERE id = o.id;
    UPDATE bookings SET status='expired', updated_at=now() WHERE id = b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
    VALUES (b.id, 'negotiating', 'expired', auth.uid(), v_role, '{"reason":"declined"}'::jsonb);
    -- A provider's decline must read EXACTLY like the automatic below-floor decline. If the two
    -- differed, a customer would learn which side of the floor their number fell on.
    IF v_role = 'provider' THEN
      INSERT INTO notifications (user_id, title, message, type, link) VALUES (
        b.customer_id, 'Offer not accepted',
        'Your offer wasn''t accepted. You can book at the listed price any time.',
        'info', '/providers/' || b.provider_id);
    ELSE
      INSERT INTO notifications (user_id, title, message, type, link) VALUES (
        sp.user_id, 'Offer withdrawn',
        'The customer ended the negotiation.', 'info', '/bookings/' || b.id);
    END IF;
    SELECT * INTO o FROM offers WHERE id = o.id;
    RETURN o;
  END IF;

  -- counter --------------------------------------------------------------------
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'counter needs an amount'; END IF;

  -- Exhausting the counters stops the BRANCHING, not the deal. Raise BEFORE writing anything, so
  -- nothing is rolled back; the standing offer stays open to accept or decline.
  IF o.round >= COALESCE(sp.max_counter_rounds, 3) THEN
    RAISE EXCEPTION 'no counters left — accept or decline this offer';
  END IF;

  -- a CUSTOMER counter below the hidden floor ends it, on the same uniform terms as round 1
  IF v_role = 'customer' AND sp.floor_price IS NOT NULL AND p_amount < sp.floor_price THEN
    UPDATE offers SET status='declined', responded_at=now() WHERE id = o.id;
    UPDATE bookings SET status='expired', updated_at=now() WHERE id = b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
    VALUES (b.id, 'negotiating', 'expired', NULL, 'system', '{"reason":"declined"}'::jsonb);
    INSERT INTO notifications (user_id, title, message, type, link) VALUES (
      b.customer_id, 'Offer not accepted',
      'Your offer wasn''t accepted. You can book at the listed price any time.',
      'info', '/providers/' || b.provider_id);
    SELECT * INTO o FROM offers WHERE id = o.id;
    RETURN o;
  END IF;

  UPDATE offers SET status='countered', responded_at=now() WHERE id = o.id;
  INSERT INTO offers (booking_id, round, made_by, actor_role, amount, expires_at)
  VALUES (b.id, o.round + 1, auth.uid(), v_role, p_amount, now() + interval '24 hours')
  RETURNING * INTO v_next;

  INSERT INTO notifications (user_id, title, message, type, link) VALUES (
    CASE WHEN v_role = 'customer' THEN sp.user_id ELSE b.customer_id END,
    'Counter offer',
    '₹' || trim_scale(p_amount) || ' — accept, counter or decline within 24 hours.',
    'info', '/bookings/' || b.id);
  RETURN v_next;
END; $$;
GRANT EXECUTE ON FUNCTION public.respond_offer(uuid,text,numeric) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- HARD-4 The sweep leaves an audit trail and tells both parties.
CREATE OR REPLACE FUNCTION public.expire_stale_offers()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; r RECORD; v_provider_user uuid;
BEGIN
  FOR r IN UPDATE offers SET status='expired', responded_at=now()
           WHERE status='pending' AND expires_at <= now() RETURNING booking_id
  LOOP
    -- Only the first sweep of a given booking should log and notify; a booking already closed by
    -- a decline or an earlier sweep must not fire again.
    UPDATE bookings SET status='expired', updated_at=now()
     WHERE id = r.booking_id AND status='negotiating';
    IF FOUND THEN
      INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
      VALUES (r.booking_id, 'negotiating', 'expired', NULL, 'system',
              '{"reason":"offer_expired"}'::jsonb);

      SELECT sp.user_id INTO v_provider_user
        FROM bookings b JOIN service_providers sp ON sp.id = b.provider_id
       WHERE b.id = r.booking_id;

      INSERT INTO notifications (user_id, title, message, type, link)
      SELECT b.customer_id, 'Offer expired',
             'Nobody replied in time, so the offer lapsed. You can book at the listed price any time.',
             'info', '/bookings/' || b.id
        FROM bookings b WHERE b.id = r.booking_id AND b.customer_id IS NOT NULL;

      IF v_provider_user IS NOT NULL THEN
        INSERT INTO notifications (user_id, title, message, type, link)
        VALUES (v_provider_user, 'Offer expired',
                'An offer lapsed before it was answered.', 'info', '/bookings/' || r.booking_id);
      END IF;
    END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END; $$;
REVOKE EXECUTE ON FUNCTION public.expire_stale_offers() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_offers() TO service_role;
