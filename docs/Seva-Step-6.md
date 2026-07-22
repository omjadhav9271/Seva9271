# Seva — Playbook Step 6: Bidirectional, Gated Reviews

> Step 6 of `/docs/Seva-Claude-Code-Playbook.md` (architecture §6.1, §6.4). Read `CLAUDE.md` first. Do this **after** Step 5 is committed. This is the first real piece of the reputation system — reviews are the *fuel*; Step 7 turns them into scores. Keep the trust rules tight: reviews are the thing scammers most want to fake.

---

## Where you are (grounded in the current repo)

- `reviews` = `(id, booking_id [NOT NULL, UNIQUE], customer_id, provider_id, rating INT 1–5 [NOT NULL], comment, created_at)`. **Single-direction** (customer→provider), **single-dimension**.
- Step 1 already gated inserts to a **completed booking** and made `booking_id` unique (one review per booking). Good foundation.
- Existing **`update_provider_rating()` trigger** (migration 20260627130547) recomputes `service_providers.rating` + `total_reviews` on each review insert. This is reputation **v1** — keep it, but make it direction-aware. Step 7 replaces it with the real math.
- `credit_wallet(uuid,numeric,text,text,uuid)` (Step 5, service-role only) is available for the review reward.
- The provider detail page already reads and renders reviews (extend it). The booking detail page has a **"Write Review" stub** to replace.

## What this step adds

1. **Bidirectional**: customer→provider *and* provider→customer, one each per booking.
2. **Multi-dimensional, direction-labelled**: four axis columns whose *labels* depend on direction (see the axis table under App wiring). The **overall is derived** — the average of the axes the rater fills — not entered separately.
3. **Tighter gate**: reviewable only after the booking is **settled** (`paid`/`released`), and only by a party — enforced through a `submit_review` RPC (like `transition_booking`), with direct writes revoked.
4. **Reciprocity reveal**: each side's review is hidden from the other until *both* submit (or 14 days pass) — kills retaliation bias.
5. **Incentive**: a small wallet reward for reviewing within 24h of payment.
6. **Immutable** reviews (no client edit/delete) — trustworthy as reputation input and dispute evidence.
7. **Live, no-refresh**: the reveal and the booking's settle-state update in realtime on both sides (`reviews` **and** `bookings` in the realtime publication).
8. **Notified**: submitting a review notifies the other party (and both on reveal) via the bell — content-free (no rating/comment leaks).

---

## The migration (source of truth)

`supabase/migrations/20260722120000_seva_reviews.sql` — run after the Step 5 migrations:

```sql
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
--    The counterpart-exists test MUST go through a SECURITY DEFINER helper, NOT an inline
--    `EXISTS (SELECT 1 FROM reviews …)`. A reference to `reviews` inside a policy ON `reviews`
--    re-applies the policy to the subquery → "infinite recursion detected in policy for relation
--    reviews" on every read (breaks all review reads, not just an edge case). The helper is owned
--    by a BYPASSRLS role and, being SECURITY DEFINER, is not inlined — so its internal read of
--    `reviews` runs with the definer's rights and does not re-enter the policy.
CREATE OR REPLACE FUNCTION public.review_reciprocated(p_booking_id uuid, p_direction text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM reviews r2
    WHERE r2.booking_id = p_booking_id AND r2.direction <> p_direction
  );
$$;
REVOKE EXECUTE ON FUNCTION public.review_reciprocated(uuid,text) FROM public;
GRANT  EXECUTE ON FUNCTION public.review_reciprocated(uuid,text) TO anon, authenticated;

DROP POLICY IF EXISTS "anyone_can_read_reviews" ON reviews;
CREATE POLICY "read_revealed_reviews" ON reviews FOR SELECT USING (
  reviewer_id = auth.uid()
  OR public.review_reciprocated(reviews.booking_id, reviews.direction)
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
```

### Follow-up migrations (also source of truth)

- `20260723120000_seva_reviews_reveal_fix.sql` — the reveal-policy recursion fix, already folded into section 3 above (kept as its own migration only because `20260722120000` was applied before the bug was found).
- `20260724120000_seva_review_notifications.sql` — live reveal + review notifications:

```sql
-- reviews → realtime so the counterpart's review reveals live (RLS still gates the stream).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='reviews')
  THEN ALTER PUBLICATION supabase_realtime ADD TABLE reviews; END IF;
END $$;

-- Notify the OTHER party on review insert. Explicit recipients; NO rating/comment leaked (the
-- notification only links to the booking — content stays behind RLS). Modeled on notify_on_message.
CREATE OR REPLACE FUNCTION public.notify_on_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider_user uuid; v_counterpart uuid; v_reveals boolean;
        v_link text := '/bookings/' || NEW.booking_id;
BEGIN
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = NEW.provider_id;
  IF NEW.direction = 'customer_to_provider' THEN v_counterpart := v_provider_user;
  ELSE                                            v_counterpart := NEW.customer_id; END IF;
  v_reveals := EXISTS (SELECT 1 FROM reviews r2
                       WHERE r2.booking_id = NEW.booking_id AND r2.direction <> NEW.direction);
  IF v_reveals THEN            -- second review: both now visible
    IF v_counterpart IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, type, link)
      VALUES (v_counterpart, 'You received a review', 'Both reviews are now visible on your booking.', 'success', v_link);
    END IF;
    IF NEW.reviewer_id IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, type, link)
      VALUES (NEW.reviewer_id, 'Reviews revealed', 'Both reviews are now visible on your booking.', 'success', v_link);
    END IF;
  ELSE                          -- first review: hidden until reciprocated
    IF v_counterpart IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, type, link)
      VALUES (v_counterpart, 'The other party left a review', 'Rate them to reveal both reviews.', 'info', v_link);
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_notify_review ON reviews;
CREATE TRIGGER trg_notify_review AFTER INSERT ON reviews
FOR EACH ROW EXECUTE FUNCTION public.notify_on_review();
```

- `20260725120000_seva_bookings_realtime.sql` — add `bookings` to the realtime publication (same guarded `DO`-block) so the booking detail page reflects settle/status changes live for **both** parties. Without it the provider had to refresh before the review form (gated on `settled`) appeared, since only the party who triggered a transition refetched.

---

## App wiring (what Claude Code changes in code)

The four axis columns are generic slots **labelled by direction** (no schema rename). `rating_quality` is reused as "Respect" on the provider side; `rating_price_fairness` is customer-only:

| column | customer→provider | provider→customer |
|---|---|---|
| `rating_quality` | Quality of work | Respect |
| `rating_punctuality` | Punctuality | Availability / punctuality |
| `rating_communication` | Professionalism | Communication |
| `rating_price_fairness` | Value for money | *(unused → null)* |

- **`components/booking-review.tsx`** (new; mirrors `booking-chat.tsx`) rendered by the booking detail page when the booking is settled (`paid`/`released`) **and** the current user hasn't reviewed for their direction yet:
  - Rate the axes for your direction (all required). **Overall is derived** = the average of those axes, shown live; it is **not** a separate input. Submit sends `p_rating = round(mean)` (keeps the INT column + RPC signature); `p_quality` is filled by **both** sides, `p_price_fairness` customer-only.
  - Submit → `supabase.rpc('submit_review', { p_booking_id, p_rating, p_comment, p_quality, p_punctuality, p_communication, p_price_fairness })`.
  - After submitting, show a "waiting for the other party" state; render the counterpart's review only once RLS reveals it. **Subscribe to `reviews` (filtered by `booking_id`)** so the reveal appears live with no refresh. Cards show Overall as the mean of the shown axes, so entered vs. displayed agree.
  - The booking detail page also **subscribes to its `bookings` row** and refetches on update, so a settle transition by the other party reveals the form live (no refresh).
- **`app/providers/[id]/page.tsx`** — filter the review query to `direction = 'customer_to_provider'`, show the dimension breakdown (customer→provider labels above), and render each review's overall as the mean of its axes. RLS already hides unrevealed ones.
- **`lib/supabase.ts`** — `Review` type carries `direction`, `reviewer_id`, and the four `rating_*` axes.

---

## Gotchas / decisions baked in

- **submit_review is the only writer** (direct insert/update/delete revoked) — mirrors `transition_booking`. This keeps the direction/gate/one-per-side logic in one trusted place and lets the reward be atomic.
- **Reciprocity is computed in the SELECT policy** — no `is_visible` column and no scheduled job. A review reveals when the counterpart submits, or 14 days after it was written. The reviewer always sees their own.
- **The reveal policy must not self-reference `reviews` inline** — the counterpart-exists check goes through the `review_reciprocated()` SECURITY DEFINER helper (section 3). An inline `EXISTS (SELECT 1 FROM reviews …)` recurses (`infinite recursion detected in policy for relation "reviews"`) and breaks every review read. *(In the shipped repo this correction landed as a follow-up migration `20260723120000_seva_reviews_reveal_fix.sql`, because `20260722120000` was already applied and migrations are immutable; the SQL above inlines the fix so a fresh build gets it right in one migration.)*
- **Immutable** — no edit/delete. A review you can revise after seeing the counterpart's is a gaming vector; leave it locked.
- **The old avg-rating trigger stays as v1**, now direction-aware. Do **not** build Bayesian/time-decay/rater-weighting here — that's Step 7, and it needs this raw data first.
- **Settled = `paid`/`released`**, tightened from Step 1's `completed`. Now that escrow exists, "reviewable" means the money actually cleared.
- Reward is ₹10 within 24h — tune later; keep it small.
- **Overall is derived, not entered** — it's the mean of the direction's axes, rounded to a whole star for the INT `rating` column that feeds the provider aggregate; the UI shows the precise average. This keeps `submit_review`'s signature unchanged. (Persisting exact half-stars would need `rating`→numeric + an RPC change — deferred.)
- **Review notifications never leak content** — title + booking link only; the rating/comment stay behind RLS. Recipients are explicit: the counterpart on the first review; both parties on reveal.
- **Live updates are RLS-gated** — `reviews` and `bookings` are in the realtime publication, so the reveal and the settle-state appear without a refresh, but a client still only receives rows it may SELECT. The reveal stream works because the reveal policy's counterpart check runs through the `review_reciprocated()` definer helper (a plain self-referencing policy would also break realtime's RLS check).

---

## Definition of done

- A settled booking lets **both** the customer and the provider submit a multi-dimensional review, **exactly once each** (a second from the same side is rejected).
- A review **cannot** be submitted for a non-settled booking, or by a non-party.
- Reviews are **immutable** — a client cannot insert directly, update, or delete; only `submit_review` writes.
- **Reciprocity**: before the counterpart submits, a third party (and the counterpart) cannot see a review; after either side submits their own or 14 days pass, it's visible. Each user always sees their own.
- Reviewing within 24h of payment credits the wallet reward.
- The provider's aggregate `rating`/`total_reviews` update from **customer→provider** reviews only (a provider's review of a customer does not move the provider's own rating).
- The form derives **Overall as the average of the axes**; axes are labelled by direction (table above).
- The reveal **and** the booking settle-state update live (no manual refresh) on both sides.
- Submitting a review **notifies** the other party (content-free); both are notified on reveal.
- `npm run typecheck` and `npm run build` pass.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read /docs/Seva-Architecture.md (§6.1, §6.4) and CLAUDE.md first.
We are on Playbook Step 6: bidirectional, gated reviews. Step 5 is committed.

Read these first, then propose a short plan and WAIT for my OK before editing:
- CLAUDE.md and /docs/Seva-Step-6.md (this spec — the source of truth)
- supabase/migrations/20260622131542_seva_initial_schema.sql (reviews table + policies)
- supabase/migrations/20260627130547_seva_indian_services_expansion.sql (update_provider_rating trigger)
- supabase/migrations/20260710120000_seva_security_hardening.sql (the Step-1 review gate)
- supabase/migrations/20260718120000_seva_payments_escrow.sql (credit_wallet signature)
- app/bookings/[id]/page.tsx (the "Write Review" stub) and app/providers/[id]/page.tsx (review list)
- lib/supabase.ts and lib/bookings.ts (types)

Build:
1. Migration supabase/migrations/20260722120000_seva_reviews.sql EXACTLY as in
   /docs/Seva-Step-6.md: add direction + reviewer_id + the four dimension columns; swap the
   unique constraint to (booking_id, direction); revoke all client writes on reviews and drop
   the old insert/update/delete policies; the computed reciprocity-reveal SELECT policy; the
   submit_review SECURITY DEFINER RPC (party+settled+direction checks, incentive via credit_wallet);
   and make update_provider_rating direction-aware.
2. app/bookings/[id]/page.tsx: replace the Write Review stub with a real multi-dimensional form,
   shown when the booking is settled and the user hasn't reviewed their direction yet. Customer
   rates provider (overall/quality/punctuality/price_fairness/communication + comment); provider
   rates customer (overall/communication/punctuality + comment). Submit via
   supabase.rpc('submit_review', ...). After submit, show a "waiting for the other party" state
   and only render the counterpart's review once it's revealed.
3. app/providers/[id]/page.tsx: filter reviews to direction='customer_to_provider' and show the
   dimension breakdown.
4. Add a Review type to lib/supabase.ts.

Do NOT touch (later steps):
- The reputation math — leave update_provider_rating as the simple direction-aware average
  (Bayesian/time-decay/rater-weighting is Step 7).
- Payments/escrow, the state machine, chat, notifications.

Done when:
- Both parties can submit one multi-dimensional review each on a settled booking; a second from
  the same side is rejected; a non-party or non-settled booking is rejected.
- Reviews are immutable (direct insert/update/delete denied; only submit_review writes).
- Reciprocity: a review is hidden from the counterpart until they submit or 14 days pass; each
  user always sees their own.
- Reviewing within 24h of payment credits the wallet reward.
- Provider rating/total_reviews update from customer→provider reviews only.
- npm run typecheck and npm run build pass.

I'll apply the migration via supabase db push. After I confirm, add scripts/verify-step6.mjs:
as customer + provider on a settled booking — customer submits (assert row, direction, provider
rating updated, reward credited); assert the provider can't yet see the customer's review
(reveal hidden) and a third party can't either; provider submits (assert both now revealed);
assert a 2nd review from the same side is rejected, a non-party is rejected, a non-settled
booking is rejected, and direct insert/update/delete on reviews are denied.

Finish by reporting exactly what you changed (files + migration) and how you verified each
"Done when" item.
```
