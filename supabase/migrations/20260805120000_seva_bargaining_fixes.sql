/* Seva — Step 10 fixes, found by scripts/verify-step10.mjs on first run.
   Run AFTER 20260804120000_seva_bargaining.sql.

   FIX-1  accept_offer_internal wrote booking_events.actor_role = 'auto' on the auto-accept path,
          but that column is CHECK-constrained to ('customer','provider','system','admin'), so
          every above-threshold offer failed with a constraint violation. An automatic decision
          is the SYSTEM acting — coerced accordingly, and defensively for any future caller.

   FIX-2  the round cap closed the negotiation and THEN raised — which rolls back the very
          updates that closed it, leaving the booking stuck in 'negotiating'. Reworked to the
          better rule anyway: exhausting the counters does not kill the deal, it just stops the
          branching. The standing offer can still be ACCEPTED or DECLINED, and the expiry sweep
          closes it if nobody acts. Nothing is written before the raise, so nothing rolls back. */

-- FIX-1 -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_offer_internal(p_offer_id uuid, p_by text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o offers; b bookings; v_provider_user uuid; v_actor text;
BEGIN
  -- booking_events.actor_role is CHECK-constrained; an automatic decision is the system acting.
  v_actor := CASE WHEN p_by IN ('customer','provider','admin') THEN p_by ELSE 'system' END;

  SELECT * INTO o FROM offers WHERE id = p_offer_id FOR UPDATE;
  SELECT * INTO b FROM bookings WHERE id = o.booking_id FOR UPDATE;
  SELECT user_id INTO v_provider_user FROM service_providers WHERE id = b.provider_id;

  UPDATE offers SET status='accepted', responded_at=now() WHERE id = o.id;
  -- THE PRICE LOCKS HERE, server-side, never client-asserted.
  UPDATE bookings SET status='accepted', price_agreed=o.amount, total_amount=o.amount,
                      updated_at=now()
   WHERE id = b.id;
  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (b.id, 'negotiating', 'accepted', auth.uid(), v_actor,
          jsonb_build_object('agreed', o.amount, 'round', o.round, 'via', p_by));
  INSERT INTO notifications (user_id, title, message, type, link) VALUES
    (b.customer_id, 'Offer accepted',
     '₹' || trim_scale(o.amount) || ' agreed. Pay to confirm your booking.', 'success',
     '/bookings/' || b.id),
    (v_provider_user, 'Offer accepted',
     '₹' || trim_scale(o.amount) || ' agreed for your job.', 'success', '/bookings/' || b.id);
END; $$;
REVOKE EXECUTE ON FUNCTION public.accept_offer_internal(uuid,text) FROM public, anon, authenticated;

-- FIX-2 -----------------------------------------------------------------------
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
    SELECT * INTO o FROM offers WHERE id = o.id;
    RETURN o;
  END IF;

  -- counter --------------------------------------------------------------------
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'counter needs an amount'; END IF;

  -- FIX-2: exhausting the counters stops the BRANCHING, not the deal. Raise BEFORE writing
  -- anything, so nothing is rolled back; the standing offer stays open to accept or decline.
  IF o.round >= COALESCE(sp.max_counter_rounds, 3) THEN
    RAISE EXCEPTION 'no counters left — accept or decline this offer';
  END IF;

  -- a CUSTOMER counter below the hidden floor ends it, on the same uniform terms as round 1
  IF v_role = 'customer' AND sp.floor_price IS NOT NULL AND p_amount < sp.floor_price THEN
    UPDATE offers SET status='declined', responded_at=now() WHERE id = o.id;
    UPDATE bookings SET status='expired', updated_at=now() WHERE id = b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
    VALUES (b.id, 'negotiating', 'expired', NULL, 'system', '{"reason":"declined"}'::jsonb);
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
