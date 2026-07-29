/* Seva — Step 10: structured bargaining v1. Run AFTER 20260803120000_seva_booking_birth_state.sql.
   Spec: /docs/Seva-Step-10.md · Architecture §5.5

   Bargaining lives here, before matching, because the agreed price has to lock into escrow.
   Everything after acceptance is the existing pipeline, untouched.

   ONE documented deviation from the spec's SQL:
     DEV-A  the spec had a provider's counter at or below the customer's last offer auto-accept.
            Dropped: it is an edge case that moves money without the customer confirming the
            final number, for no real gain. The customer simply accepts, as in every other round.

   The security headline is floor_price. Blocking reads is a column grant; stopping INFERENCE is
   the design — see §4/§6 below. And the rule this codebase has learned twice (Step 9's category
   hole, provider_missing_documents): a SECURITY DEFINER function bypasses column grants, so no
   function here returns a service_providers composite. The offer RPCs return `offers` rows. */

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Pricing lives on the provider. (Not a listings table — a provider today IS one listing;
--    see /docs/Seva-Step-10.md decision 1. Offers key on booking_id, so promoting to listings
--    later will not touch the negotiation logic.)
ALTER TABLE service_providers
  ADD COLUMN IF NOT EXISTS pricing_mode TEXT NOT NULL DEFAULT 'fixed'
    CHECK (pricing_mode IN ('fixed','negotiable')),
  ADD COLUMN IF NOT EXISTS list_price NUMERIC,
  ADD COLUMN IF NOT EXISTS floor_price NUMERIC,
  ADD COLUMN IF NOT EXISTS auto_accept_threshold NUMERIC,
  ADD COLUMN IF NOT EXISTS max_counter_rounds INT NOT NULL DEFAULT 3;

UPDATE service_providers SET list_price = hourly_rate WHERE list_price IS NULL;

ALTER TABLE service_providers DROP CONSTRAINT IF EXISTS sp_pricing_sane;
ALTER TABLE service_providers ADD CONSTRAINT sp_pricing_sane CHECK (
  (floor_price IS NULL OR list_price IS NULL OR floor_price <= list_price)
  AND (auto_accept_threshold IS NULL OR floor_price IS NULL OR auto_accept_threshold >= floor_price)
);

-- 🔴 floor_price is NEVER granted to a client. The rest are public so the offer sheet can show
--    the list price and the customer knows the rules of the game.
GRANT SELECT (pricing_mode, list_price, auto_accept_threshold, max_counter_rounds)
  ON service_providers TO anon, authenticated;
-- The provider may SET their own floor even though they cannot SELECT it from this table —
-- they read their own row through my_provider_profile, exactly as with the kyc columns.
GRANT UPDATE (pricing_mode, list_price, floor_price, auto_accept_threshold, max_counter_rounds)
  ON service_providers TO authenticated;

-- my_provider_profile is `SELECT *`, expanded at creation — recreate so the owner sees the new
-- pricing columns. (Third time this has bitten; see Step 9 ADD-B.)
CREATE OR REPLACE VIEW my_provider_profile WITH (security_barrier) AS
  SELECT * FROM service_providers WHERE user_id = auth.uid();
REVOKE ALL ON my_provider_profile FROM anon, authenticated;
GRANT SELECT ON my_provider_profile TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) The bounded Negotiating phase, in front of Accepted.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'requested','negotiating','accepted','en_route','arrived','in_progress',
  'completed','confirmed','paid','reviewed','cancelled','disputed','expired'
));

-- Nothing is AGREED while it is being negotiated: leave price_agreed NULL so
-- /api/payments/create-order (which reads price_agreed and refuses when null) cannot charge for
-- a booking still under negotiation.
CREATE OR REPLACE FUNCTION public.set_booking_price_agreed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'negotiating' AND NEW.price_agreed IS NULL THEN
    NEW.price_agreed := COALESCE(NULLIF(NEW.total_amount, 0),
                                 NEW.hourly_rate * COALESCE(NEW.duration_hours, 1));
  END IF;
  RETURN NEW;
END; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Offers: a bounded, auditable round sequence. RPC-written only.
CREATE TABLE IF NOT EXISTS offers (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id   UUID REFERENCES bookings(id) ON DELETE CASCADE NOT NULL,
  round        INT NOT NULL,
  made_by      UUID REFERENCES auth.users(id) NOT NULL,
  actor_role   TEXT NOT NULL CHECK (actor_role IN ('customer','provider')),
  amount       NUMERIC NOT NULL CHECK (amount > 0),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','accepted','declined','countered','expired')),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  UNIQUE (booking_id, round)
);
CREATE INDEX IF NOT EXISTS idx_offers_booking ON offers(booking_id, round);
CREATE INDEX IF NOT EXISTS idx_offers_open ON offers(expires_at) WHERE status = 'pending';

ALTER TABLE offers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_offers_parties" ON offers;
CREATE POLICY "read_offers_parties" ON offers FOR SELECT TO authenticated
USING (public.is_booking_party(booking_id) OR public.is_admin());
REVOKE INSERT, UPDATE, DELETE ON offers FROM authenticated, anon;   -- RPC-only

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) start_negotiation — the ONLY entrance to 'negotiating'.
CREATE OR REPLACE FUNCTION public.start_negotiation(
  p_provider_id uuid, p_amount numeric, p_service_type text DEFAULT 'one-time',
  p_scheduled_date date DEFAULT NULL, p_scheduled_time time DEFAULT NULL,
  p_duration_hours numeric DEFAULT 2, p_notes text DEFAULT NULL, p_address text DEFAULT NULL
) RETURNS offers LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sp service_providers; b bookings; o offers; v_recent int; v_expiry timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'must be signed in'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'offer must be positive'; END IF;

  SELECT * INTO sp FROM service_providers WHERE id = p_provider_id;
  IF NOT FOUND OR sp.status <> 'approved' THEN RAISE EXCEPTION 'provider not available'; END IF;
  IF sp.pricing_mode <> 'negotiable' THEN RAISE EXCEPTION 'this provider has fixed pricing'; END IF;
  IF sp.user_id = auth.uid() THEN RAISE EXCEPTION 'cannot negotiate with yourself'; END IF;

  -- ANTI-PROBING: without this a customer binary-searches the floor across fresh bookings.
  SELECT count(*) INTO v_recent FROM bookings
   WHERE customer_id = auth.uid() AND provider_id = p_provider_id
     AND status IN ('negotiating','expired') AND created_at > now() - interval '24 hours';
  IF v_recent >= 3 THEN
    RAISE EXCEPTION 'too many offers to this provider today — try again tomorrow';
  END IF;

  INSERT INTO bookings (customer_id, provider_id, category_id, service_type, scheduled_date,
                        scheduled_time, duration_hours, hourly_rate, total_amount,
                        payment_method, notes, address, status)
  VALUES (auth.uid(), p_provider_id, sp.category_id, p_service_type, p_scheduled_date,
          p_scheduled_time, p_duration_hours, sp.hourly_rate,
          COALESCE(sp.list_price, sp.hourly_rate) * COALESCE(p_duration_hours, 1),
          'upi', p_notes, p_address, 'negotiating')
  RETURNING * INTO b;

  v_expiry := now() + interval '24 hours';
  INSERT INTO offers (booking_id, round, made_by, actor_role, amount, expires_at)
  VALUES (b.id, 1, auth.uid(), 'customer', p_amount, v_expiry) RETURNING * INTO o;

  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (b.id, NULL, 'negotiating', auth.uid(), 'customer', jsonb_build_object('offer', p_amount));

  -- at or above the threshold → done, no round trip
  IF sp.auto_accept_threshold IS NOT NULL AND p_amount >= sp.auto_accept_threshold THEN
    PERFORM public.accept_offer_internal(o.id, 'auto');
    SELECT * INTO o FROM offers WHERE id = o.id;
    RETURN o;
  END IF;

  -- below the hidden floor → declined, and the negotiation ENDS. A probe costs a booking.
  IF sp.floor_price IS NOT NULL AND p_amount < sp.floor_price THEN
    UPDATE offers SET status='declined', responded_at=now() WHERE id = o.id;
    UPDATE bookings SET status='expired', updated_at=now() WHERE id = b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
    VALUES (b.id, 'negotiating', 'expired', NULL, 'system', '{"reason":"declined"}'::jsonb);
    INSERT INTO notifications (user_id, title, message, type, link) VALUES (
      auth.uid(), 'Offer not accepted',
      -- UNIFORM copy: never hint how far below the floor it was, or the floor is guessable.
      'Your offer wasn''t accepted. You can book at the listed price any time.',
      'info', '/providers/' || p_provider_id);
    SELECT * INTO o FROM offers WHERE id = o.id;
    RETURN o;
  END IF;

  INSERT INTO notifications (user_id, title, message, type, link) VALUES (
    sp.user_id, 'New offer',
    'A customer offered ₹' || trim_scale(p_amount) || '. Accept, counter or decline within 24 hours.',
    'info', '/bookings/' || b.id);
  RETURN o;
END; $$;
GRANT EXECUTE ON FUNCTION public.start_negotiation(uuid,numeric,text,date,time,numeric,text,text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Acceptance is the ONE writer that locks the price (invariants #4 and #5).
CREATE OR REPLACE FUNCTION public.accept_offer_internal(p_offer_id uuid, p_by text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o offers; b bookings; v_provider_user uuid;
BEGIN
  SELECT * INTO o FROM offers WHERE id = p_offer_id FOR UPDATE;
  SELECT * INTO b FROM bookings WHERE id = o.booking_id FOR UPDATE;
  SELECT user_id INTO v_provider_user FROM service_providers WHERE id = b.provider_id;

  UPDATE offers SET status='accepted', responded_at=now() WHERE id = o.id;
  -- THE PRICE LOCKS HERE, server-side, never client-asserted.
  UPDATE bookings SET status='accepted', price_agreed=o.amount, total_amount=o.amount,
                      updated_at=now()
   WHERE id = b.id;
  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (b.id, 'negotiating', 'accepted', auth.uid(), p_by,
          jsonb_build_object('agreed', o.amount, 'round', o.round));
  INSERT INTO notifications (user_id, title, message, type, link) VALUES
    (b.customer_id, 'Offer accepted',
     '₹' || trim_scale(o.amount) || ' agreed. Pay to confirm your booking.', 'success',
     '/bookings/' || b.id),
    (v_provider_user, 'Offer accepted',
     '₹' || trim_scale(o.amount) || ' agreed for your job.', 'success', '/bookings/' || b.id);
END; $$;
REVOKE EXECUTE ON FUNCTION public.accept_offer_internal(uuid,text) FROM public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) respond_offer — accept / counter / decline, by whoever's turn it is.
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

  -- counter
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'counter needs an amount'; END IF;
  IF o.round >= COALESCE(sp.max_counter_rounds, 3) THEN
    UPDATE offers SET status='expired', responded_at=now() WHERE id = o.id;
    UPDATE bookings SET status='expired', updated_at=now() WHERE id = b.id;
    RAISE EXCEPTION 'no rounds left — book at the listed price instead';
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
  -- DEV-A: the spec auto-accepted a provider counter at/below the customer's last offer. Dropped
  -- — it moves money without the customer confirming the final number, for no real gain.
  RETURN v_next;
END; $$;
GRANT EXECUTE ON FUNCTION public.respond_offer(uuid,text,numeric) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) Expiry sweep — an abandoned negotiation must not sit open forever.
CREATE OR REPLACE FUNCTION public.expire_stale_offers()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; r RECORD;
BEGIN
  FOR r IN UPDATE offers SET status='expired', responded_at=now()
           WHERE status='pending' AND expires_at <= now() RETURNING booking_id
  LOOP
    UPDATE bookings SET status='expired', updated_at=now()
     WHERE id = r.booking_id AND status='negotiating';
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END; $$;
REVOKE EXECUTE ON FUNCTION public.expire_stale_offers() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_offers() TO service_role;
-- schedule hourly via pg_cron, alongside the nightly reputation job

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) 🔴 Haggling must not damage reputation, or providers will switch it off.
--    Both functions below are byte-identical to their Step-8 versions EXCEPT the operational
--    denominators, which now exclude 'negotiating' and 'expired': a negotiation that went
--    nowhere is not a failed job, and an expired offer is not a cancellation.
CREATE OR REPLACE FUNCTION public.dispute_fault_rate(p_subject_type text, p_subject_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    COUNT(*) FILTER (WHERE d.status='resolved' AND d.fault_party = p_subject_type)::numeric
    / NULLIF(COUNT(DISTINCT b.id), 0), 0)
  FROM bookings b LEFT JOIN disputes d ON d.booking_id = b.id
  WHERE ((p_subject_type='provider' AND b.provider_id = p_subject_id)
      OR (p_subject_type='customer' AND b.customer_id = p_subject_id))
    AND b.status NOT IN ('requested','negotiating','expired');
$$;

CREATE OR REPLACE FUNCTION public.compute_reputation(p_subject_type text, p_subject_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c_lambda     constant numeric := 0.0077;  -- time decay: ~90-day half-life (ln2/90)
  c_prior_mean constant numeric := 4.0;      -- Bayesian prior mean
  c_confidence constant numeric := 5;        -- Bayesian strength (virtual reviews)
  c_w_reviews  constant numeric := 0.7;      -- blend weight: reviews
  c_w_ops      constant numeric := 0.3;      -- blend weight: operational metrics
  c_rater_min  constant numeric := 0.5;      -- rater-weight floor
  c_rater_max  constant numeric := 2.0;      -- rater-weight ceiling
  v_direction text;
  v_sum_w numeric := 0; v_sum_wr numeric := 0; v_n int := 0;
  v_review_score numeric; v_ops_score numeric := 4.0; v_score numeric;
  v_completion numeric; v_cancel numeric; v_dispute numeric;
  v_rater_rep numeric; v_time_w numeric; v_rater_w numeric;
  rec RECORD; v_breakdown jsonb;
BEGIN
  v_direction := CASE WHEN p_subject_type='provider' THEN 'customer_to_provider' ELSE 'provider_to_customer' END;

  -- ---- REVIEW component: Bayesian-shrunk, time-decayed, rater-weighted ----
  FOR rec IN
    SELECT r.rating, r.reviewer_id, r.created_at FROM reviews r
    WHERE r.direction = v_direction
      AND ((p_subject_type='provider' AND r.provider_id = p_subject_id)
        OR (p_subject_type='customer' AND r.customer_id = p_subject_id))
  LOOP
    v_n := v_n + 1;
    v_time_w := exp(-c_lambda * GREATEST(0, EXTRACT(EPOCH FROM (now()-rec.created_at))/86400));
    IF p_subject_type='provider' THEN
      SELECT score INTO v_rater_rep FROM reputation_snapshots
        WHERE subject_type='customer' AND subject_id = rec.reviewer_id ORDER BY computed_at DESC LIMIT 1;
    ELSE
      SELECT rs.score INTO v_rater_rep FROM reputation_snapshots rs
        JOIN service_providers sp ON sp.id = rs.subject_id
        WHERE rs.subject_type='provider' AND sp.user_id = rec.reviewer_id ORDER BY rs.computed_at DESC LIMIT 1;
    END IF;
    v_rater_w := LEAST(c_rater_max, GREATEST(c_rater_min, COALESCE(v_rater_rep, 4.0) / 4.0));
    v_sum_w  := v_sum_w  + v_time_w * v_rater_w;
    v_sum_wr := v_sum_wr + v_time_w * v_rater_w * rec.rating;
  END LOOP;
  v_review_score := (c_confidence * c_prior_mean + v_sum_wr) / (c_confidence + v_sum_w);

  -- ---- OPERATIONAL component ----
  -- Step 10: 'negotiating' and 'expired' are EXCLUDED. A haggle that went nowhere is not a
  -- failed job — counting it would make bargaining lower a provider's score, and they would
  -- simply turn it off.
  v_dispute := public.dispute_fault_rate(p_subject_type, p_subject_id);
  IF p_subject_type='provider' THEN
    SELECT COALESCE(avg((status IN ('paid','reviewed'))::int),1),
           COALESCE(avg((status='cancelled')::int),0)
      INTO v_completion, v_cancel
      FROM bookings WHERE provider_id = p_subject_id
        AND status NOT IN ('requested','negotiating','expired');
    v_ops_score := 5*COALESCE(v_completion,1) - 2*COALESCE(v_cancel,0) - 3*COALESCE(v_dispute,0);
  ELSE
    SELECT COALESCE(avg((status='cancelled')::int),0)
      INTO v_cancel
      FROM bookings WHERE customer_id = p_subject_id
        AND status NOT IN ('requested','negotiating','expired');
    v_ops_score := 5 - 2*COALESCE(v_cancel,0) - 3*COALESCE(v_dispute,0);
  END IF;
  v_ops_score := LEAST(5, GREATEST(0, v_ops_score));

  -- ---- BLEND ----
  v_score := round((c_w_reviews * v_review_score + c_w_ops * v_ops_score)::numeric, 2);

  v_breakdown := jsonb_build_object(
    'review_score', round(v_review_score,2), 'review_count', v_n,
    'ops_score', round(v_ops_score,2),
    'completion', round(COALESCE(v_completion,1),3),
    'cancellation', round(COALESCE(v_cancel,0),3),
    'dispute_fault_rate', round(COALESCE(v_dispute,0),3),
    'params', jsonb_build_object('lambda',c_lambda,'prior',c_prior_mean,'confidence',c_confidence,
                                 'w_reviews',c_w_reviews,'w_ops',c_w_ops));

  INSERT INTO reputation_snapshots(subject_type, subject_id, score, breakdown)
  VALUES (p_subject_type, p_subject_id, v_score, v_breakdown);
  IF p_subject_type='provider' THEN
    UPDATE service_providers SET reputation_score = v_score WHERE id = p_subject_id;
  ELSE
    UPDATE profiles SET reputation_score = v_score WHERE id = p_subject_id;
  END IF;
  RETURN v_score;
END; $$;
