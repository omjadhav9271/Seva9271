# Seva — Playbook Step 7: The Reputation Engine

> Step 7 of `/docs/Seva-Claude-Code-Playbook.md` (architecture §6.2, §6.3). Read `CLAUDE.md` first. This is the moat — the reason Seva exists. It replaces the naive average with a **manipulation-resistant, time-aware, merit-weighted** score, for **both** providers and customers, stored as explainable snapshots. Do this after Step 6 is committed.

---

## Where you are (grounded in the current repo)

- `service_providers.rating` = a plain direction-aware **star average** (Step 6). `total_reviews`, `total_bookings`, `created_at` (tenure) are there too.
- `reviews` are multi-dimensional with `reviewer_id` + `created_at` — everything time-decay and rater-weighting need.
- `booking_events` gives timestamped transitions with `actor_role` — the source for auto-measured operational metrics (completion, cancellation, disputes, response time).
- `profiles` has `wallet_tier` and `created_at` but **no customer reputation field** — Step 7 adds one; Step 1's column grants already protect it from client writes.
- No scheduled-job infrastructure yet.

## Design: two numbers, not one

Keep them separate and each honest about its job:
- **`rating`** (existing) — the **human-facing star average** customers recognize. Leave the Step-6 trigger that maintains it. Don't touch.
- **`reputation_score`** (new, 0–5) — the **engine's trust score**: Bayesian-shrunk, time-decayed, rater-weighted reviews **blended** with auto-measured operational metrics. This is what ranking (Step 11), tiers (Step 15), and merit decisions use. Stored as a denormalized column **and** as `reputation_snapshots` rows so every score is explainable and historical.

The four mechanisms from the architecture, and why each is here:
1. **Bayesian shrinkage** — one 5★ must not outrank a long 4.8★ record. Shrink toward a prior until there's evidence.
2. **Time decay** — recent behavior weighted more (captures quality drift — the Allora scenario) via `exp(−λ·age)`.
3. **Bounded rater-weighting** — an established rater counts more, but clamped to 0.5×–2× so a swarm of fresh accounts barely moves a score, and no single actor dominates. Uses the rater's **last snapshot** (previous-epoch weights) to break the circularity.
4. **Operational blend** — auto-measured completion/cancellation/dispute rates are harder to game than self-reported stars, so they get real weight.

---

## The migration (source of truth)

`supabase/migrations/20260726120000_seva_reputation_engine.sql` — run after Step 6. Constants are tunable and documented inline.

```sql
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
```

---

## App wiring (keep it minimal — ranking is Step 11)

- **`app/providers/[id]/page.tsx`** — show the provider's `reputation_score` as a small **"Trust score"** indicator next to the star `rating`, with a compact breakdown from the latest snapshot (review score, completion %, dispute rate). The stars stay the familiar average; the trust score is the engine's view.
- **`app/profile/page.tsx`** — show the signed-in user's own `reputation_score` + breakdown (their customer reputation), so they can see how they're perceived.
- **`lib/supabase.ts`** — add `reputation_score` to the provider/profile types and a `ReputationSnapshot` type.

Do not build ranking, tiers, or fraud here — those consume the score later. Step 7 just computes and surfaces it.

---

## Gotchas / decisions baked in

- **Two numbers on purpose.** `rating` = star average (human-facing, unchanged); `reputation_score` = trust score (engine, new). Don't collapse them.
- **Rater-weight uses the *previous* snapshot**, not a live recompute — that's what breaks the circular "reputation deciding reputation" and keeps it bounded (0.5×–2×). New raters default to neutral.
- **Provider vs customer identity:** provider snapshots key on `service_providers.id`; customer snapshots key on `auth.users.id`. The rater lookup handles both (customer raters by user id; provider raters via `service_providers.user_id`). This is the one subtle correctness point — keep it.
- **Nightly recompute matters** — without it, a score never decays and "was great a year ago" stays great. It needs pg_cron enabled (a dashboard step); until then, call `recompute_all_reputation()` from a scheduled Edge Function or manually.
- **Snapshots make it explainable** — every score has a `breakdown` row, so you (and later, an admin defending a dispute) can see *why*.
- Constants (`lambda`, `prior`, `confidence`, blend weights, rater bounds) are tunable in one place — expect to tune them with real data.

---

## Definition of done

- `compute_reputation` produces a 0–5 score for a provider and a customer, writes a `reputation_snapshots` row with a component `breakdown`, and updates the denormalized `reputation_score`.
- **Bayesian**: a provider with a single 5★ scores **lower** than one with many 4.8★ (shrinkage toward the prior).
- **Time-decay**: an old 5★ contributes **less** than a recent 5★.
- **Bounded rater-weight**: a review from a high-reputation rater moves the score more than one from a new account, but the effect is clamped (a swarm of fresh accounts barely moves it).
- **Operational blend**: cancellations/disputes measurably lower the score.
- `reputation_score` and `reputation_snapshots` are **server-computed only** (no client execute/write).
- A customer's snapshots are readable **only by themselves**; provider snapshots are public.
- Recompute fires on new review + terminal booking event; `recompute_all_reputation()` exists (+ pg_cron note).
- `npm run typecheck` and `npm run build` pass.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read /docs/Seva-Architecture.md (§6.2, §6.3) and CLAUDE.md first.
We are on Playbook Step 7: the reputation engine. Step 6 is committed. This is the moat —
manipulation-resistant, time-aware, merit-weighted scoring for BOTH providers and customers.

Read these first, then propose a short plan and WAIT for my OK before editing:
- CLAUDE.md and /docs/Seva-Step-7.md (this spec — the source of truth)
- supabase/migrations/20260722120000_seva_reviews.sql (reviews shape + the v1 rating trigger to LEAVE alone)
- supabase/migrations/20260711120000_seva_booking_state_machine.sql (booking_events)
- supabase/migrations/20260718120000_seva_payments_escrow.sql (SECURITY DEFINER + service_role grant pattern)
- app/providers/[id]/page.tsx, app/profile/page.tsx, lib/supabase.ts

Build:
1. Migration supabase/migrations/20260726120000_seva_reputation_engine.sql EXACTLY as in
   /docs/Seva-Step-7.md: reputation_score columns on service_providers + profiles;
   reputation_snapshots table (public for providers, self-only for customers, no client writes);
   the compute_reputation(text,uuid) SECURITY DEFINER function (Bayesian shrinkage + time-decay +
   bounded rater-weight + operational blend, writing a snapshot + the denormalized score);
   the two recompute triggers (on review insert, on terminal booking_events); and
   recompute_all_reputation() + the pg_cron note. LEAVE the existing star-average rating trigger
   (update_provider_rating) untouched — reputation_score is a SEPARATE number.
2. app/providers/[id]/page.tsx: show reputation_score as a "Trust score" next to the stars, with
   a compact breakdown from the latest snapshot.
3. app/profile/page.tsx: show the signed-in user's own reputation_score + breakdown.
4. lib/supabase.ts: add reputation_score to the types + a ReputationSnapshot type.

Do NOT (later steps):
- Build ranking/matching (Step 11), tiers/perks (Step 15), or fraud detection (Step 13) — those
  CONSUME the score; don't build them.
- Change the star-average `rating` or its trigger, escrow, the state machine, chat, reviews RLS.

Done when (verify against the live DB after I db push):
- compute_reputation writes a score + snapshot breakdown for a provider and a customer and
  updates the denormalized column.
- Bayesian: one 5★ scores lower than many 4.8★. Time-decay: an old 5★ counts less than a recent
  one. Rater-weight: a high-rep rater moves the score more than a new account, but clamped.
  Cancellations/disputes lower the score.
- reputation_score + reputation_snapshots are server-only (authenticated cannot execute
  compute_reputation, nor write the score/snapshots).
- customer snapshots are self-only readable; provider snapshots are public.
- npm run typecheck and npm run build pass.

I'll apply the migration via supabase db push. After I confirm, add scripts/verify-step7.mjs
that (using the service role to seed reviews with controlled created_at + rater snapshots, then
calling compute_reputation) asserts: the score + snapshot + breakdown are written; the Bayesian,
time-decay, and bounded-rater-weight properties hold (construct the comparative cases); ops
metrics lower the score; authenticated cannot execute compute_reputation or write
score/snapshots; and customer-snapshot RLS (self-only) vs provider-snapshot (public) holds.

Finish by reporting exactly what you changed (files + migration) and how you verified each
"Done when" item, including the actual comparative scores that demonstrate Bayesian, time-decay,
and rater-weight.
```
