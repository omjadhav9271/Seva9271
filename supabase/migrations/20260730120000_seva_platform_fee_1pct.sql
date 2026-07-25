/* Seva — set the platform fee to 1% (was 15%).

   The fee was a local `constant numeric := 0.15` duplicated inside TWO live SECURITY DEFINER
   functions (release_escrow_on_confirm, resolve_dispute). Those migrations are already applied and
   must not be edited, so this migration re-declares both — and, to stop the value fragmenting
   again, both now read a single source of truth: platform_fee_pct(). A future fee change is then a
   one-line REPLACE of that function. (The admin resolve panel keeps its own mirror constant for the
   live preview — the DB remains authoritative.) Existing settled/resolved bookings are unaffected;
   this changes going-forward payouts only. */

-- 0) Single source of truth for the platform fee.
CREATE OR REPLACE FUNCTION public.platform_fee_pct()
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT 0.01::numeric $$;

-- 1) release_escrow_on_confirm — faithful copy of the 20260720120000 version (with the two money
--    notifications); ONLY change: v_fee_pct now reads platform_fee_pct().
CREATE OR REPLACE FUNCTION public.release_escrow_on_confirm()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b bookings; v_provider_user uuid; v_amount numeric; v_fee numeric; v_payout numeric;
  v_fee_pct constant numeric := public.platform_fee_pct();
BEGIN
  SELECT * INTO b FROM bookings WHERE id = NEW.booking_id FOR UPDATE;
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  v_amount := COALESCE(b.price_charged, b.price_agreed, b.total_amount);

  IF b.payment_status = 'held' THEN
    v_fee    := round(v_amount * v_fee_pct, 2);
    v_payout := v_amount - v_fee;
    PERFORM public.credit_wallet(v_provider_user, v_payout, 'credit',
              'Payout for booking ' || b.id::text, b.id);
    UPDATE payment_transactions SET status='released', provider_amount=v_payout,
              platform_fee=v_fee, updated_at=NOW()
      WHERE booking_id = b.id AND status = 'captured';
    UPDATE bookings SET payment_status='released', status='paid', updated_at=NOW() WHERE id=b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
      VALUES (b.id, 'confirmed', 'paid', NULL, 'system',
              jsonb_build_object('payout', v_payout, 'fee', v_fee));

    IF v_provider_user IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, type, link)
      VALUES (v_provider_user, 'Payout received',
              '₹' || trim_scale(v_payout) || ' added to your wallet', 'success',
              '/bookings/' || b.id);
    END IF;
    IF b.customer_id IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, type, link)
      VALUES (b.customer_id, 'Payment complete',
              'Payment of ₹' || trim_scale(v_amount) || ' complete. Thank you!', 'success',
              '/bookings/' || b.id);
    END IF;
  ELSIF b.payment_method = 'cod' THEN
    UPDATE bookings SET status='paid', updated_at=NOW() WHERE id=b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
      VALUES (b.id, 'confirmed', 'paid', NULL, 'system', jsonb_build_object('cash', true));
  END IF;
  RETURN NEW;
END; $$;

-- 2) resolve_dispute — faithful copy of the 20260728120000 version; ONLY change: c_fee_pct now
--    reads platform_fee_pct(). (CREATE OR REPLACE preserves the existing grants; re-issued below
--    to be explicit, matching the original.)
CREATE OR REPLACE FUNCTION public.resolve_dispute(
  p_dispute_id uuid, p_outcome text, p_fault text, p_notes text DEFAULT NULL,
  p_refund_amount numeric DEFAULT NULL
) RETURNS disputes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d disputes; b bookings; v_provider_user uuid; v_amount numeric; v_next text;
  v_refund numeric; v_remainder numeric; v_fee numeric; v_payout numeric;
  c_fee_pct constant numeric := public.platform_fee_pct();
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  IF p_outcome NOT IN ('favor_customer','favor_provider','partial','no_fault') THEN
    RAISE EXCEPTION 'invalid outcome %', p_outcome;
  END IF;
  IF p_fault NOT IN ('customer','provider','none') THEN
    RAISE EXCEPTION 'invalid fault party %', p_fault;
  END IF;

  SELECT * INTO d FROM disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispute not found'; END IF;
  IF d.status = 'resolved' THEN RAISE EXCEPTION 'already resolved'; END IF;

  SELECT * INTO b FROM bookings WHERE id = d.booking_id FOR UPDATE;
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  v_amount := COALESCE(b.price_charged, b.price_agreed, b.total_amount);

  v_refund := CASE WHEN p_outcome = 'favor_customer' THEN COALESCE(p_refund_amount, v_amount)
                   WHEN p_outcome = 'partial'        THEN p_refund_amount
                   ELSE 0 END;
  IF p_outcome = 'partial' AND (v_refund IS NULL OR v_refund <= 0 OR v_refund >= v_amount) THEN
    RAISE EXCEPTION 'partial resolution needs a refund amount strictly between 0 and %', v_amount;
  END IF;

  IF b.payment_status = 'released' THEN
    IF v_refund > 0 THEN
      PERFORM public.credit_wallet(v_provider_user, v_refund, 'debit',
              'Dispute clawback for booking ' || b.id::text, b.id);
    END IF;
  ELSIF b.payment_status = 'held' THEN
    v_remainder := v_amount - COALESCE(v_refund, 0);
    IF v_remainder > 0 THEN
      v_fee    := round(v_remainder * c_fee_pct, 2);
      v_payout := v_remainder - v_fee;
      PERFORM public.credit_wallet(v_provider_user, v_payout, 'credit',
              'Dispute payout for booking ' || b.id::text, b.id);
      UPDATE payment_transactions SET status='released', provider_amount=v_payout,
             platform_fee=v_fee, updated_at=NOW()
        WHERE booking_id = b.id AND status='captured';
    END IF;
  END IF;

  v_next := CASE WHEN p_outcome = 'favor_customer' THEN 'cancelled' ELSE 'paid' END;
  UPDATE bookings SET
    status = v_next,
    payment_status = CASE WHEN b.payment_status IN ('held','released')
                          THEN CASE WHEN p_outcome IN ('favor_customer','partial') THEN 'refunded'
                                    ELSE 'released' END
                          ELSE b.payment_status END,
    updated_at = NOW()
  WHERE id = b.id;

  UPDATE disputes SET status='resolved', outcome=p_outcome, fault_party=p_fault,
    refund_amount=v_refund, resolution_notes=p_notes,
    resolved_by=auth.uid(), resolved_at=NOW()
  WHERE id = p_dispute_id RETURNING * INTO d;

  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (b.id, 'disputed', v_next, auth.uid(), 'admin',
          jsonb_build_object('dispute_id', d.id, 'outcome', p_outcome, 'fault', p_fault));

  INSERT INTO notifications (user_id, title, message, type, link) VALUES
    (b.customer_id, 'Dispute resolved', 'Your dispute has been reviewed and resolved.', 'info',
     '/bookings/' || b.id),
    (v_provider_user, 'Dispute resolved', 'A dispute on your booking has been resolved.', 'info',
     '/bookings/' || b.id);

  PERFORM public.compute_reputation('provider', b.provider_id);
  PERFORM public.compute_reputation('customer', b.customer_id);
  RETURN d;
END; $$;
REVOKE EXECUTE ON FUNCTION public.resolve_dispute(uuid,text,text,text,numeric) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_dispute(uuid,text,text,text,numeric) TO authenticated; -- guarded by is_admin() inside
