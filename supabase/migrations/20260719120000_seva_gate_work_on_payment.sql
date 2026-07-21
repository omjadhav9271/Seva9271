/* Seva — Step 5 fix: gate the start of work on payment.
   A upi/wallet booking could reach 'confirmed' with payment_status still 'pending' — the job
   ran but no money was collected and escrow never engaged. Re-declare transition_booking with
   ONE added guard: an ONLINE booking can't begin work (accepted -> en_route) until its funds
   are 'held'. Cash ('cod') is collected on delivery, so it's exempt. Everything else is a
   faithful copy of the Step 5 (20260718120000) version — the v_allowed table, the price_charged
   write, and the event insert are unchanged. */
CREATE OR REPLACE FUNCTION public.transition_booking(
  p_booking_id uuid, p_next_status text, p_price_charged numeric DEFAULT NULL, p_meta jsonb DEFAULT '{}'::jsonb
) RETURNS bookings LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b bookings; v_from text; v_role text; v_provider_user uuid; v_allowed boolean := false;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking not found'; END IF;
  v_from := b.status;
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  IF    auth.uid() = b.customer_id   THEN v_role := 'customer';
  ELSIF auth.uid() = v_provider_user THEN v_role := 'provider';
  ELSE  RAISE EXCEPTION 'not authorized for this booking'; END IF;

  v_allowed := CASE
    WHEN v_from='requested'   AND p_next_status='accepted'    AND v_role='provider' THEN true
    WHEN v_from='requested'   AND p_next_status='cancelled'                          THEN true
    WHEN v_from='accepted'    AND p_next_status='en_route'    AND v_role='provider' THEN true
    WHEN v_from='accepted'    AND p_next_status='cancelled'                          THEN true
    WHEN v_from='en_route'    AND p_next_status='arrived'     AND v_role='provider' THEN true
    WHEN v_from='en_route'    AND p_next_status='cancelled'                          THEN true
    WHEN v_from='arrived'     AND p_next_status='in_progress' AND v_role='provider' THEN true
    WHEN v_from='arrived'     AND p_next_status='disputed'                           THEN true
    WHEN v_from='in_progress' AND p_next_status='completed'   AND v_role='provider' THEN true
    WHEN v_from='in_progress' AND p_next_status='disputed'                           THEN true
    WHEN v_from='completed'   AND p_next_status='confirmed'   AND v_role='customer' THEN true
    WHEN v_from='completed'   AND p_next_status='disputed'    AND v_role='customer' THEN true
    WHEN v_from='confirmed'   AND p_next_status='disputed'    AND v_role='customer' THEN true
    ELSE false   -- NOTE: confirmed→paid is GONE; release_escrow_on_confirm handles 'paid'.
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'illegal transition % -> % for role %', v_from, p_next_status, v_role;
  END IF;

  -- Escrow gate: an ONLINE booking must have funds held before the provider can begin work.
  -- Cash ('cod') is collected on delivery, so it's exempt. payment_method is nullable, so a
  -- NULL method is treated as online (gated) via IS DISTINCT FROM — never exempt by accident.
  IF v_from = 'accepted' AND p_next_status = 'en_route'
     AND b.payment_method IS DISTINCT FROM 'cod'
     AND b.payment_status IS DISTINCT FROM 'held' THEN
    RAISE EXCEPTION 'payment required before work can start';
  END IF;

  UPDATE bookings SET
    status = p_next_status,
    price_charged = CASE WHEN p_next_status='confirmed'
                         THEN COALESCE(p_price_charged, price_charged, price_agreed, total_amount)
                         ELSE price_charged END,
    updated_at = NOW()
  WHERE id = p_booking_id RETURNING * INTO b;

  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (p_booking_id, v_from, p_next_status, auth.uid(), v_role, COALESCE(p_meta,'{}'::jsonb));
  RETURN b;
END; $$;
