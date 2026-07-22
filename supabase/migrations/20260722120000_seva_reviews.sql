/* Seva — Step 6: bidirectional, multi-dimensional, gated reviews. Run AFTER Step 5. */

-- 1) Extend the table. Existing rows are all customer→provider, written by the customer.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'customer_to_provider'
  CHECK (direction IN ('customer_to_provider','provider_to_customer'));
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewer_id UUID REFERENCES auth.users(id);
UPDATE reviews SET reviewer_id = customer_id WHERE reviewer_id IS NULL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rating_quality       INT CHECK (rating_quality       BETWEEN 1 AND 5);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rating_punctuality   INT CHECK (rating_punctuality   BETWEEN 1 AND 5);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rating_communication INT CHECK (rating_communication BETWEEN 1 AND 5);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rating_price_fairness INT CHECK (rating_price_fairness BETWEEN 1 AND 5);

-- one review per side per booking (was UNIQUE(booking_id))
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS uniq_review_per_booking;
ALTER TABLE reviews ADD CONSTRAINT uniq_review_per_booking_direction UNIQUE (booking_id, direction);

-- 2) Reviews are RPC-written only + immutable. Drop all client write policies/privileges.
DROP POLICY IF EXISTS "insert_review_for_completed_booking" ON reviews;
DROP POLICY IF EXISTS "insert_own_review" ON reviews;
DROP POLICY IF EXISTS "update_own_review" ON reviews;
DROP POLICY IF EXISTS "delete_own_review" ON reviews;
REVOKE INSERT, UPDATE, DELETE ON reviews FROM authenticated, anon;

-- 3) Reciprocity reveal (computed — no job, no is_visible column):
--    you always see your own; others see a review once the counterpart submits OR 14 days pass.
DROP POLICY IF EXISTS "anyone_can_read_reviews" ON reviews;
CREATE POLICY "read_revealed_reviews" ON reviews FOR SELECT USING (
  reviewer_id = auth.uid()
  OR EXISTS (SELECT 1 FROM reviews r2
             WHERE r2.booking_id = reviews.booking_id AND r2.direction <> reviews.direction)
  OR reviews.created_at < now() - interval '14 days'
);

-- 4) submit_review: the only writer. Validates party + settled + direction, enforces one-per-side
--    (via the unique constraint), and pays the incentive. SECURITY DEFINER so it can credit_wallet.
CREATE OR REPLACE FUNCTION public.submit_review(
  p_booking_id uuid, p_rating int, p_comment text DEFAULT NULL,
  p_quality int DEFAULT NULL, p_punctuality int DEFAULT NULL,
  p_communication int DEFAULT NULL, p_price_fairness int DEFAULT NULL
) RETURNS reviews LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b bookings; v_provider_user uuid; v_direction text; r reviews; v_paid_at timestamptz;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking not found'; END IF;
  IF b.status NOT IN ('paid','reviewed') AND b.payment_status <> 'released' THEN
    RAISE EXCEPTION 'you can only review a completed, paid booking';
  END IF;
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN RAISE EXCEPTION 'overall rating must be 1-5'; END IF;

  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  IF    auth.uid() = b.customer_id   THEN v_direction := 'customer_to_provider';
  ELSIF auth.uid() = v_provider_user THEN v_direction := 'provider_to_customer';
  ELSE  RAISE EXCEPTION 'not a party to this booking'; END IF;

  INSERT INTO reviews (booking_id, customer_id, provider_id, reviewer_id, direction, rating, comment,
                       rating_quality, rating_punctuality, rating_communication, rating_price_fairness)
  VALUES (p_booking_id, b.customer_id, b.provider_id, auth.uid(), v_direction, p_rating, p_comment,
          p_quality, p_punctuality, p_communication, p_price_fairness)
  RETURNING * INTO r;   -- UNIQUE(booking_id,direction) rejects a 2nd review from the same side

  -- incentive: small reward if reviewed within 24h of the booking being paid
  SELECT created_at INTO v_paid_at FROM booking_events
    WHERE booking_id = p_booking_id AND to_status = 'paid' ORDER BY created_at LIMIT 1;
  IF v_paid_at IS NOT NULL AND now() <= v_paid_at + interval '24 hours' THEN
    PERFORM public.credit_wallet(auth.uid(), 10, 'reward', 'Review reward for booking ' || b.id::text, b.id);
  END IF;

  RETURN r;
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_review(uuid,int,text,int,int,int,int) TO authenticated;

-- 5) Keep reputation v1, but make it direction-aware: only customer→provider reviews move the
--    provider's rating. (Step 7 replaces this whole function with Bayesian + time-decay.)
CREATE OR REPLACE FUNCTION public.update_provider_rating()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.direction <> 'customer_to_provider' THEN RETURN NEW; END IF;
  UPDATE service_providers SET
    rating        = COALESCE((SELECT round(avg(rating)::numeric, 2) FROM reviews
                              WHERE provider_id = NEW.provider_id AND direction = 'customer_to_provider'), 0),
    total_reviews = (SELECT count(*) FROM reviews
                              WHERE provider_id = NEW.provider_id AND direction = 'customer_to_provider')
  WHERE id = NEW.provider_id;
  RETURN NEW;
END; $$;
-- (the existing update_provider_rating_trigger on reviews stays bound to this function)
