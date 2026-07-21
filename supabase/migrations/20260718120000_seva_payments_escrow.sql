/* Seva — Step 5: payments + escrow. Run AFTER the Step 4 migrations.
   All amounts are INR. Platform fee = 15% (edit v_fee_pct below to change). */

-- 1) Expand the payment_status track. DROP the old CHECK before remapping — the pre-existing
--    constraint only allows ('pending','paid','refunded'), so writing 'released' while it's still
--    in force fails (23514). Order mirrors the state-machine migration's status remap:
--    drop → remap → add. (Spec had the drop after the UPDATE; that ordering can't apply.)
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
UPDATE bookings SET payment_status = 'released' WHERE payment_status = 'paid';
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('pending','held','released','refunded','failed'));

-- 2) The payment ledger. Written ONLY by the server (service role) — never a client.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id          UUID REFERENCES bookings(id) ON DELETE CASCADE NOT NULL,
  razorpay_order_id   TEXT UNIQUE NOT NULL,
  razorpay_payment_id TEXT UNIQUE,
  amount              NUMERIC NOT NULL,
  currency            TEXT DEFAULT 'INR',
  status              TEXT DEFAULT 'created'
                        CHECK (status IN ('created','captured','released','refunded','failed')),
  platform_fee        NUMERIC,
  provider_amount     NUMERIC,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_paytx_booking ON payment_transactions(booking_id);
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_payment_tx" ON payment_transactions;
CREATE POLICY "select_own_payment_tx" ON payment_transactions FOR SELECT TO authenticated
USING (public.is_booking_party(booking_id));
REVOKE INSERT, UPDATE, DELETE ON payment_transactions FROM authenticated, anon;

-- 3) Server-only wallet credit. This is the ONLY writer of wallet_transactions + wallet_balance.
CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_user_id uuid, p_amount numeric, p_type text, p_description text, p_reference_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO wallet_transactions (user_id, type, amount, description, reference_id)
  VALUES (p_user_id, p_type, p_amount, p_description, p_reference_id);
  UPDATE profiles SET wallet_balance = COALESCE(wallet_balance,0)
    + CASE WHEN p_type = 'debit' THEN -p_amount ELSE p_amount END
  WHERE id = p_user_id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.credit_wallet(uuid,numeric,text,text,uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet(uuid,numeric,text,text,uuid) TO service_role;

-- 4) Release escrow when the customer confirms. Fires only on 'confirmed' (WHEN clause avoids
--    recursion from the 'paid' event it inserts). SECURITY DEFINER can call credit_wallet.
CREATE OR REPLACE FUNCTION public.release_escrow_on_confirm()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b bookings; v_provider_user uuid; v_amount numeric; v_fee numeric; v_payout numeric;
  v_fee_pct constant numeric := 0.15;
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
  ELSIF b.payment_method = 'cod' THEN
    UPDATE bookings SET status='paid', updated_at=NOW() WHERE id=b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
      VALUES (b.id, 'confirmed', 'paid', NULL, 'system', jsonb_build_object('cash', true));
  END IF;  -- online-but-unpaid: stays 'confirmed' until a webhook marks it held
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_release_escrow ON booking_events;
CREATE TRIGGER trg_release_escrow AFTER INSERT ON booking_events
FOR EACH ROW WHEN (NEW.to_status = 'confirmed')
EXECUTE FUNCTION public.release_escrow_on_confirm();

-- 5) Remove the client 'paid' stub from transition_booking. 'paid' is now system-only.
--    (Full function re-declared with the confirmed→paid line and payment_status write removed.)
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
