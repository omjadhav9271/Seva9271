# Seva — Playbook Step 1: Stand up + harden the schema

> This is **Step 1 of `/docs/Seva-Claude-Code-Playbook.md`**. It's the source of truth for the hardening migration that the playbook references. Read `CLAUDE.md` and `/docs/Seva-Architecture.md` (§1, §7) before running it.

---

## Where you are (grounded in the actual repo)

Bolt built on the right stack — **Next.js 13 (App Router) + TypeScript + Tailwind + shadcn/ui + Supabase** — so nothing to migrate. You already have:

- **Schema + RLS** (`supabase/migrations/…`): `profiles`, `service_categories` (14 seeded), `service_providers` (with `latitude`/`longitude`, `documents`/`gallery`, `status`), `bookings`, `reviews`, `wallet_transactions`, `favorites`, `notifications`.
- A **signup → profile** trigger (`handle_new_user`).
- **Pages**: auth (signin/signup), providers + `providers/[id]`, services, bookings, wallet, profile, become-provider, how-it-works.
- Supabase client (`lib/supabase.ts`) + auth context (`lib/auth-context.tsx`).

That's **Phase 0 complete, Phase 1 scaffolded.** The gaps this step closes: it isn't verified running end-to-end, and the schema has holes to fix before anything is built on top of it.

## The 5 problems this step fixes

1. **Users can mint their own money** — `wallet_transactions` is client-insertable and `profiles.wallet_balance` is client-updatable.
2. **Providers can set their own `rating` / `is_verified` / `status`** — the `update_own_provider` policy allows writing any column.
3. **Reviews aren't gated to real bookings** — any customer can review any provider with no completed booking.
4. **Anon visitors can read everyone's phone number** — the `public_select_profiles` policy exposes all columns to `anon`.
5. **Bug:** the `service_categories` seed has `icon`/`color`/`bg_color` swapped from the 3rd row onward, so most category icons render wrong.

---

## Goal / definition of done

> On a **live** Supabase project, a new user can sign up → log in → browse real providers → **create a real booking** → see it in `/bookings`; the hardening migration is applied; and from a browser client a user can **no longer** mint wallet balance, self-set their rating/verification, review without a completed booking, or read anyone's phone as anon. `npm run typecheck` and `npm run build` pass.

Do this before adding any new features. Everything after (state machine, escrow, reputation, bargaining) sits on this foundation.

### Task list
1. **Create a Supabase project** (cloud). Copy the project URL + anon key.
2. **Add `.env.local`** at repo root:
   ```
   NEXT_PUBLIC_SUPABASE_URL=your-url
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   ```
3. **Run the two existing migrations**, then the **hardening migration** below (new file `supabase/migrations/20260710120000_seva_security_hardening.sql`).
4. **Verify the flow manually**: sign up → confirm a `profiles` row was auto-created → log in → `/providers` lists real rows → open one → create a booking → it appears in `/bookings` with `status = 'pending'`.
5. **Replace the demo-provider seed.** The current seed attaches sample providers to `(SELECT id FROM auth.users LIMIT 1)`, which inserts nothing on a fresh DB. Seed 3–4 real test providers in Mumbai instead.
6. **Fix any runtime gaps** the manual test surfaces (bolt scaffolds often have unwired queries/buttons).

---

## The hardening migration (source of truth)

`supabase/migrations/20260710120000_seva_security_hardening.sql` — run **after** the two existing migrations:

```sql
/* Seva — security hardening + fixes. Run AFTER the two existing migrations. */

-- 1) BUG: category seed had icon/color columns swapped from the 3rd row on.
UPDATE service_categories SET icon='ChefHat',        color='#ef4444', bg_color='#2d1515' WHERE slug='home-cook';
UPDATE service_categories SET icon='Sparkles',       color='#22c55e', bg_color='#0f2d0f' WHERE slug='house-cleaning';
UPDATE service_categories SET icon='Heart',          color='#ec4899', bg_color='#2d0f1f' WHERE slug='caretaker';
UPDATE service_categories SET icon='Car',            color='#94a3b8', bg_color='#1e293b' WHERE slug='driver';
UPDATE service_categories SET icon='Stethoscope',    color='#14b8a6', bg_color='#0d2626' WHERE slug='doctor';
UPDATE service_categories SET icon='GraduationCap',  color='#a855f7', bg_color='#1f0d2d' WHERE slug='tutor';
UPDATE service_categories SET icon='Settings',       color='#6366f1', bg_color='#1a1a3e' WHERE slug='appliance-repair';
UPDATE service_categories SET icon='Hammer',         color='#f59e0b', bg_color='#2d1f00' WHERE slug='carpenter';
UPDATE service_categories SET icon='Leaf',           color='#84cc16', bg_color='#1a2d00' WHERE slug='gardening';
UPDATE service_categories SET icon='Scissors',       color='#f43f5e', bg_color='#2d0f15' WHERE slug='beauty';
UPDATE service_categories SET icon='ShoppingBasket', color='#10b981', bg_color='#0a2d1a' WHERE slug='farm-fresh';
UPDATE service_categories SET icon='Truck',          color='#f97316', bg_color='#2d1500' WHERE slug='delivery';

-- 2) MONEY: users must NOT write their own wallet ledger.
--    Ledger is append-only, server-side only (service role / SECURITY DEFINER RPC).
DROP POLICY IF EXISTS "insert_own_transaction" ON wallet_transactions;
DROP POLICY IF EXISTS "update_own_transaction" ON wallet_transactions;
DROP POLICY IF EXISTS "delete_own_transaction" ON wallet_transactions;
-- keep "select_own_transactions" so users can view their history.

-- 3) PROFILE: block editing protected columns (wallet_balance, role, wallet_tier).
REVOKE UPDATE ON profiles FROM authenticated;
GRANT  UPDATE (full_name, phone, avatar_url, city, state, address) ON profiles TO authenticated;

-- 4) PROVIDER: block self-setting rating / verification / status / bookings counts.
REVOKE UPDATE ON service_providers FROM authenticated;
GRANT  UPDATE (business_name, bio, experience_years, hourly_rate, is_available,
               city, state, address, latitude, longitude, documents, gallery)
       ON service_providers TO authenticated;

-- 5) REVIEWS: only for a COMPLETED booking between the two parties; one per booking.
--    NOTE: if existing reviews have NULL booking_id, clear/fix them before SET NOT NULL.
ALTER TABLE reviews ALTER COLUMN booking_id SET NOT NULL;
ALTER TABLE reviews ADD CONSTRAINT uniq_review_per_booking UNIQUE (booking_id);
DROP POLICY IF EXISTS "insert_own_review" ON reviews;
CREATE POLICY "insert_review_for_completed_booking" ON reviews
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = customer_id
  AND EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.id = reviews.booking_id
      AND b.customer_id = auth.uid()
      AND b.provider_id = reviews.provider_id
      AND b.status = 'completed'
  )
);

-- 6) PRIVACY: stop exposing everyone's phone to anonymous visitors.
--    Expose only safe columns via a view; provider names come from service_providers.business_name.
DROP POLICY IF EXISTS "public_select_profiles" ON profiles;
CREATE OR REPLACE VIEW public_profiles AS
  SELECT id, full_name, avatar_url, city, state FROM profiles;
GRANT SELECT ON public_profiles TO anon, authenticated;
-- NOTE: if any anon page reads full profile rows, point it at public_profiles or business_name.
```

After applying, re-test that provider listing and profile editing still work (they should — provider names read from `service_providers.business_name`).

> ⚠️ In Step 2 the booking `status` values change (`pending → requested/accepted/...`). This review policy checks `status = 'completed'`, which survives that change since `completed` remains a valid status. Keep `completed` in the enum when you do Step 2.

---

## What comes right after → Playbook Step 2

**Step 2 — the Booking state machine** (`/docs/Seva-Claude-Code-Playbook.md`, §4 of the architecture): replace the coarse `status` enum with `requested → accepted → en_route → arrived → in_progress → completed → confirmed → paid → reviewed` (+ `cancelled`, `disputed`); add a `booking_events` table and one server-side `transition_booking()` RPC; split price into `price_agreed` vs `price_charged`. That's the spine escrow, reviews, reputation, and bargaining all attach to — don't skip ahead of it.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read /docs/Seva-Architecture.md and CLAUDE.md first.
We are on Playbook Step 1: Stand up + harden the schema.

Read these files first, then propose a short plan and WAIT for my OK before editing:
- CLAUDE.md and /docs/Seva-Architecture.md (§1, §7) for context and the security invariants
- lib/supabase.ts and lib/auth-context.tsx (Supabase client, types, auth flow)
- supabase/migrations/*.sql (existing schema, RLS policies, and the category seed)
- app/auth/signup/page.tsx and app/auth/signin/page.tsx (signup → profile trigger)
- app/providers/page.tsx and app/providers/[id]/page.tsx (provider listing reads)
- app/bookings/page.tsx (booking create + list)
- .gitignore and any existing .env (env wiring)

Build:
1. Create .env.local with NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
   (I will paste the values). Confirm the app boots and connects to the live DB.
2. Add the hardening migration described under "Data" below.
3. Trace the path: signup → profiles row auto-created → login → list real providers →
   open a provider → create a booking → see it in /bookings. Fix any unwired queries or
   buttons so this whole path works against the live DB. Tell me exactly what was broken.
4. Replace the demo-provider seed (it attaches samples to "SELECT id FROM auth.users LIMIT 1"
   and inserts nothing on a fresh DB) with a small self-contained seed of 3–4 test providers
   in Mumbai.

Do NOT touch (later steps):
- The booking status enum / state machine (Step 2)
- Payments, wallet crediting logic, Razorpay (Step 5)
- Chat / messages (Step 3) and notification delivery (Step 4)
- Reputation math (Steps 7/12) and bargaining (Step 10)
Only make it run and make it safe.

Data: new migration supabase/migrations/20260710120000_seva_security_hardening.sql that:
1. Fixes the service_categories seed where icon/color/bg_color are swapped from the 3rd row
   onward (home-cook … delivery) — icon must hold the Lucide name, not a hex code.
2. Drops the client insert/update/delete policies on wallet_transactions (keep select) —
   the wallet ledger is server-only and append-only.
3. Revokes UPDATE on profiles from authenticated, re-grants UPDATE only on
   (full_name, phone, avatar_url, city, state, address) — so wallet_balance/role/tier
   are not client-writable.
4. Revokes UPDATE on service_providers from authenticated, re-grants UPDATE only on
   descriptive columns — so rating/total_reviews/total_bookings/is_verified/status
   are not self-settable.
5. Replaces the review insert policy with one requiring an existing COMPLETED booking
   between that customer and provider, and adds UNIQUE(booking_id) (one review per booking).
6. Drops the blanket anon SELECT on profiles and exposes only
   (id, full_name, avatar_url, city, state) via a public_profiles view.
The exact SQL is in /docs/Seva-Next-Step.md — use it as the source of truth.

Done when:
- A new user signs up, a profiles row is auto-created, they log in, /providers shows real
  DB rows, they open one, create a booking, and it appears in /bookings.
- From a browser (anon-key) client a user can NO LONGER: insert a wallet_transactions row,
  set their own profiles.wallet_balance, set their own service_providers.rating or
  is_verified, or insert a review without a completed booking.
- Anonymous visitors cannot read phone numbers from profiles.
- npm run typecheck and npm run build both pass.

Finish by reporting exactly what you changed (files + migration), what was broken in the
end-to-end path and how you fixed it, and how you verified each "Done when" item.
```
