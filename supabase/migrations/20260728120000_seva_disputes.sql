/* Seva — Step 8: disputes + admin console. Run AFTER Step 7.

   Escrow gives us the money to hold, chat + booking_events give us the evidence, reputation
   gives us the consequence. This migration follows /docs/Seva-Step-8.md with FOUR documented
   deviations (the Step-5 precedent: adapt where the spec-as-written can't move money/data
   correctly, and say so):

   DEV-A  resolve_dispute pays the provider in the HELD case. The spec only moved money for the
          released-clawback branch; with funds still held, favor_provider / no_fault / partial
          marked the booking 'released' but credited nobody — escrow money would strand with the
          platform. Now: remainder (amount − refund) is released to the provider's wallet minus
          the 15% fee, mirroring release_escrow_on_confirm, and the ledger row moves
          captured→released.
   DEV-B  (route change, not SQL) /api/payments/refund gains an admin dispute branch — the spec
          ordering "resolve, then refund" hit the route's payment_status='held' guard after
          resolve_dispute had already set 'refunded', so the gateway refund silently no-opped.
   DEV-C  Two more additive admin SELECT policies (profiles, reputation_snapshots): the evidence
          bundle must show the customer's name + reputation, and both were self-only.
   DEV-D  transition_booking loses its client entrances into 'disputed'. A status-only dispute
          (no disputes row) is invisible to the admin console and unresolvable — the exact dead
          end this step exists to fix. raise_dispute is now the ONLY way in (invariant #4: one
          validated writer per state change). */

-- 1) is_admin(): SECURITY DEFINER so policies can check role without recursing into profiles RLS.
--    Safe to trust because profiles.role is NOT client-writable (Step-1 column grants).
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin');
$$;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- 2) Disputes.
CREATE TABLE IF NOT EXISTS disputes (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id   UUID REFERENCES bookings(id) ON DELETE CASCADE NOT NULL,
  raised_by    UUID REFERENCES auth.users(id) NOT NULL,
  raiser_role  TEXT NOT NULL CHECK (raiser_role IN ('customer','provider')),
  reason       TEXT NOT NULL CHECK (reason IN
                 ('work_not_done','poor_quality','overcharged','no_show','damage',
                  'payment_not_received','customer_behaviour','other')),
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','resolved')),
  outcome      TEXT CHECK (outcome IN ('favor_customer','favor_provider','partial','no_fault')),
  fault_party  TEXT CHECK (fault_party IN ('customer','provider','none')),
  refund_amount NUMERIC,
  resolution_notes TEXT,
  resolved_by  UUID REFERENCES auth.users(id),
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_disputes_booking ON disputes(booking_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status  ON disputes(status, created_at DESC);
-- one open dispute per booking
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_dispute_per_booking
  ON disputes(booking_id) WHERE status <> 'resolved';

ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_own_or_admin_disputes" ON disputes;
CREATE POLICY "read_own_or_admin_disputes" ON disputes FOR SELECT TO authenticated
USING (public.is_booking_party(booking_id) OR public.is_admin());
REVOKE INSERT, UPDATE, DELETE ON disputes FROM authenticated, anon;  -- RPC-only

-- 3) Admin read access to the evidence bundle (additive SELECT policies; role isn't
--    client-writable, so is_admin() is safe to trust).
DROP POLICY IF EXISTS "admin_read_bookings" ON bookings;
CREATE POLICY "admin_read_bookings" ON bookings FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "admin_read_messages" ON messages;
CREATE POLICY "admin_read_messages" ON messages FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "admin_read_events" ON booking_events;
CREATE POLICY "admin_read_events" ON booking_events FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "admin_read_paytx" ON payment_transactions;
CREATE POLICY "admin_read_paytx" ON payment_transactions FOR SELECT TO authenticated USING (public.is_admin());
-- DEV-C: the bundle also shows the customer's name + reputation, and both live behind
-- self-only policies. Additive admin reads (column privileges are unchanged).
DROP POLICY IF EXISTS "admin_read_profiles" ON profiles;
CREATE POLICY "admin_read_profiles" ON profiles FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "admin_read_reputation_snapshots" ON reputation_snapshots;
CREATE POLICY "admin_read_reputation_snapshots" ON reputation_snapshots FOR SELECT TO authenticated USING (public.is_admin());

-- 4) raise_dispute — party-only, valid states, moves the booking to 'disputed'.
CREATE OR REPLACE FUNCTION public.raise_dispute(
  p_booking_id uuid, p_reason text, p_description text DEFAULT NULL
) RETURNS disputes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b bookings; v_provider_user uuid; v_role text; d disputes; v_other uuid;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking not found'; END IF;
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  IF    auth.uid() = b.customer_id   THEN v_role := 'customer';
  ELSIF auth.uid() = v_provider_user THEN v_role := 'provider';
  ELSE  RAISE EXCEPTION 'not a party to this booking'; END IF;

  IF b.status NOT IN ('arrived','in_progress','completed','confirmed','paid') THEN
    RAISE EXCEPTION 'this booking cannot be disputed at status %', b.status;
  END IF;

  INSERT INTO disputes (booking_id, raised_by, raiser_role, reason, description)
  VALUES (p_booking_id, auth.uid(), v_role, p_reason, p_description)
  RETURNING * INTO d;   -- partial unique index blocks a second open dispute

  UPDATE bookings SET status='disputed', updated_at=NOW() WHERE id = p_booking_id;
  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (p_booking_id, b.status, 'disputed', auth.uid(), v_role,
          jsonb_build_object('dispute_id', d.id, 'reason', p_reason));

  v_other := CASE WHEN v_role='customer' THEN v_provider_user ELSE b.customer_id END;
  INSERT INTO notifications (user_id, title, message, type, link) VALUES
    (v_other, 'Dispute raised', 'A dispute was opened on your booking. Our team will review it.',
     'warning', '/bookings/' || p_booking_id);
  RETURN d;
END; $$;
GRANT EXECUTE ON FUNCTION public.raise_dispute(uuid,text,text) TO authenticated;

-- 5) resolve_dispute — ADMIN ONLY. Moves money, exits 'disputed', assigns fault.
--    Money map (DEV-A adds the held-case releases the spec omitted):
--      held     + favor_provider/no_fault → full escrow released to provider (−15% fee)
--      held     + partial                 → refund_amount back to customer (gateway, admin
--                                           route), remainder released to provider (−fee)
--      held     + favor_customer          → full gateway refund (admin route); provider gets 0
--      released + favor_customer/partial  → wallet CLAWBACK from the provider (they were already
--                                           paid; balance may go negative — permitted, flagged
--                                           for admin follow-up), then gateway refund
--      released + favor_provider/no_fault → money already where it belongs; nothing moves
--    The actual Razorpay refund is issued by the admin API route AFTER this returns (Postgres
--    can't call Razorpay); this records intent + wallet effects.
CREATE OR REPLACE FUNCTION public.resolve_dispute(
  p_dispute_id uuid, p_outcome text, p_fault text, p_notes text DEFAULT NULL,
  p_refund_amount numeric DEFAULT NULL
) RETURNS disputes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d disputes; b bookings; v_provider_user uuid; v_amount numeric; v_next text;
  v_refund numeric; v_remainder numeric; v_fee numeric; v_payout numeric;
  c_fee_pct constant numeric := 0.15;   -- keep in sync with release_escrow_on_confirm
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
    -- provider was already paid out on confirm; pull the refunded share back
    IF v_refund > 0 THEN
      PERFORM public.credit_wallet(v_provider_user, v_refund, 'debit',
              'Dispute clawback for booking ' || b.id::text, b.id);
    END IF;
  ELSIF b.payment_status = 'held' THEN
    -- DEV-A: release the provider's share of held escrow (the spec left this money stranded)
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
    -- full favor_customer: nothing to the provider; the ledger row flips captured→refunded in
    -- the admin refund route when the gateway refund succeeds
  END IF;
  -- payment_status='pending': nothing was ever captured — no money to move

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

-- 6) 🔴 FIX: reputation penalty follows FAULT, not the mere existence of a dispute.
--    Previously `status='disputed'` penalized BOTH parties — so a frivolous dispute could tank an
--    honest provider. Now only disputes RESOLVED AGAINST you count.
CREATE OR REPLACE FUNCTION public.dispute_fault_rate(p_subject_type text, p_subject_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    COUNT(*) FILTER (WHERE d.status='resolved' AND d.fault_party = p_subject_type)::numeric
    / NULLIF(COUNT(DISTINCT b.id), 0), 0)
  FROM bookings b LEFT JOIN disputes d ON d.booking_id = b.id
  WHERE ((p_subject_type='provider' AND b.provider_id = p_subject_id)
      OR (p_subject_type='customer' AND b.customer_id = p_subject_id))
    AND b.status <> 'requested';
$$;
GRANT EXECUTE ON FUNCTION public.dispute_fault_rate(text,uuid) TO service_role;

-- 7) compute_reputation, re-declared: the ops component's dispute term is now the FAULT rate.
--    Everything else — Bayesian shrinkage, time decay, bounded rater weight, blend, snapshot —
--    is byte-identical to the Step-7 version. Breakdown key renamed dispute → dispute_fault_rate.
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
  -- Step 8: the dispute term is the rate of disputes RESOLVED AGAINST this subject — merely
  -- being disputed no longer moves anyone's score.
  v_dispute := public.dispute_fault_rate(p_subject_type, p_subject_id);
  IF p_subject_type='provider' THEN
    SELECT COALESCE(avg((status IN ('paid','reviewed'))::int),1),
           COALESCE(avg((status='cancelled')::int),0)
      INTO v_completion, v_cancel
      FROM bookings WHERE provider_id = p_subject_id AND status <> 'requested';
    v_ops_score := 5*COALESCE(v_completion,1) - 2*COALESCE(v_cancel,0) - 3*COALESCE(v_dispute,0);
  ELSE
    SELECT COALESCE(avg((status='cancelled')::int),0)
      INTO v_cancel
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

-- 8) DEV-D: transition_booking loses its client entrances into 'disputed'. Faithful copy of the
--    latest version (20260719, with the escrow gate) with ONLY the four `→ disputed` lines
--    removed — raise_dispute is the sole entrance now (it records the disputes row the admin
--    console resolves; a bare status flip would be an unresolvable dead end).
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
    WHEN v_from='in_progress' AND p_next_status='completed'   AND v_role='provider' THEN true
    WHEN v_from='completed'   AND p_next_status='confirmed'   AND v_role='customer' THEN true
    ELSE false   -- 'paid' is system-only (escrow trigger); 'disputed' is raise_dispute-only (Step 8)
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'illegal transition % -> % for role %', v_from, p_next_status, v_role;
  END IF;

  -- Escrow gate: an ONLINE booking must have funds held before the provider can begin work.
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
