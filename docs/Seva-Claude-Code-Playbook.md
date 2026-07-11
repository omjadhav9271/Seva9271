# Seva — Claude Code Playbook

*How to turn `Seva-Architecture.md` into working code on your existing repo, one Claude Code session at a time.*

This maps the architecture (§ references point to that doc) onto **15 ordered steps** grounded in what's already in your repo (Next.js 13 + Supabase, existing schema, the security holes found in review). Do them **in order** — each depends on the ones above.

---

## How to run this playbook (read once)

**Golden rules:**
1. **One step per session.** Never paste the whole architecture at Claude Code. Give it a single step. Small scope = better code.
2. **Plan before code.** Every prompt below ends by asking Claude Code to *read the files, propose a plan, and wait for your OK* before editing. Use it.
3. **Commit after every green step.** `git commit` once the "Done when" passes. This gives you a clean rollback point per step.
4. **Keep the docs in the repo.** So Claude Code always has context (see Step 0).
5. **Verify "Done when" yourself** before advancing. Don't take "done" on faith — click through it.

**Reusable prompt template** (each step below just fills the blanks):
```
Context: Seva. Read /docs/Seva-Architecture.md and CLAUDE.md first.
We are on Playbook Step N: <title>.
Read these files first, then propose a short plan and WAIT for my OK before editing: <files>.
Build: <scope>.
Do NOT touch (later steps): <out of scope>.
Data: new migration supabase/migrations/<timestamp>_<name>.sql — <schema changes>.
Done when: <acceptance criteria>.
Finish by reporting exactly what you changed and how you verified it.
```

---

## Step 0 — Repo prep (10 minutes, do this first)

- Create a `/docs` folder; drop `Seva-Architecture.md` and this playbook into it.
- Put `CLAUDE.md` at the repo root (the companion file) — Claude Code reads it automatically as standing context.
- Create the Supabase project, add `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`), and confirm `npm run dev` boots.

---

# PHASE 1 — A working, safe transactional core
*Goal: a real customer books a real provider, they chat, statuses move, both are notified, the job completes. Payment can still be cash/off-platform here.*

## Step 1 — Stand up + harden the schema
**Depends on:** Step 0. **Architecture:** §1, §7.
**Build:** get the app running against live Supabase and apply the hardening migration — category-seed fix, wallet write-lock, `profiles`/`service_providers` column-level update grants, review-requires-completed-booking policy, phone-privacy view. (Full SQL is in `Seva-Next-Step.md`.) Then verify one booking end-to-end.
**Not now:** state machine, payments, chat.
**Done when:** sign up → profile row auto-created → login → `/providers` lists real DB rows → create a booking → shows in `/bookings`; and a browser client can no longer edit its own `wallet_balance`, `rating`, or `is_verified`.

## Step 2 — Real Booking state machine (the spine)
**Depends on:** Step 1. **Architecture:** §4.
**Build:** replace the coarse `status` enum with `requested → accepted → en_route → arrived → in_progress → completed → confirmed → paid → reviewed` (+ `cancelled`, `disputed`). Add a `booking_events` table (booking_id, from_status, to_status, actor, timestamp, meta) and **one** `transition_booking(booking_id, next_status)` RPC that validates the transition, writes the event, and updates the row. Split price into `price_agreed` and `price_charged`. Update the customer + provider booking views to call the RPC (accept, start, arrive, complete, confirm).
**Not now:** escrow (the `paid` transition can be a stub), chat, reputation.
**Done when:** a booking walks the full happy path via the RPC; illegal jumps (e.g. `requested → completed`) are rejected; every transition appears in `booking_events` with a timestamp.

## Step 3 — Per-booking chat (Realtime)
**Depends on:** Step 2. **Architecture:** §4 (Message entity).
**Build:** `messages` table (booking_id, sender_id, body, created_at) with RLS so only the two booking parties can read/write. Subscribe with Supabase Realtime; add a chat panel on the booking detail page.
**Not now:** attachments, contact-exchange detection (that's a Phase-3 fraud signal).
**Done when:** the two parties on a booking exchange messages live; a third user can't read them.

## Step 4 — Notifications wiring
**Depends on:** Step 2. **Architecture:** §2 (Notifications module).
**Build:** have the `transition_booking` RPC (and new messages) insert into the existing `notifications` table; add an in-app notification bell/list. Put SMS/WhatsApp/push behind a single `notify()` interface with a console/no-op adapter for now (real MSG91/WhatsApp adapter is Phase 4).
**Not now:** real SMS/WhatsApp provider integration.
**Done when:** accepting a booking or sending a message produces a notification row the recipient sees in-app.

> **Phase 1 exit check:** two real accounts complete a full booking together — request, accept, chat, status transitions, notifications, completion — with no mock data in the path.

---

# PHASE 2 — Money + trust
*Goal: close the loop with real payments, trustworthy reviews, a basic reputation number, disputes, KYC, and bargaining v1.*

## Step 5 — Razorpay escrow
**Depends on:** Step 2. **Architecture:** §8.
**Build:** `payment_transactions` table (booking_id, razorpay refs, amount, platform_fee, status, timestamps). Razorpay Orders on booking; **hold** into escrow (Route) at `accepted`/`confirmed`; **release** split (provider payout + platform fee) on `confirmed → paid`; refund path. A server webhook route reconciles Razorpay events — the **only** thing allowed to move a booking to `paid`. Wallet credits/debits now flow through a server-side `SECURITY DEFINER` RPC.
**Not now:** bargaining, subscriptions.
**Done when:** a test-mode payment holds funds, releases on confirmation with the fee split, and a refund works; `paid` is set only by the reconciled webhook.

## Step 6 — Bidirectional, multi-dimensional, gated reviews
**Depends on:** Steps 2 & 5. **Architecture:** §6.1, §6.4.
**Build:** extend `reviews` to multi-axis (quality, punctuality, price_fairness, communication) **and** a `direction` (customer→provider / provider→customer). Keep the completed-**and-paid**-booking gate. Add reciprocity reveal (both submit, or a deadline passes). Grant a small review credit via the server wallet RPC.
**Not now:** the weighting math (that's Step 12).
**Done when:** both parties can review after a paid booking, on all axes; neither can review without one; reviews stay hidden until both submit or the deadline hits.

## Step 7 — Reputation v1 (simple, server-owned)
**Depends on:** Step 6. **Architecture:** §6.3 (simple version first).
**Build:** `reputation_snapshots` table + a scheduled job (Supabase cron/edge function) computing provider **and** customer scores as: weighted average of review axes + completion% + on-time% (derived from `booking_events`). Server-written only. Surface the score + a plain breakdown on profiles.
**Not now:** Bayesian/time-decay/rater-weighting — deliberately left for Step 12.
**Done when:** scores recompute on schedule from real jobs, show on profiles, and no client can write them.

## Step 8 — Disputes + minimal admin console
**Depends on:** Steps 2, 5. **Architecture:** §7.2.
**Build:** `disputes` table (booking_id, raised_by, reason, status, resolution). "Raise dispute" on a booking (moves it to `disputed`). An admin-only area (`role = 'admin'`) that shows the evidence you already hold — chat, `booking_events`, agreed vs charged price — and resolves; resolution drives escrow (hold/refund) and feeds reputation.
**Not now:** automated fraud detection (Step 13).
**Done when:** either party can open a dispute, an admin sees the evidence bundle and resolves it, and the outcome moves the money correctly.

## Step 9 — KYC & provider verification
**Depends on:** Step 1. **Architecture:** §7.1.
**Build:** provider doc upload (Supabase Storage → `service_providers.documents`); admin approve/reject that server-sets `is_verified`/`status`. Phone OTP is already handled by Supabase Auth. Leave Aadhaar eKYC / background-check as an adapter stub for high-trust categories.
**Done when:** a provider can't appear as "verified" until an admin approves real uploaded docs.

## Step 10 — Structured bargaining v1
**Depends on:** Steps 2 & 5. **Architecture:** §5.5.
**Build:** introduce a `listings` concept (provider × category × area × `pricing_mode` [fixed|negotiable|rfq], `list_price`, private `floor_price`, `auto_accept_threshold`, `max_counter_rounds`). Add an `offers` table (bounded round sequence, status, `expires_at`) and an `make_offer` / `respond_offer` RPC enforcing the hidden floor and auto-accept. Put **"Make an offer"** beside **"Book at ₹X"**; the accepted price locks into the booking and flows into escrow. Structured buttons only — no free-text price talk.
**Not now:** RFQ/competing quotes and reputation-linked negotiating power (Step 14).
**Done when:** a customer can offer, get auto-accepted above threshold or countered within bounds, and the agreed price locks into the booking + escrow; offers below the floor auto-decline.

---

# PHASE 3 — The clever layer (your moat)
*Only now, because these are powered by the transaction data Phases 1–2 produce.*

## Step 11 — PostGIS matching & ranking
**Depends on:** Phase 1. **Architecture:** §5.
**Build:** enable PostGIS; give providers a geography point + service radius; filter candidates with `ST_DWithin`; rank by the `match_score` blend (proximity + reputation + availability + price_fit + `exploration_bonus` for newcomers). Mirror it: providers see incoming requests ranked by customer reputation.
**Done when:** searching a category near a location returns the nearest eligible providers in ranked order, and a brand-new good provider still surfaces sometimes (exploration).

## Step 12 — Full reputation engine
**Depends on:** Steps 7, 11. **Architecture:** §6.2, §6.3.
**Build:** replace v1 with Bayesian shrinkage + exponential time-decay + **bounded** rater-weighting (0.5×–2×), blended with operational metrics; keep it multi-dimensional and explainable (store the component breakdown in the snapshot).
**Done when:** a single 5★ can't outrank a long track record; recent behavior dominates stale history; a swarm of fresh accounts barely moves a score; and each score is explainable from its snapshot.

## Step 13 — Fraud & anomaly detection
**Depends on:** Steps 6, 10. **Architecture:** §5.5, §7.1.
**Build:** scheduled scans → `fraud_signals` + an admin queue: rating spikes, review bursts, device/IP clustering, review-ring graph patterns, bait-pricing (agreed vs charged gap), lowball-spam, and contact-exchange-then-silence (disintermediation) flags. Add new-account velocity limits.
**Done when:** seeded suspicious patterns raise signals into the admin queue; velocity limits block abusive new-account bursts.

## Step 14 — RFQ mode + reputation-linked negotiating power
**Depends on:** Steps 10, 12. **Architecture:** §5.5.
**Build:** `quote_requests` + `quotes` (customer posts a job, nearby providers bid, customer picks). High-reputation customers get better auto-accept thresholds and provider-initiated special offers.
**Done when:** a posted job collects competing quotes; a high-rep customer visibly gets better default terms.

## Step 15 — Tiers, incentives, subscriptions, live tracking
**Depends on:** Steps 7/12, 5. **Architecture:** §6.4, §7.3.
**Build:** wallet tiers (silver/gold/platinum) tied to reputation; recurring **subscriptions** for daily cook/cleaning with a flat monthly fee (a disintermediation defense); live-location tracking on the booking map between `en_route` and `arrived`.
**Done when:** a subscription auto-creates recurring bookings; tier perks apply; the customer sees the provider move on the map en route.

---

# PHASE 4 — Scale (only when metrics demand it)
Not step-by-step — pull these in as growth requires: SEO landing pages per category × area (your free acquisition channel), real WhatsApp/SMS adapters behind the `notify()` interface, a background-job queue (BullMQ) if cron stops coping, observability/logging, and extracting any hot module into its own service **only if a real bottleneck appears** (§9, §10). Resist all of this until you have the traffic to justify it.

---

## One-glance sequence

| # | Step | Phase | Unlocks |
|---|------|-------|---------|
| 1 | Stand up + harden | 1 | Safe, running app |
| 2 | Booking state machine | 1 | The spine everything hangs off |
| 3 | Per-booking chat | 1 | Communication + evidence |
| 4 | Notifications | 1 | Engagement loop |
| 5 | Razorpay escrow | 2 | Real money, protected |
| 6 | Gated bidirectional reviews | 2 | Trustworthy signal |
| 7 | Reputation v1 | 2 | A score to rank on |
| 8 | Disputes + admin | 2 | Trust has teeth |
| 9 | KYC / verification | 2 | Real "verified" badge |
| 10 | Bargaining v1 | 2 | Your cultural hook |
| 11 | PostGIS matching | 3 | The Uber-like core |
| 12 | Full reputation engine | 3 | The moat |
| 13 | Fraud detection | 3 | Manipulation resistance |
| 14 | RFQ + rep-linked bargaining | 3 | Competitive pricing |
| 15 | Tiers / subs / tracking | 3 | Retention + anti-leakage |

**Remember the through-line from the architecture:** the clever pieces (11–15) only work because the boring pieces (1–10) generate the data that feeds them. Ship the core, earn the data, then add the intelligence.
