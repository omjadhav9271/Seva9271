/* Seva — a dispute resolved in your favour must not count as a cancellation against you.

   FOUND BY: browser audit 2026-08-07 (F-3 in /docs/Seva-Browser-Audit-2026-08-07.md).

   Step 8's headline fix was "the reputation penalty follows FAULT, not the mere existence of a
   dispute" — a frivolous dispute must not tank an honest party. That was implemented via
   dispute_fault_rate, and it is correct: measured in both directions, only the party found at
   fault takes the fault hit.

   But a SECOND channel leaked a penalty onto the exonerated party. resolve_dispute settles a
   customer-favourable outcome by cancelling the booking:

       v_next := CASE WHEN p_outcome = 'favor_customer' THEN 'cancelled' ELSE 'paid' END;

   and compute_reputation's operational component counted every status='cancelled' booking as a
   cancellation, for BOTH parties. So a customer who WON their dispute was filed as having
   cancelled a job. Measured on the live DB: the customer's dispute_fault_rate correctly stayed
   flat at 0.053, while `cancellation` rose 0.105 -> 0.132 and the score fell 4.06 -> 4.05. Small
   per dispute, but systematic, and it scales with the number of disputes you win — which is
   exactly the "reputation attack" shape Step 8 exists to prevent.

   THE RULE: `cancellation` means someone walked away from a job. A refund ordered by Trust &
   Safety is a settlement, not a cancellation. Fault for it is already priced in, once, by
   dispute_fault_rate at -3 weight; counting it again as a cancellation double-charges the party
   at fault and wrongly charges the exonerated one.

   WHAT THIS CHANGES: the cancellation NUMERATOR now skips bookings whose 'cancelled' came from a
   resolved dispute, in both the provider and the customer branch. Nothing else moves:

     - The DENOMINATOR is unchanged. A disputed-and-refunded job is still a job that happened.
     - `completion` (provider branch) is deliberately LEFT ALONE. A refunded job genuinely did not
       complete, and that is an objective fact about the provider, not a second fault penalty. The
       customer branch has no completion term, so an exonerated customer is now fully unharmed.
     - dispute_fault_rate, the review component, the blend weights and the breakdown keys are
       byte-identical to the previous declaration.

   Safe by construction: raise_dispute only admits arrived/in_progress/completed/confirmed/paid, so
   a booking cannot be cancelled first and disputed afterwards. Any booking that is BOTH 'cancelled'
   and carries a resolved dispute got there through resolve_dispute. */

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
  -- This migration: a booking cancelled BY A DISPUTE RESOLUTION is not a cancellation either.
  -- Fault for it is already charged, once, through dispute_fault_rate.
  v_dispute := public.dispute_fault_rate(p_subject_type, p_subject_id);
  IF p_subject_type='provider' THEN
    SELECT COALESCE(avg((status IN ('paid','reviewed'))::int),1),
           COALESCE(avg((status='cancelled' AND NOT EXISTS (
             SELECT 1 FROM disputes d
             WHERE d.booking_id = bookings.id AND d.status = 'resolved'))::int),0)
      INTO v_completion, v_cancel
      FROM bookings WHERE provider_id = p_subject_id
        AND status NOT IN ('requested','negotiating','expired');
    v_ops_score := 5*COALESCE(v_completion,1) - 2*COALESCE(v_cancel,0) - 3*COALESCE(v_dispute,0);
  ELSE
    SELECT COALESCE(avg((status='cancelled' AND NOT EXISTS (
             SELECT 1 FROM disputes d
             WHERE d.booking_id = bookings.id AND d.status = 'resolved'))::int),0)
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
