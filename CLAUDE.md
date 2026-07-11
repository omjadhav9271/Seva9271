# CLAUDE.md — Seva (standing context for every Claude Code session)

## What Seva is
A local-services marketplace (Mumbai first) where **individual** providers carry **portable, manipulation-resistant reputation**. It's a *store of individuals* (like the Play Store), **not** an employer of workers (not Urban Company). Full design in `/docs/Seva-Architecture.md`; build order in `/docs/Seva-Claude-Code-Playbook.md`. Read those before non-trivial work.

## Stack (do not change without asking)
Next.js 13 App Router + TypeScript · Tailwind + shadcn/ui · Supabase (Postgres + Auth + Realtime + Storage + RLS). Payments: **Razorpay Route**. Geo: **PostGIS**. Hosting: Vercel + Supabase cloud.

## Non-negotiable invariants — never violate these
1. **Reputation is server-computed only.** `rating`, `total_reviews`, `total_bookings`, `is_verified`, provider `status`, and reputation snapshots are **never client-writable**. Users edit only their own descriptive fields.
2. **Wallet is server-only and append-only.** No client insert/update/delete on `wallet_transactions`; every credit/debit goes through a `SECURITY DEFINER` RPC or the service-role key on the server. `profiles.wallet_balance` is never client-writable.
3. **Reviews require a completed + paid booking** between exactly those two parties; one review per booking per direction.
4. **Booking status changes go through ONE server-side transition function** that validates current→next, stamps a timestamp, and emits events + notifications. No ad-hoc `status` writes from the client.
5. **Money moves only via escrow.** Never mark a booking paid without a reconciled Razorpay webhook event.
6. **No PII to anon.** Public reads (e.g. phone) go through safe views/columns, never blanket `anon USING (true)` on full rows.

## Conventions
- Every schema change is a **new** timestamped migration in `supabase/migrations/`. Never edit an already-applied migration.
- Push integrity rules down to the DB (RLS + RPC + triggers + constraints). The client is untrusted.
- Keep code as modules-as-folders with clear boundaries (identity, catalog, matching, booking, payments, chat, reputation, trust-safety, notifications). Modular monolith — no microservices.
- After each step: `npm run typecheck` and `npm run build` must pass; manually verify the step's "Done when"; then commit.

## How to work in a session
Read the relevant files and the current playbook step **first**. Propose a short plan and wait for approval before editing. Implement only what the step scopes — do not wander into later steps. Finish by reporting what changed and how you verified it.
