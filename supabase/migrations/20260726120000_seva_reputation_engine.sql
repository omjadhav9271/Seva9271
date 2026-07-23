/* Seva — Step 7: reputation engine. Run AFTER Step 6.
   Adds reputation_score (0–5) + snapshot history for providers AND customers, computed by a
   Bayesian + time-decay + bounded-rater-weight + operational-blend function. `rating` (the
   human star average) is left as-is; this is the separate trust score used for ranking. */

-- 1) Server-computed reputation fields (Step-1 column grants keep clients from writing them).
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS reputation_score NUMERIC DEFAULT 0;
ALTER TABLE profiles           ADD COLUMN IF NOT EXISTS reputation_score NUMERIC DEFAULT 0;

-- 2) Snapshot history — the audit trail that makes a score explainable.
CREATE TABLE IF NOT EXISTS reputation_snapshots (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('provider','customer')),
  subject_id   UUID NOT NULL,   -- service_providers.id (provider) or auth.users.id (customer)
  score        NUMERIC NOT NULL,
  breakdown    JSONB NOT NULL,  -- component scores + inputs + params
  computed_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_repsnap_subject ON reputation_snapshots(subject_type, subject_id, computed_at DESC);
ALTER TABLE reputation_snapshots ENABLE ROW LEVEL SECURITY;
-- provider reputation is public (trust display); a customer's own reputation is private to them.
DROP POLICY IF EXISTS "read_reputation_snapshots" ON reputation_snapshots;
CREATE POLICY "read_reputation_snapshots" ON reputation_snapshots FOR SELECT USING (
  subject_type = 'provider' OR (subject_type = 'customer' AND subject_id = auth.uid())
);
REVOKE INSERT, UPDATE, DELETE ON reputation_snapshots FROM authenticated, anon;

-- 3) The engine. Server-only. Writes a snapshot + the denormalized score, returns the score.
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
    -- rater's reputation from their LAST snapshot (previous-epoch weight; breaks circularity).
    -- When scoring a PROVIDER, raters are customers → customer snapshot by user id.
    -- When scoring a CUSTOMER, raters are providers → provider snapshot via service_providers.user_id.
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

  -- ---- OPERATIONAL component: auto-measured, harder to game (0–5 scale) ----
  IF p_subject_type='provider' THEN
    SELECT COALESCE(avg((status IN ('paid','reviewed'))::int),1),
           COALESCE(avg((status='cancelled')::int),0),
           COALESCE(avg((status='disputed')::int),0)
      INTO v_completion, v_cancel, v_dispute
      FROM bookings WHERE provider_id = p_subject_id AND status <> 'requested';
    v_ops_score := 5*COALESCE(v_completion,1) - 2*COALESCE(v_cancel,0) - 3*COALESCE(v_dispute,0);
  ELSE
    SELECT COALESCE(avg((status='cancelled')::int),0),
           COALESCE(avg((status='disputed')::int),0)
      INTO v_cancel, v_dispute
      FROM bookings WHERE customer_id = p_subject_id AND status <> 'requested';
    v_ops_score := 5 - 2*COALESCE(v_cancel,0) - 3*COALESCE(v_dispute,0);
  END IF;
  v_ops_score := LEAST(5, GREATEST(0, v_ops_score));

  -- ---- BLEND ----
  v_score := round((c_w_reviews * v_review_score + c_w_ops * v_ops_score)::numeric, 2);

  v_breakdown := jsonb_build_object(
    'review_score', round(v_review_score,2), 'review_count', v_n,
    'ops_score', round(v_ops_score,2),
    'completion', round(COALESCE(v_completion,1),3),
    'cancellation', round(COALESCE(v_cancel,0),3), 'dispute', round(COALESCE(v_dispute,0),3),
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
REVOKE EXECUTE ON FUNCTION public.compute_reputation(text,uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_reputation(text,uuid) TO service_role;

-- 4) Recompute triggers: on a new review, and on terminal/operational booking events.
CREATE OR REPLACE FUNCTION public.reputation_on_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.direction='customer_to_provider' THEN PERFORM compute_reputation('provider', NEW.provider_id);
  ELSE PERFORM compute_reputation('customer', NEW.customer_id); END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_reputation_on_review ON reviews;
CREATE TRIGGER trg_reputation_on_review AFTER INSERT ON reviews
FOR EACH ROW EXECUTE FUNCTION public.reputation_on_review();

CREATE OR REPLACE FUNCTION public.reputation_on_booking_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_customer uuid; v_provider uuid;
BEGIN
  IF NEW.to_status NOT IN ('paid','cancelled','disputed','reviewed') THEN RETURN NEW; END IF;
  SELECT customer_id, provider_id INTO v_customer, v_provider FROM bookings WHERE id = NEW.booking_id;
  PERFORM compute_reputation('provider', v_provider);
  PERFORM compute_reputation('customer', v_customer);
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_reputation_on_booking_event ON booking_events;
CREATE TRIGGER trg_reputation_on_booking_event AFTER INSERT ON booking_events
FOR EACH ROW EXECUTE FUNCTION public.reputation_on_booking_event();

-- 5) Nightly full recompute — so TIME-DECAY and rater-weight changes propagate even with no new
--    events (a score must drift down as good behavior ages). Needs pg_cron.
CREATE OR REPLACE FUNCTION public.recompute_all_reputation()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM service_providers LOOP PERFORM compute_reputation('provider', r.id); END LOOP;
  FOR r IN SELECT DISTINCT customer_id AS id FROM bookings LOOP PERFORM compute_reputation('customer', r.id); END LOOP;
END; $$;
REVOKE EXECUTE ON FUNCTION public.recompute_all_reputation() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_all_reputation() TO service_role;
-- After enabling pg_cron (Dashboard → Database → Extensions → pg_cron), schedule it:
--   SELECT cron.schedule('nightly-reputation','0 2 * * *',$$SELECT public.recompute_all_reputation();$$);
