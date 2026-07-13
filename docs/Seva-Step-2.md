# Seva — Playbook Step 2: The Booking State Machine

> Step 2 of `/docs/Seva-Claude-Code-Playbook.md` (architecture §4). Read `CLAUDE.md` first — this step exists mainly to satisfy **invariant #4** (status changes go through ONE server-side transition function, never ad-hoc client writes). Do this **after** Step 1 is committed.

---

## Where you are (grounded in the current repo)

From the live schema:

- `bookings.status` is `TEXT DEFAULT 'pending' CHECK (status IN ('pending','confirmed','in_progress','completed','cancelled'))` — a **CHECK constraint**, not an enum. Change it by dropping `bookings_status_check` and adding a new one.
- **`update_own_booking` lets the customer *and* the provider UPDATE the row directly** — so today the browser can write any `status` it likes. This is the invariant-#4 hole Step 2 closes.
- Bookings are inserted with the default status (Step 1 wired the "Confirm & Pay" button to a real insert). There is **no event log**, and price is a single `total_amount` — no agreed-vs-charged split.
- Existing SECURITY DEFINER triggers already set the pattern for legitimate server-side writes (`handle_new_user`, `create_provider_working_hours`, `update_provider_rating`). The transition function follows the same pattern.

## What this step changes (5 things)

1. Expand `status` to the real lifecycle: `requested → accepted → en_route → arrived → in_progress → completed → confirmed → paid → reviewed` (+ `cancelled`, `disputed`, `expired`).
2. Add a **`booking_events`** table — one timestamped row per transition (this is what later powers punctuality/response-time reputation).
3. Add **`price_agreed`** (locked at booking) and **`price_charged`** (set when the customer confirms).
4. Add **one** `transition_booking()` RPC (SECURITY DEFINER) that authorizes the caller, validates the transition, stamps the event, and updates the row — and **lock direct status writes** via column-level grants so the RPC is the only path.
5. Wire the UI: provider advances the job (Accept → En route → Arrived → Start → Complete); customer Confirms / Cancels; both see a provider-side and customer-side view.

---

## The migration (source of truth)

`supabase/migrations/20260711120000_seva_booking_state_machine.sql` — run after all Step 1 migrations:

```sql
/* Seva — Booking state machine. Run AFTER the Step 1 migrations. */

-- 1) PRICE: agreed (locked at booking) vs charged (set at customer-confirm).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_agreed  NUMERIC;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_charged NUMERIC;
UPDATE bookings SET price_agreed = NULLIF(total_amount, 0) WHERE price_agreed IS NULL;

CREATE OR REPLACE FUNCTION public.set_booking_price_agreed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price_agreed IS NULL THEN
    NEW.price_agreed := COALESCE(NULLIF(NEW.total_amount, 0),
                                 NEW.hourly_rate * COALESCE(NEW.duration_hours, 1));
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_set_price_agreed ON bookings;
CREATE TRIGGER trg_set_price_agreed BEFORE INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION public.set_booking_price_agreed();

-- 2) STATUS: expand the lifecycle. Remap legacy values, then swap the CHECK + default.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
UPDATE bookings SET status = 'requested' WHERE status = 'pending';
UPDATE bookings SET status = 'accepted'  WHERE status = 'confirmed';  -- old 'confirmed' meant provider-accepted
ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'requested';
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'requested','accepted','en_route','arrived','in_progress',
  'completed','confirmed','paid','reviewed','cancelled','disputed','expired'
));

-- 3) EVENTS: one timestamped row per transition. Written ONLY by the RPC below.
CREATE TABLE IF NOT EXISTS booking_events (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id  UUID REFERENCES bookings(id) ON DELETE CASCADE NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    UUID REFERENCES auth.users(id),
  actor_role  TEXT CHECK (actor_role IN ('customer','provider','system','admin')),
  meta        JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_events_booking ON booking_events(booking_id);
ALTER TABLE booking_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_booking_events" ON booking_events;
CREATE POLICY "select_own_booking_events" ON booking_events FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM bookings b WHERE b.id = booking_events.booking_id
    AND (b.customer_id = auth.uid()
         OR auth.uid() IN (SELECT user_id FROM service_providers WHERE id = b.provider_id))
));
-- no INSERT/UPDATE/DELETE policy → clients can't write events; the definer RPC bypasses RLS.
REVOKE INSERT, UPDATE, DELETE ON booking_events FROM authenticated, anon;

-- 4) LOCK direct status writes (same column-grant pattern as Step 1).
--    Clients may still edit descriptive fields; status/price/payment move only via the RPC.
REVOKE UPDATE ON bookings FROM authenticated;
GRANT  UPDATE (notes, address, scheduled_date, scheduled_time) ON bookings TO authenticated;

-- 5) The ONE transition function. SECURITY DEFINER so it can write locked columns,
--    but it authorizes the caller and validates every transition internally.
CREATE OR REPLACE FUNCTION public.transition_booking(
  p_booking_id    uuid,
  p_next_status   text,
  p_price_charged numeric DEFAULT NULL,
  p_meta          jsonb   DEFAULT '{}'::jsonb
) RETURNS bookings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b               bookings;
  v_from          text;
  v_role          text;
  v_provider_user uuid;
  v_allowed       boolean := false;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking not found'; END IF;
  v_from := b.status;

  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  IF    auth.uid() = b.customer_id   THEN v_role := 'customer';
  ELSIF auth.uid() = v_provider_user THEN v_role := 'provider';
  ELSE  RAISE EXCEPTION 'not authorized for this booking';
  END IF;

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
    -- STUB until Step 5 (escrow): customer "marks paid". Step 5 replaces this with the webhook.
    WHEN v_from='confirmed'   AND p_next_status='paid'        AND v_role='customer' THEN true
    WHEN v_from='confirmed'   AND p_next_status='disputed'    AND v_role='customer' THEN true
    ELSE false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'illegal transition % -> % for role %', v_from, p_next_status, v_role;
  END IF;

  UPDATE bookings SET
    status         = p_next_status,
    price_charged  = CASE WHEN p_next_status='confirmed'
                          THEN COALESCE(p_price_charged, price_charged, price_agreed, total_amount)
                          ELSE price_charged END,
    payment_status = CASE WHEN p_next_status='paid' THEN 'paid' ELSE payment_status END,
    updated_at     = NOW()
  WHERE id = p_booking_id
  RETURNING * INTO b;

  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (p_booking_id, v_from, p_next_status, auth.uid(), v_role, COALESCE(p_meta, '{}'::jsonb));

  RETURN b;
END; $$;

GRANT EXECUTE ON FUNCTION public.transition_booking(uuid, text, numeric, jsonb) TO authenticated;
```

Call it from the client as `supabase.rpc('transition_booking', { p_booking_id, p_next_status })`.

---

## App wiring (what Claude Code changes in code)

- **Booking creation** (`app/providers/[id]/page.tsx`): no change needed to status (default is now `requested`); the trigger fills `price_agreed`. Optionally show "Requested — waiting for provider to accept".
- **`app/bookings/page.tsx`** — this currently shows only the customer's bookings and has stubbed Cancel/Review buttons. It needs to:
  - **Show the right set by role.** Keep customer bookings (`customer_id = me`); if the signed-in user owns a provider profile, also show a provider view of incoming bookings (their RLS already permits it) — a tab or two sections.
  - **Render status-appropriate action buttons** that call `transition_booking`:
    - *Provider*: `requested → Accept`, `accepted → Start travel`, `en_route → Arrived`, `arrived → Start work`, `in_progress → Mark complete`.
    - *Customer*: `completed → Confirm done`, `confirmed → Mark paid` (stub label, e.g. "Mark as paid (cash)"), and `Cancel` where allowed.
  - **Extend the status config** (badges/colors/labels) to the new statuses. The old config only knows 5.
  - Leave **Write Review** stubbed — it arrives in Step 6.
- **Do NOT** call `.update({ status })` anywhere — the column grant now rejects it. All status movement is `supabase.rpc('transition_booking', …)`.

---

## Gotchas / decisions baked in

- **Legacy remap:** old `pending→requested`, old `confirmed→accepted` (old "confirmed" meant *provider accepted*; the new `confirmed` means *customer confirms completion*). The migration remaps before adding the new constraint.
- **`paid` is a deliberate stub** here (customer "marks paid") so the happy path completes end-to-end. Step 5 (escrow) takes ownership of `paid` via the Razorpay webhook and will remove the client-callable path.
- **Step 1's review gate still checks `status='completed'`**, which is still a valid state, so nothing breaks. Step 6 tightens it to *completed + paid*.
- **Column grants are the enforcement**, not just the RPC: even though `update_own_booking` still allows the row, the client has no `UPDATE` privilege on `status`, so a direct write fails with "permission denied for column status." That's intended.

---

## Definition of done

- A booking walks the full happy path **only via the RPC**: requested → accepted → en_route → arrived → in_progress → completed → confirmed → paid, with the provider driving up to `completed` and the customer doing `confirmed`/`paid`.
- Every transition writes a `booking_events` row with `from_status`, `to_status`, `actor_role`, and a timestamp.
- Illegal jumps are rejected (e.g. `requested → completed`, or a customer trying to `accept`, or a stranger calling the RPC).
- A direct `supabase.from('bookings').update({ status: 'completed' })` from the browser **fails** (permission denied on column `status`).
- `price_charged` is set (from `price_agreed`) when the customer confirms.
- `npm run typecheck` and `npm run build` pass.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read /docs/Seva-Architecture.md (§4) and CLAUDE.md first.
We are on Playbook Step 2: The Booking state machine. Step 1 is committed.

Read these files first, then propose a short plan and WAIT for my OK before editing:
- CLAUDE.md (esp. invariant #4) and /docs/Seva-Step-2.md (this spec — the source of truth)
- supabase/migrations/20260622131542_seva_initial_schema.sql (bookings table, status CHECK,
  the update_own_booking policy, the existing SECURITY DEFINER trigger pattern)
- app/bookings/page.tsx (customer list + stubbed Cancel/Review buttons)
- app/providers/[id]/page.tsx (the booking insert)
- lib/supabase.ts (types) and lib/auth-context.tsx (how to get the current user + provider id)

Build:
1. Add migration supabase/migrations/20260711120000_seva_booking_state_machine.sql exactly
   as specified in /docs/Seva-Step-2.md: price_agreed/price_charged + set_booking_price_agreed
   trigger; expand the status CHECK (with the legacy remap) and change the default to
   'requested'; booking_events table + its SELECT-only RLS; revoke UPDATE on bookings and
   re-grant only (notes, address, scheduled_date, scheduled_time); and the transition_booking
   SECURITY DEFINER RPC with the transition/authorization rules given.
2. Rewire app/bookings/page.tsx: show customer bookings, and if the user owns a provider
   profile, also a provider view of their incoming bookings; render status-appropriate action
   buttons that call supabase.rpc('transition_booking', { p_booking_id, p_next_status }); extend
   the status badge/label config to all new statuses. Keep "Write Review" stubbed (Step 6).
3. Ensure NOTHING calls supabase.from('bookings').update({ status }) — all status changes go
   through the RPC.

Do NOT touch (later steps):
- Razorpay / real payments / escrow — 'paid' stays the customer-"mark paid" stub (Step 5)
- Reviews and reputation math (Steps 6/7/12)
- Chat/messages (Step 3), notifications delivery (Step 4), bargaining (Step 10)
- PostGIS matching (Step 11)

Done when:
- A booking walks requested→accepted→en_route→arrived→in_progress→completed→confirmed→paid,
  driven by the correct role at each step, ONLY via transition_booking.
- Every transition inserts a booking_events row (from/to/actor_role/timestamp).
- Illegal transitions and wrong-role calls are rejected; a stranger calling the RPC is rejected.
- A direct browser bookings.update({ status }) fails with permission denied on column status.
- price_charged is set from price_agreed on customer-confirm.
- npm run typecheck and npm run build pass.

I will apply the migration myself via the Supabase SQL Editor (you can't push DDL). After I
apply it, add a short scripts/verify-step2.mjs that (as a logged-in customer and provider)
walks a booking through the happy path via the RPC, asserts a booking_events row per step,
and asserts a direct status update is denied.

Finish by reporting exactly what you changed (files + migration) and how you verified each
"Done when" item.
```
