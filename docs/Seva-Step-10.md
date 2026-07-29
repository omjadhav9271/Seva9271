# Seva — Playbook Step 10: Structured bargaining v1

> Step 10 of `/docs/Seva-Claude-Code-Playbook.md`. Architecture §5.5. Depends on Steps 2 & 5 (state machine + escrow), both done and covered by the suite. Read `CLAUDE.md` first.
>
> Bargaining is the cultural hook — and it belongs *here*, before matching, because **the agreed price has to lock into escrow**. Everything after acceptance is the existing pipeline, untouched.

---

## UX bar for this step

- **"Book at ₹X" stays the default, one-tap path.** The hurried customer must never be forced to haggle. "Make an offer" sits *beside* it, and only for providers who opted in.
- **Structured buttons, never free text.** Offer / counter / accept. No price chat — that's the channel where "let's just settle in cash" happens (§7.3), and it's the leak this step is designed to close.
- **A negotiation is bounded and visible**: capped rounds, a visible expiry, and a clear "your turn / their turn".
- **A failed haggle costs nothing.** Neither party's reputation may suffer for negotiating — or providers will simply refuse to.
- **The provider's floor is never revealed**, not even by inference.

---

## Where you are (grounded in the current repo)

- A provider has **one category and one `hourly_rate`** (Step 9 enforced one provider profile per user). There is no listings concept.
- `bookings.status` allows `requested, accepted, en_route, arrived, in_progress, completed, confirmed, paid, reviewed, cancelled, disputed, expired` — **`negotiating` is not in the constraint** (verified against the live DB); `expired` already is.
- `price_agreed` is set by `trg_set_price_agreed` BEFORE INSERT, from `total_amount`, only when NULL.
- **`/api/payments/create-order` already reads `price_agreed` from the DB** and refuses when it's null ("no amount agreed"). So an accepted offer flows into escrow with no payment changes, and a booking still under negotiation *cannot be paid* — exactly the behaviour we want, for free.
- `transition_booking` is the single validated writer for status (invariant #4); Step 8 removed the client's entrances into `disputed` for precisely this reason.
- INSERT on bookings is now column-restricted (migration `20260803120000`), so a client cannot assert price or state.

---

## Three decisions that differ from §5.5 — and why

### 1. No `listings` table yet. Pricing lives on `service_providers`.

§5.5 introduces Listing (provider × category × area × pricing). Today a provider *is* one listing: one category, one rate, one area. A listings table would be a 1:1 wrapper that `bookings.provider_id`, the matching step, and every provider page would have to be rewritten around — a large refactor buying nothing until a provider can offer several categories.

So: `pricing_mode`, `list_price`, `floor_price`, `auto_accept_threshold`, `max_counter_rounds` go on `service_providers`. **Promote to listings when multi-category providers arrive** (Step 11/14) — the offer table keys on `booking_id`, so that migration won't touch the negotiation logic.

### 2. 🔴 The floor price is the security headline

`floor_price` is the provider's reservation price. If a customer can read it — or *infer* it — the mechanism is dead: everyone offers exactly the floor.

Reading is easy to stop (column-level `SELECT` revoke, the Step-7.5 pattern). **Inference is the hard part**, and §5.5 doesn't mention it: repeated offers are a binary search. The defences must be designed in, not bolted on:

- a below-floor offer **auto-declines and ENDS the negotiation** — each probe costs a whole new booking, not a free guess;
- **uniform decline copy** — "Your offer wasn't accepted." Never "below the minimum", never a hint of distance;
- **rounds are capped** (`max_counter_rounds`, default 3);
- **a per-customer/per-provider daily cap** on started negotiations (default 3);
- Step 13 adds lowball-spam as a reputation signal.

And the rule this codebase has learned twice: **a `SECURITY DEFINER` function bypasses column grants**, so no RPC may `RETURN service_providers` or otherwise hand back a composite containing `floor_price`. The offer RPCs return `offers` rows only.

### 3. A failed negotiation must not dent anyone's reputation

`compute_reputation` currently counts every booking with `status <> 'requested'` in its denominator and `status='cancelled'` as cancellations. Left alone, an expired haggle would look like a failed job and **haggling would lower a provider's score** — so providers would switch bargaining off, and the feature dies.

The ops filter must become `status NOT IN ('requested','negotiating','expired')`. One line, but it's load-bearing.

---

## The migration (source of truth)

`supabase/migrations/20260804120000_seva_bargaining.sql`:

```sql
/* Seva — Step 10: structured bargaining v1. Run AFTER 20260803120000. */

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Pricing lives on the provider (see decision 1 — listings are a later promotion).
ALTER TABLE service_providers
  ADD COLUMN IF NOT EXISTS pricing_mode TEXT NOT NULL DEFAULT 'fixed'
    CHECK (pricing_mode IN ('fixed','negotiable')),
  ADD COLUMN IF NOT EXISTS list_price NUMERIC,
  ADD COLUMN IF NOT EXISTS floor_price NUMERIC,
  ADD COLUMN IF NOT EXISTS auto_accept_threshold NUMERIC,
  ADD COLUMN IF NOT EXISTS max_counter_rounds INT NOT NULL DEFAULT 3;

UPDATE service_providers SET list_price = hourly_rate WHERE list_price IS NULL;

-- A floor above the list price, or a threshold below the floor, is nonsense — reject it.
ALTER TABLE service_providers DROP CONSTRAINT IF EXISTS sp_pricing_sane;
ALTER TABLE service_providers ADD CONSTRAINT sp_pricing_sane CHECK (
  (floor_price IS NULL OR list_price IS NULL OR floor_price <= list_price)
  AND (auto_accept_threshold IS NULL OR floor_price IS NULL OR auto_accept_threshold >= floor_price)
);

-- 🔴 floor_price is NEVER granted to a client. The others are public so the offer sheet can
--    show the list price and the customer knows the rules of the game.
GRANT SELECT (pricing_mode, list_price, auto_accept_threshold, max_counter_rounds)
  ON service_providers TO anon, authenticated;
-- The provider may SET their own floor even though they cannot SELECT it from this table —
-- they read their own row through my_provider_profile (definer view), same as the kyc columns.
GRANT UPDATE (pricing_mode, list_price, floor_price, auto_accept_threshold, max_counter_rounds)
  ON service_providers TO authenticated;

-- my_provider_profile is `SELECT *`, expanded at creation — recreate it so the owner can read
-- their new pricing columns. (Third time this has bitten; see Step 9 ADD-B.)
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

-- Nothing is AGREED while it is being negotiated: leave price_agreed NULL so the payment route
-- refuses the booking until an offer is accepted.
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
-- 4) start_negotiation — the ONLY way into 'negotiating'.
CREATE OR REPLACE FUNCTION public.start_negotiation(
  p_provider_id uuid, p_amount numeric, p_service_type text DEFAULT 'one-time',
  p_scheduled_date date DEFAULT NULL, p_scheduled_time time DEFAULT NULL,
  p_duration_hours numeric DEFAULT 2, p_notes text DEFAULT NULL, p_address text DEFAULT NULL
) RETURNS offers LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sp service_providers; b bookings; o offers; v_recent int; v_expiry timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'must be signed in'; END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'offer must be positive'; END IF;

  SELECT * INTO sp FROM service_providers WHERE id = p_provider_id;
  IF NOT FOUND OR sp.status <> 'approved' THEN RAISE EXCEPTION 'provider not available'; END IF;
  IF sp.pricing_mode <> 'negotiable' THEN RAISE EXCEPTION 'this provider has fixed pricing'; END IF;
  IF sp.user_id = auth.uid() THEN RAISE EXCEPTION 'cannot negotiate with yourself'; END IF;

  -- anti-probing: a customer cannot binary-search the floor across fresh bookings
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

  -- auto-accept at or above the threshold
  IF sp.auto_accept_threshold IS NOT NULL AND p_amount >= sp.auto_accept_threshold THEN
    PERFORM public.accept_offer_internal(o.id, 'auto');
    SELECT * INTO o FROM offers WHERE id = o.id;
    RETURN o;
  END IF;

  -- auto-decline below the hidden floor. The negotiation ENDS: a probe costs a booking.
  IF sp.floor_price IS NOT NULL AND p_amount < sp.floor_price THEN
    UPDATE offers SET status='declined', responded_at=now() WHERE id = o.id;
    UPDATE bookings SET status='expired', updated_at=now() WHERE id = b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
    VALUES (b.id, 'negotiating', 'expired', NULL, 'system', '{"reason":"declined"}'::jsonb);
    INSERT INTO notifications (user_id, title, message, type, link) VALUES (
      auth.uid(), 'Offer not accepted',
      -- deliberately uniform: never hint how far below the floor it was
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
-- 5) Acceptance is the ONE writer that locks the price (invariant #4/#5).
CREATE OR REPLACE FUNCTION public.accept_offer_internal(p_offer_id uuid, p_by text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o offers; b bookings; v_provider_user uuid;
BEGIN
  SELECT * INTO o FROM offers WHERE id = p_offer_id FOR UPDATE;
  SELECT * INTO b FROM bookings WHERE id = o.booking_id FOR UPDATE;
  SELECT user_id INTO v_provider_user FROM service_providers WHERE id = b.provider_id;

  UPDATE offers SET status='accepted', responded_at=now() WHERE id = o.id;
  -- THE PRICE LOCKS HERE, server-side. Never client-asserted.
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

-- 6) respond_offer — accept / counter / decline, by whoever's turn it is.
CREATE OR REPLACE FUNCTION public.respond_offer(
  p_booking_id uuid, p_action text, p_amount numeric DEFAULT NULL
) RETURNS offers LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b bookings; sp service_providers; o offers; v_role text; v_next offers;
BEGIN
  IF p_action NOT IN ('accept','counter','decline') THEN RAISE EXCEPTION 'invalid action'; END IF;
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR b.status <> 'negotiating' THEN RAISE EXCEPTION 'this booking is not under negotiation'; END IF;
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
    RETURN o;
  END IF;

  UPDATE offers SET status='countered', responded_at=now() WHERE id = o.id;
  INSERT INTO offers (booking_id, round, made_by, actor_role, amount, expires_at)
  VALUES (b.id, o.round + 1, auth.uid(), v_role, p_amount, now() + interval '24 hours')
  RETURNING * INTO v_next;

  -- a provider's counter at or below the customer's own last offer is an accept in disguise
  IF v_role = 'provider' AND sp.auto_accept_threshold IS NOT NULL
     AND p_amount <= o.amount THEN
    PERFORM public.accept_offer_internal(v_next.id, 'auto');
    SELECT * INTO v_next FROM offers WHERE id = v_next.id;
  END IF;
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
--    Byte-identical to the Step-8 version except the ops denominators, which now exclude
--    'negotiating' and 'expired' — a negotiation that went nowhere is not a failed job.
--    (Re-declare compute_reputation with:
--       WHERE ... AND b.status NOT IN ('requested','negotiating','expired')
--     in BOTH the provider and customer branches, and in dispute_fault_rate.)
```

---

## App wiring

**Provider — pricing controls.** On `/become-provider` (their home), a "Pricing" card: mode (fixed / negotiable), list price, **floor price (private — "customers never see this")**, auto-accept threshold, max rounds. Read the current values from `my_provider_profile`; write with a plain column UPDATE (the grants allow exactly these five).

**Customer — the offer path.** On `/providers/[id]`, when `pricing_mode='negotiable'`, show **"Make an offer"** beside **"Book at ₹X"**. The sheet shows the list price, an amount input, and the rules in plain words: *"One offer. If they counter, you'll get a notification. Offers expire in 24 hours."* Calls `start_negotiation`.

**Both — the negotiation panel** on `/bookings/[id]` when `status='negotiating'`: the round history (amounts, who, when), whose turn it is, the expiry countdown, and Accept / Counter / Decline buttons wired to `respond_offer`. Disabled when it isn't your turn.

**After acceptance nothing changes** — the booking is `accepted` with `price_agreed` locked, and the existing Razorpay flow charges exactly that.

---

## Gotchas / decisions baked in

- **Never return `floor_price` from an RPC.** A `SECURITY DEFINER` function bypasses column grants — this codebase has been bitten twice (Step 9's category hole, `provider_missing_documents`). The offer RPCs return `offers` rows, never a `service_providers` composite.
- **Uniform rejection copy.** "Your offer wasn't accepted." Any phrasing that leaks distance-to-floor turns the mechanism into a game of Twenty Questions.
- **A below-floor offer ends the negotiation** rather than inviting another guess, and there's a 3-per-day cap per provider. Together they make binary search expensive.
- **`price_agreed` stays NULL while negotiating**, so `/api/payments/create-order` already refuses to charge for an unagreed booking — no payment changes needed.
- **One writer per state.** `start_negotiation` is the only entrance to `negotiating`; `accept_offer_internal` the only path to `accepted` from it. Do **not** add `negotiating` to `transition_booking`'s allowed transitions — that's the Step-8 DEV-D mistake.
- **Expired ≠ cancelled.** Reputation must ignore `negotiating` and `expired` entirely.
- **Not now:** RFQ / competing quotes and reputation-linked negotiating power are Step 14; lowball-spam and bait-and-switch detection are Step 13.

---

## Definition of done

- A provider can mark themselves **negotiable**, set a list price, a **private** floor and an auto-accept threshold — and a customer, anon or otherwise, **cannot read the floor by any route** (column grant, RPC return, or embedded select).
- A customer sees **"Book at ₹X"** unchanged, with **"Make an offer"** beside it only for negotiable providers.
- An offer **at or above the threshold auto-accepts**; one **below the floor is declined in identical language** and ends the negotiation; anything between notifies the provider to accept, counter or decline.
- Counters are **capped** by `max_counter_rounds` and each offer **expires in 24 hours**; the sweep closes abandoned ones.
- On acceptance the price **locks into `price_agreed`**, and the existing escrow flow charges exactly that — a booking under negotiation cannot be paid.
- A failed negotiation leaves **both reputations untouched**.
- `npm run typecheck`, `npm run build`, and `node scripts/verify-all.mjs` all pass.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read CLAUDE.md, /docs/Seva-Architecture.md §5.5 and /docs/Seva-Step-10.md (this
spec) first. Steps 1–9.5 are committed; scripts/verify-all.mjs is green (313 passed).

Build Step 10 EXACTLY as specified in /docs/Seva-Step-10.md:
1. Migration supabase/migrations/20260804120000_seva_bargaining.sql as written — pricing columns
   on service_providers (floor_price NOT granted), the recreated my_provider_profile, the
   'negotiating' status, the price_agreed trigger change, the offers table, start_negotiation,
   accept_offer_internal, respond_offer, expire_stale_offers, and the compute_reputation ops
   filter change.
2. Provider pricing controls on /become-provider (read via my_provider_profile).
3. "Make an offer" beside "Book at ₹X" on /providers/[id], negotiable providers only.
4. The negotiation panel on /bookings/[id] — round history, whose turn, expiry, accept/counter/
   decline.
5. Types in lib/supabase.ts.

Do NOT:
- Return floor_price from any RPC, view or select — not even to the provider's own client except
  through my_provider_profile.
- Reveal how far below the floor a declined offer was, in copy or in an error message.
- Add 'negotiating' to transition_booking's allowed transitions (Step-8 DEV-D: one writer).
- Build RFQ, competing quotes or reputation-linked thresholds — that's Step 14.

Done when: the Definition of done in /docs/Seva-Step-10.md holds, verify-all.mjs is green, and
scripts/verify-step10.mjs asserts: floor_price unreadable by client/anon/RPC; auto-accept above
threshold; identical decline for below-floor; round cap and expiry; agreed price locks into
price_agreed and escrow charges exactly it; an expired negotiation moves neither reputation.
```
