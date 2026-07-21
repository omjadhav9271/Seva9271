# Seva — Playbook Step 5: Razorpay Escrow (the careful one)

> Step 5 of `/docs/Seva-Claude-Code-Playbook.md` (architecture §8). Read `CLAUDE.md` first — this step upgrades **invariant #2 (money server-only)** and **#5 (money moves only via escrow)** from "locked down" to "actually implemented." **Every rupee in this step is Razorpay TEST mode. No real money until you deliberately decide to go live.**

---

## Read this boundary first — what's real vs deferred

- **REAL (test mode):** customer pays via Razorpay Checkout → funds captured into your **platform** account → held in escrow → on customer-confirm, the provider's **in-app wallet** is credited (price minus platform fee) → refunds work.
- **DEFERRED (Step 9+ / when you register a business):** real **bank payout** to providers via Razorpay Route linked accounts / RazorpayX. That needs per-provider KYC (Step 9) and your business onboarding. Until then, "provider gets paid" = wallet balance; withdrawing to a bank is future. **Providers are not receiving real money in this step.**

This keeps Step 5 shippable and honest: real capture in, escrow + settlement modeled correctly, cash-out later.

---

## Where you are (grounded in the current repo)

- `transition_booking` still has the **customer `confirmed → paid` stub** (this step deletes it).
- `bookings.payment_status` CHECK is `('pending','paid','refunded')`; `payment_method` is `('wallet','upi','cod')`.
- `wallet_transactions` `(user_id, type ['credit'|'debit'|'reward'], amount, description, reference_id)` — **no client write policy** (Step 1). First writer will be this step's server-only RPC.
- `is_booking_party(uuid)` helper exists (Step 3) — reuse it for payment RLS.
- **No `app/api`** — server routes are greenfield. Razorpay not installed.

## What this step adds

1. **New server infrastructure**: `app/api` route handlers (the first server-side code), a **server-only** Supabase client using the service-role key, and the Razorpay SDK.
2. A **`payment_transactions`** ledger + an expanded `payment_status` track: `pending → held → released | refunded`.
3. Three routes: **create-order**, **webhook** (the only thing that can mark money `held`), **refund**.
4. A **server-only `credit_wallet` RPC** (finally implements the Step-1 lockdown) and a **release-on-confirm** trigger that pays the provider's wallet minus the platform fee.
5. Removal of the client `paid` stub — `paid` is now **system-only**.

---

## The money model

`booking.payment_status`: **pending** (nothing captured) → **held** (customer paid; funds in platform escrow) → **released** (provider credited) | **refunded** (returned to customer).

Flow (online): provider accepts → customer pays (**held**, set by webhook only) → job proceeds → customer confirms → **release trigger** credits provider wallet, sets **released**, moves booking to **paid** (system). Cash (`cod`) bookings skip escrow: on confirm the trigger just settles to **paid**.

```
create-order (server, amount from DB)  ─▶ Razorpay Checkout (client)
        │                                        │
        ▼                                        ▼ payment.captured
  payment_transactions(created)          webhook (verify signature)
                                                 │ idempotent
                                                 ▼
                                   payment_status = 'held'  ◀── ONLY here
        ... booking proceeds ...
  customer confirms ─▶ release trigger ─▶ credit_wallet(provider, price−fee)
                                          payment_status='released', booking→'paid'
  dispute/cancel while held ─▶ refund route ─▶ Razorpay refund ─▶ 'refunded'
```

---

## The migration (source of truth)

`supabase/migrations/20260718120000_seva_payments_escrow.sql` — run after all Step 4 migrations. Platform fee is a single constant (`0.15` = 15%); change it in one place.

```sql
/* Seva — Step 5: payments + escrow. Run AFTER the Step 4 migrations.
   All amounts are INR. Platform fee = 15% (edit v_fee_pct below to change). */

-- 1) Expand the payment_status track. Remap the old 'paid' stub value first.
UPDATE bookings SET payment_status = 'released' WHERE payment_status = 'paid';
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('pending','held','released','refunded','failed'));

-- 2) The payment ledger. Written ONLY by the server (service role) — never a client.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id          UUID REFERENCES bookings(id) ON DELETE CASCADE NOT NULL,
  razorpay_order_id   TEXT UNIQUE NOT NULL,
  razorpay_payment_id TEXT UNIQUE,
  amount              NUMERIC NOT NULL,
  currency            TEXT DEFAULT 'INR',
  status              TEXT DEFAULT 'created'
                        CHECK (status IN ('created','captured','released','refunded','failed')),
  platform_fee        NUMERIC,
  provider_amount     NUMERIC,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_paytx_booking ON payment_transactions(booking_id);
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_payment_tx" ON payment_transactions;
CREATE POLICY "select_own_payment_tx" ON payment_transactions FOR SELECT TO authenticated
USING (public.is_booking_party(booking_id));
REVOKE INSERT, UPDATE, DELETE ON payment_transactions FROM authenticated, anon;

-- 3) Server-only wallet credit. This is the ONLY writer of wallet_transactions + wallet_balance.
CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_user_id uuid, p_amount numeric, p_type text, p_description text, p_reference_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO wallet_transactions (user_id, type, amount, description, reference_id)
  VALUES (p_user_id, p_type, p_amount, p_description, p_reference_id);
  UPDATE profiles SET wallet_balance = COALESCE(wallet_balance,0)
    + CASE WHEN p_type = 'debit' THEN -p_amount ELSE p_amount END
  WHERE id = p_user_id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.credit_wallet(uuid,numeric,text,text,uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet(uuid,numeric,text,text,uuid) TO service_role;

-- 4) Release escrow when the customer confirms. Fires only on 'confirmed' (WHEN clause avoids
--    recursion from the 'paid' event it inserts). SECURITY DEFINER can call credit_wallet.
CREATE OR REPLACE FUNCTION public.release_escrow_on_confirm()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b bookings; v_provider_user uuid; v_amount numeric; v_fee numeric; v_payout numeric;
  v_fee_pct constant numeric := 0.15;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = NEW.booking_id FOR UPDATE;
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  v_amount := COALESCE(b.price_charged, b.price_agreed, b.total_amount);

  IF b.payment_status = 'held' THEN
    v_fee    := round(v_amount * v_fee_pct, 2);
    v_payout := v_amount - v_fee;
    PERFORM public.credit_wallet(v_provider_user, v_payout, 'credit',
              'Payout for booking ' || b.id::text, b.id);
    UPDATE payment_transactions SET status='released', provider_amount=v_payout,
              platform_fee=v_fee, updated_at=NOW()
      WHERE booking_id = b.id AND status = 'captured';
    UPDATE bookings SET payment_status='released', status='paid', updated_at=NOW() WHERE id=b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
      VALUES (b.id, 'confirmed', 'paid', NULL, 'system',
              jsonb_build_object('payout', v_payout, 'fee', v_fee));
  ELSIF b.payment_method = 'cod' THEN
    UPDATE bookings SET status='paid', updated_at=NOW() WHERE id=b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
      VALUES (b.id, 'confirmed', 'paid', NULL, 'system', jsonb_build_object('cash', true));
  END IF;  -- online-but-unpaid: stays 'confirmed' until a webhook marks it held
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_release_escrow ON booking_events;
CREATE TRIGGER trg_release_escrow AFTER INSERT ON booking_events
FOR EACH ROW WHEN (NEW.to_status = 'confirmed')
EXECUTE FUNCTION public.release_escrow_on_confirm();

-- 5) Remove the client 'paid' stub from transition_booking. 'paid' is now system-only.
--    (Full function re-declared with the confirmed→paid line and payment_status write removed.)
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
    WHEN v_from='arrived'     AND p_next_status='disputed'                           THEN true
    WHEN v_from='in_progress' AND p_next_status='completed'   AND v_role='provider' THEN true
    WHEN v_from='in_progress' AND p_next_status='disputed'                           THEN true
    WHEN v_from='completed'   AND p_next_status='confirmed'   AND v_role='customer' THEN true
    WHEN v_from='completed'   AND p_next_status='disputed'    AND v_role='customer' THEN true
    WHEN v_from='confirmed'   AND p_next_status='disputed'    AND v_role='customer' THEN true
    ELSE false   -- NOTE: confirmed→paid is GONE; release_escrow_on_confirm handles 'paid'.
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'illegal transition % -> % for role %', v_from, p_next_status, v_role;
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
```

---

## New environment variables (server-only unless noted)

Add to `.env.local` (and **never** commit — confirm `.gitignore` covers it):
```
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_xxx      # public: used by Checkout on the client
RAZORPAY_KEY_SECRET=xxx                        # SECRET — server only
RAZORPAY_WEBHOOK_SECRET=xxx                    # SECRET — server only (set the same value in the Razorpay dashboard webhook)
SUPABASE_SERVICE_ROLE_KEY=xxx                  # SECRET — server only; bypasses RLS. NEVER NEXT_PUBLIC.
```
Use **test** Razorpay keys only.

## Server route contracts (the risky part — get these exactly right)

Create a **server-only** Supabase client in `lib/supabase-admin.ts` using `SUPABASE_SERVICE_ROLE_KEY` — imported **only** from `app/api/**`, never from a client component.

**`POST /api/payments/create-order`** — auth: the signed-in **customer** on this booking.
- Load the booking server-side. Reject unless the caller is `booking.customer_id`, the booking is in an active state (`accepted`/`en_route`/`arrived`/`in_progress`), and `payment_status = 'pending'`.
- **Amount comes from the DB** (`price_agreed`), converted to paise — never from the request body.
- Create a Razorpay order; insert `payment_transactions(status='created', razorpay_order_id, amount)`.
- Return `{ orderId, amount, keyId: NEXT_PUBLIC_RAZORPAY_KEY_ID }`. Do not return any secret.

**`POST /api/payments/webhook`** — **no user auth; this is the source of truth for money.**
- Read the **raw body**; verify `X-Razorpay-Signature` = HMAC-SHA256(rawBody, `RAZORPAY_WEBHOOK_SECRET`). **Reject (400) on mismatch.**
- On `payment.captured` (or `order.paid`): find `payment_transactions` by order id. **Idempotent** — if already `captured`, return 200 and do nothing. Otherwise set `status='captured'`, store `razorpay_payment_id`, and set the booking's `payment_status='held'`. **This is the only code path that sets `held`.**
- Use the service-role client (no session in a webhook). Verify the captured amount equals the stored order amount before marking held.

**`POST /api/payments/refund`** — auth: an admin, or the customer per cancel rules (full dispute logic is Step 8).
- Only if `payment_status='held'`. Call Razorpay refund; on success set `payment_transactions.status='refunded'` and `booking.payment_status='refunded'`. Idempotent.

## Client changes

- **`app/bookings/[id]/page.tsx`** (customer view): when `payment_status='pending'` and the booking is active, show **"Pay ₹X securely"** → call `create-order` → open Razorpay Checkout (load `https://checkout.razorpay.com/v1/checkout.js`) with the returned `orderId`/`keyId`. After Checkout closes, **refetch** — the badge flips to **Held/Paid** when the webhook lands (don't trust Checkout's success callback to change money state; it just tells you to refetch). Show a payment-status badge.
- **`lib/bookings.ts`**: **remove** the `confirmed → 'paid'` customer action ("Mark as paid (cash)"). The customer's final action is **Confirm done**; the system settles.
- **`app/wallet/page.tsx`**: show real `wallet_balance` + `wallet_transactions` (providers now see payout credits).

---

## Test-mode guardrails (do not skip)

- **Razorpay TEST keys only.** Use Razorpay's test cards/UPI. No real money touches this.
- **Local webhooks need a tunnel.** Razorpay can't reach `localhost`. Either run `cloudflared tunnel`/`ngrok http 3000` and set that URL as the webhook in the Razorpay dashboard, **or** let `verify-step5.mjs` POST a correctly-signed synthetic `payment.captured` to the webhook route to simulate capture (preferred for automated testing).
- **Going live is a separate, deliberate decision** requiring business registration, provider KYC/Route (Step 9+), and a security review. This step does not make you live.

---

## Definition of done

- `create-order` computes the amount from the DB and rejects non-customers, wrong-state bookings, and already-paid bookings.
- The webhook **rejects invalid signatures**, and on a valid `payment.captured` sets `payment_status='held'` **exactly once** (re-posting the same event changes nothing).
- No client path can set `held` or move a booking to `paid`; a direct `bookings.update({ payment_status:'held' })` or a `transition_booking(..., 'paid')` from a client is **denied/illegal**.
- On customer **Confirm done** for a held booking: provider `wallet_balance` increases by `price_charged × 0.85`, a `wallet_transactions` credit row is written, `payment_status='released'`, and the booking reaches `paid` via a `system` event.
- `credit_wallet` is **not executable** by `authenticated`.
- Refund moves a `held` booking to `refunded`.
- `npm run typecheck` and `npm run build` pass. **All verified in Razorpay test mode.**

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read /docs/Seva-Architecture.md (§8) and CLAUDE.md first.
We are on Playbook Step 5: Razorpay escrow. Step 4 is committed. THIS STEP HANDLES MONEY —
work carefully, TEST MODE ONLY, and treat the webhook as the source of truth (never the client
callback). Real bank payouts to providers are OUT OF SCOPE (deferred to Step 9+); provider
settlement here is an in-app wallet credit.

Read these first, then propose a short plan and WAIT for my OK before editing:
- CLAUDE.md (invariants #2 and #5) and /docs/Seva-Step-5.md (this spec — source of truth)
- supabase/migrations/20260711120000_seva_booking_state_machine.sql (transition_booking; the
  confirmed→paid stub you will remove) and 20260712120000 (is_booking_party helper to reuse)
- supabase/migrations/20260622131542_seva_initial_schema.sql (wallet_transactions, bookings
  payment_method/payment_status)
- app/bookings/[id]/page.tsx and lib/bookings.ts (customer actions; remove the paid stub)
- lib/supabase.ts and lib/auth-context.tsx; package.json and .gitignore

Build:
1. Migration supabase/migrations/20260718120000_seva_payments_escrow.sql EXACTLY as in
   /docs/Seva-Step-5.md: expand payment_status (remap old 'paid'→'released'); payment_transactions
   table + SELECT-only RLS via is_booking_party + revoked writes; credit_wallet SECURITY DEFINER
   granted to service_role only; release_escrow_on_confirm trigger (WHEN to_status='confirmed');
   and CREATE OR REPLACE transition_booking with the confirmed→paid client stub REMOVED.
2. npm install razorpay. Add lib/supabase-admin.ts (service-role client, imported only from
   app/api/**). Add the three routes per the spec's contracts:
   - app/api/payments/create-order/route.ts  (amount from DB, customer-only, state-guarded)
   - app/api/payments/webhook/route.ts        (verify X-Razorpay-Signature on the RAW body;
     idempotent; the ONLY setter of payment_status='held'; verify captured amount)
   - app/api/payments/refund/route.ts         (held→refunded via Razorpay refund; idempotent)
3. app/bookings/[id]/page.tsx: a "Pay ₹X securely" button for the customer when payment_status
   is pending → create-order → Razorpay Checkout → on close, REFETCH (don't change money state
   from the client callback). Show a payment-status badge.
4. lib/bookings.ts: remove the confirmed→'paid' customer action entirely.
5. app/wallet/page.tsx: show real wallet_balance + wallet_transactions.
6. Document the new env vars (NEXT_PUBLIC_RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
   RAZORPAY_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY) in .env.example; confirm .gitignore
   covers .env.local. Never hardcode a secret; never expose the service-role key to the client.

Do NOT:
- Change any booking state machine transition other than removing confirmed→paid.
- Implement Razorpay Route / real bank payouts / provider KYC (that's Step 9+).
- Touch chat, notifications, reviews, or reputation.
- Use live Razorpay keys or write any secret into the repo.

Done when (all in Razorpay TEST mode):
- create-order rejects non-customers / wrong-state / already-paid; amount comes from the DB.
- webhook rejects bad signatures; a valid payment.captured sets payment_status='held' exactly
  once (idempotent on repeat).
- No client can set 'held' or reach 'paid' (direct update denied; transition_booking(...,'paid')
  illegal).
- On customer confirm of a held booking: provider wallet_balance += price_charged*0.85, a
  wallet_transactions credit row exists, payment_status='released', booking reaches 'paid' via a
  system event.
- credit_wallet is not executable by authenticated.
- refund moves a held booking to refunded.
- npm run typecheck and npm run build pass.

I'll apply the migration (supabase db push) and add the env vars/webhook myself. After that, add
scripts/verify-step5.mjs that: (a) as customer+provider, creates & accepts a booking; (b) POSTs a
correctly-signed synthetic payment.captured to the webhook and asserts payment_status='held' and
idempotency on a second POST; (c) asserts a client cannot set held or reach paid; (d) customer
confirms and asserts the provider wallet credit + released + paid(system); (e) asserts credit_wallet
is not authenticated-executable. It reads keys/URL from .env.local like the other verify scripts.

Finish by reporting exactly what you changed (files + migration + routes) and how you verified
each "Done when" item in test mode.
```
