# Seva — Playbook Step 8: Disputes & Admin Console

> Step 8 of `/docs/Seva-Claude-Code-Playbook.md` (architecture §7.2). Read `CLAUDE.md` first. This is where trust gets **teeth**: escrow gives you the money to hold, chat + `booking_events` give you the evidence, and reputation gives you the consequence. Do this after Step 7 is committed.

---

## Where you are (grounded in the current repo)

- **No `disputes` table** — greenfield.
- **`disputed` already exists** in the state machine, reachable from `arrived`, `in_progress`, `completed`, `confirmed`.
- **`profiles.role` supports `'admin'`**, and `role` is **not** client-writable (Step 1 column grants) — so `role='admin'` is already server-controlled and safe to trust. But **no admin account exists and there is no admin UI.**
- The **refund route** (`/api/payments/refund`) exists, is customer-or-admin, and works only on a `held` booking.
- `booking_events.actor_role` already permits `'admin'` — resolutions can be stamped correctly.
- The reputation engine already reads a dispute rate into its operational component.

## Two problems this step must fix (both are real, found by reading the code)

**1. 🔴 `disputed` is a dead end.** `transition_booking` allows entering `disputed` but has **no transition out of it**. A disputed booking is permanently stuck — money frozen in escrow, no resolution possible. Step 8 must add admin-driven exits.

**2. 🔴 Raising a dispute currently penalizes *both* parties' reputation.** `compute_reputation` counts `bookings.status='disputed'` against **both** the provider and the customer, at −3 weight. So **a malicious customer can damage an honest provider's reputation simply by filing a dispute** — no adjudication required. That is exactly the reputation-attack vector Seva is supposed to be immune to. The fix: **penalty follows *fault*, decided at resolution** — not the mere existence of a dispute. An exonerated party takes no hit; the party at fault does, permanently.

---

## Design

**Dispute lifecycle:** `open → under_review → resolved` (with `outcome` + `fault_party`).

**Outcomes** (each drives money *and* reputation):

| Outcome | Money | Fault |
|---|---|---|
| `favor_customer` | refund customer | provider |
| `favor_provider` | release escrow to provider | customer |
| `partial` | partial refund, remainder released | none (split) |
| `no_fault` | release to provider | none |

**Money on resolution** — two cases, and the second is the tricky one:
- `payment_status='held'` (the normal case — disputes from `arrived`/`in_progress`/`completed`): call the existing refund path, or release. Clean.
- `payment_status='released'` (a dispute from `confirmed` — the escrow release trigger has already paid the provider's wallet): resolution must **claw back** via `credit_wallet(..., 'debit', ...)` before refunding. ⚠️ The provider may have already spent it — Step 8 permits the debit and flags a negative balance for admin follow-up. Don't over-engineer; note it and move on.

---

## The migration (source of truth)

`supabase/migrations/20260728120000_seva_disputes.sql`:

```sql
/* Seva — Step 8: disputes + admin console. Run AFTER Step 7. */

-- 1) is_admin(): SECURITY DEFINER so policies can check role without recursing into profiles RLS.
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
CREATE OR REPLACE FUNCTION public.resolve_dispute(
  p_dispute_id uuid, p_outcome text, p_fault text, p_notes text DEFAULT NULL,
  p_refund_amount numeric DEFAULT NULL
) RETURNS disputes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d disputes; b bookings; v_provider_user uuid; v_amount numeric; v_next text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  SELECT * INTO d FROM disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispute not found'; END IF;
  IF d.status = 'resolved' THEN RAISE EXCEPTION 'already resolved'; END IF;

  SELECT * INTO b FROM bookings WHERE id = d.booking_id FOR UPDATE;
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  v_amount := COALESCE(b.price_charged, b.price_agreed, b.total_amount);

  -- Money. NOTE: the actual Razorpay refund is issued by the admin API route AFTER this
  -- returns (Postgres can't call Razorpay); this records intent + wallet effects.
  IF p_outcome IN ('favor_customer','partial') AND b.payment_status = 'released' THEN
    -- clawback: escrow was already released to the provider's wallet
    PERFORM public.credit_wallet(v_provider_user, COALESCE(p_refund_amount, v_amount), 'debit',
            'Dispute clawback for booking ' || b.id::text, b.id);
  END IF;

  v_next := CASE WHEN p_outcome = 'favor_customer' THEN 'cancelled' ELSE 'paid' END;
  UPDATE bookings SET
    status = v_next,
    payment_status = CASE WHEN p_outcome IN ('favor_customer','partial') THEN 'refunded'
                          ELSE 'released' END,
    updated_at = NOW()
  WHERE id = b.id;

  UPDATE disputes SET status='resolved', outcome=p_outcome, fault_party=p_fault,
    refund_amount=p_refund_amount, resolution_notes=p_notes,
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
```

Then **update `compute_reputation`** (CREATE OR REPLACE, in the same migration) so its operational component uses `public.dispute_fault_rate(p_subject_type, p_subject_id)` **instead of** the `status='disputed'` count, keeping everything else identical. Record it in the breakdown as `dispute_fault_rate`.

---

## App wiring

**Party side — `app/bookings/[id]/page.tsx`:** a **"Report a problem"** action for either party when the booking is in a disputable state → a small form (reason dropdown + description) → `supabase.rpc('raise_dispute', …)`. When a dispute exists, show its status banner (Open / Under review / Resolved + outcome) instead of the normal actions.

**Admin console (new, `role='admin'` only):**
- `app/admin/disputes/page.tsx` — queue of open/under-review disputes (booking, parties, reason, age, amount held).
- `app/admin/disputes/[id]/page.tsx` — **the evidence bundle**: booking summary, agreed vs charged price, the full `booking_events` timeline with timestamps (who did what, when — this is where "he never arrived" is settled), the complete chat thread, payment/ledger state, and both parties' reputation. Then a resolution panel: outcome + fault + notes + optional partial amount → `resolve_dispute`, and for money that needs a real Razorpay refund, the admin API route.
- Guard every admin page: redirect non-admins. Add an "Admin" nav link only when `role='admin'`.

**Admin refund route:** extend `/api/payments/refund` (or add `/api/admin/dispute-refund`) so an admin can refund as part of resolution, including the partial amount.

**Creating your first admin** (there is none). In the Supabase SQL editor:
```sql
UPDATE profiles SET role = 'admin' WHERE id = (SELECT id FROM auth.users WHERE email = 'you@example.com');
```

---

## Gotchas / decisions baked in

- **Fault-based reputation is the headline fix.** Merely being disputed must not hurt you; being found *at fault* must. This closes the "frivolous dispute as a weapon" hole.
- **`disputed` is no longer a dead end** — `resolve_dispute` is the only exit, and only an admin can call it.
- **Admin reads via additive RLS policies** (not service-role everywhere) is safe *because* `role` is not client-writable. Keep it that way — never grant `role` to client updates.
- **Postgres can't call Razorpay** — the RPC records the money decision and wallet effects; the actual refund API call happens in the admin route. Keep them adjacent and idempotent.
- **The evidence bundle is the product.** You already store chat, timestamps, and prices *because* everything happens on-platform — this page is where that investment pays off. Make the timeline readable.
- COD stays deferred; two-sided cash confirmation is still out of scope.

---

## Definition of done

- Either party can raise a dispute on a disputable booking; a second open dispute on the same booking is rejected; a non-party is rejected.
- The booking moves to `disputed`, both sides are notified, and a `booking_events` row records it.
- An **admin** can see the full evidence bundle (booking, timeline, chat, payments, reputations) for any dispute; a non-admin **cannot** (no admin pages, no cross-booking reads).
- `resolve_dispute` is **admin-only** (a party calling it is rejected), records outcome + fault + notes, exits `disputed`, moves money correctly (including wallet clawback when already released), and notifies both parties.
- **Reputation follows fault:** a provider exonerated in a dispute takes **no** reputation hit; one found at fault does. Same for customers. Verify by comparing scores before/after resolution in both directions.
- `npm run typecheck` and `npm run build` pass.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read /docs/Seva-Architecture.md (§7.2) and CLAUDE.md first.
We are on Playbook Step 8: disputes + admin console. Step 7 is committed.

Read these first, then propose a short plan and WAIT for my OK before editing:
- CLAUDE.md and /docs/Seva-Step-8.md (this spec — the source of truth)
- supabase/migrations/20260711120000_seva_booking_state_machine.sql (disputed transitions; note
  there is NO exit from 'disputed')
- supabase/migrations/20260726120000_seva_reputation_engine.sql (compute_reputation — its ops
  component currently counts status='disputed' against BOTH parties; this must become fault-based)
- supabase/migrations/20260712120000_seva_booking_chat.sql (is_booking_party helper to reuse)
- app/api/payments/refund/route.ts (existing admin-or-customer refund)
- app/bookings/[id]/page.tsx, lib/bookings.ts, lib/supabase.ts

Build:
1. Migration supabase/migrations/20260728120000_seva_disputes.sql EXACTLY as in
   /docs/Seva-Step-8.md: is_admin() helper; disputes table (+ partial unique index for one open
   dispute per booking, RLS: parties or admin read, RPC-only writes); additive admin SELECT
   policies on bookings/messages/booking_events/payment_transactions; raise_dispute RPC;
   resolve_dispute RPC (admin-only, money incl. wallet clawback when already released, exits
   'disputed', notifies both, recomputes reputation); dispute_fault_rate(); and CREATE OR REPLACE
   compute_reputation so its ops component uses dispute_fault_rate INSTEAD of the
   status='disputed' count — everything else in that function identical.
2. app/bookings/[id]/page.tsx: a "Report a problem" flow for either party (reason + description →
   raise_dispute), and a dispute status banner when one exists.
3. Admin console, role='admin' only, non-admins redirected:
   - app/admin/disputes/page.tsx — the queue.
   - app/admin/disputes/[id]/page.tsx — the EVIDENCE BUNDLE (booking summary, agreed vs charged,
     full booking_events timeline with timestamps, the whole chat thread, payment/ledger state,
     both reputations) + a resolution panel calling resolve_dispute.
   - Show an Admin nav link only for admins.
4. Extend the refund path so an admin can issue the real Razorpay refund (incl. partial) as part
   of resolution.
5. Types for Dispute in lib/supabase.ts.

Do NOT (later steps):
- Fraud/anomaly detection (Step 13), ranking/matching (Step 11), tiers (Step 15), COD.
- Change escrow mechanics, the review/reveal rules, or the star-average rating.

Done when:
- Either party can dispute a disputable booking; second open dispute rejected; non-party rejected;
  booking → 'disputed' with an event + notifications to both.
- Admin sees the full evidence bundle; a non-admin cannot reach admin pages or read others' data.
- resolve_dispute is admin-only, records outcome+fault, exits 'disputed', moves money correctly
  (including clawback when payment_status was already 'released'), notifies both.
- Reputation follows FAULT: an exonerated provider takes no hit; one found at fault does; same for
  customers. Demonstrate with before/after scores.
- npm run typecheck and npm run build pass.

I'll apply the migration via supabase db push and promote one account to admin. After I confirm,
add scripts/verify-step8.mjs asserting all of the above — especially the fault-based reputation
comparison in both directions, and that a party (non-admin) calling resolve_dispute is rejected.

Finish by reporting exactly what you changed and how you verified each "Done when" item.
```
