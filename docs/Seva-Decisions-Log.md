# Seva — Post-Step-10 Decisions & Issue Log

> Companion to the Step-1…Step-10 specs. Those describe the **core build**; this records everything decided **after** it — the issue passes (Buckets A/B/C), and — most importantly — **what was deliberately deferred or rejected, and why.** Read this alongside the specs to understand current intent. A future session must not "fix" something listed here as an intentional decision, nor re-flag a known-open item as a new bug.

Status legend: ✅ done · 🔜 planned · ⏸️ deferred (intentional) · ❌ rejected (intentional) · ⚙️ config, not code · ⚠️ known-open (tracked, low priority).

---

## Bucket A — Dispute experience (✅ DONE, committed)

The dispute flow was extended well beyond the Step-8 baseline. Current intended behavior:

- **Full identification everywhere a dispute appears** (party views *and* admin): **who** raised it (name + short id + role), **about whom**, and **which booking** (category, date, work summary) plus the reason and the raiser's description. No vague "raised by the customer."
- **Updated copy** reflecting what the team actually reviews now: the dispute reason + description, **evidence submitted by each party**, booking history, chat, and payments — with reassurance that funds stay protected until resolved.
- **Admin "contact parties" panel:** name, role, service category, phone, email, and location/address for both sides.
- **Resolution money breakdown:** on resolution, the page (reached from the notification) shows amount the customer paid, platform fee, amount the provider received, and the final settlement per party (refund / payout / clawback), every number labeled.
- **Admins are notified when a dispute is raised**, linking to `/admin/disputes/[id]`.
- **Live updates without manual refresh** on the booking/dispute page (counter-offers, dispute events, resolution) — same realtime pattern as chat and the bell.
- **Fault-based trust hit** (from Step 8, verified): `favor_customer` → provider takes the hit; `favor_provider` → customer takes the hit; `no_fault` → neither.

---

## Bucket B — Admin cleanup (✅ DONE, merged to main, pushed)

Verified against the live DB **and** a real Chrome browser. Two real defects were found and fixed during verification (noted below).

- **(12) Provider queue reachable — ✅** `/admin` hub built (previously 404'd) + admin tab strip; a queue row opens the approve/reject detail page. Browser-proven.
- **(17) Admin nav — ✅** Admin nav (Admin / Disputes / Providers / Categories) replaces the customer nav for admins — no "Become a Provider", no wallet. Non-admin nav verified unchanged; `/admin/*` redirects non-admins.
- **(15) Categories admin-only — ✅** `/admin/categories` screen + DB lockdown (writes revoked from `authenticated`, routed through admin-only RPCs guarded by `is_admin()`; reads stay public). A signed-in non-admin is refused at both the table and the RPCs. Create/delete round-tripped through the actual form; in-use categories withhold the delete button.
- **(21) trust_tier surfaced — ✅** `trust_tier` shown on provider/admin detail; `recompute_trust_tier` verified correct; the nightly document-expiry demotion sweep is scheduled and active (pg_cron **is** enabled — see note) and now asserted in the suite so it can't silently unschedule.

**Defects found & fixed during Bucket-B verification:**
- Admin detail route never selected `trust_tier` → the badge silently rendered "Tier 1" for **every** applicant (a wrong answer on the approval screen). Fixed by adding it to `DETAIL_COLUMNS`.
- `category_usage()` shipped `SECURITY DEFINER` with `EXECUTE` to all authenticated users and no internal check → any signed-in customer could read booking volume per category past RLS. Closed with an `is_admin()` guard (migration `20260814120000`).

---

## Bucket C — Onboarding UX & simplification (✅ DONE)

Migration `20260817120000_seva_bucket_c_onboarding_and_upi_only.sql`. Principle applied throughout: **customers frictionless, providers a short well-structured application.**

- **(10) Multiple documents, labeled and bounded — ✅** One extra, *named* slot (**Secondary ID**, `requirement='optional'`), not an open-ended upload pile: an unlabelled heap of files is worse for the reviewer than one document, because nothing says what any of it is. Each document also records **which** ID it is (`meta.id_type`), so the admin screen reads "Primary photo ID · Aadhaar" instead of "img_2043.jpg". Same private `kyc-docs` bucket. It never blocks approval, and it is **excluded from `recompute_trust_tier`** — a PAN photocopy must not buy the credential-verified tier that a trade certificate means.
- **(14) Live camera selfie — ✅** `getUserMedia` → `<video>` → canvas frame → the private bucket. No file input on that slot at all. **Degrades, never dead-ends:** denied permission, no camera, camera busy and insecure-context each get their own sentence plus a retry, and only *after* a failed attempt is an upload fallback offered — flagged `meta.capture='upload_fallback'` so the reviewer knows it wasn't live. Deliberately **no** blink/turn-head liveness (vendor feature, later). Honest limit: `meta.capture` is a **reviewer hint, not a security control** — it is client-asserted; the gate is still a human looking at the photo.
- **(16) Sensible Indian IDs — ✅** Primary = **Aadhaar / Voter ID (EPIC) / Driving licence** (all carry a photo, so the selfie has something to match). **PAN is secondary only** — no address, weak alone. **Passport is offered last and is never the default or required.** The doc *code* stays `photo_id` — renaming a key that every requirement row and document points at, for a label, would break data for cosmetics.
- **(18) Customer payment = UPI only — ✅** The checkout chooser is gone; UPI/card/netbanking into escrow is the single path (COD still deferred). 🔴 **The wallet is untouched and still the provider payout ledger** — escrow releases into it, disputes claw back from it. Nothing in the migration touches `credit_wallet`, `debit_wallet`, `wallet_transactions`, `release_escrow_on_confirm` or `resolve_dispute`; both were re-proven working after the change.
- **(20) Booking detail polish — ✅** Display only. Service, the other party *with which side they are*, date/time, work hours + listed rate, the price labeled for what it actually is (charged › agreed › listed), payment method + escrow state, booked-on, the customer's brief, and a **status timeline** read from the existing `booking_events` audit trail. The list rows gained hours and an escrow badge.

**Defect found & fixed during Bucket C:** `bookings.payment_method` **defaulted to `'wallet'`** — and `release_escrow_on_confirm` settles on `payment_status='held'` or `payment_method='cod'`, so a wallet booking matched neither and could reach `confirmed` and then never pay anyone. Default is now `'upi'`, with an INSERT-only trigger refusing new `'wallet'` bookings (`'wallet'` stays legal in the CHECK, and the guard is INSERT-only, for the same reason as the COD guard: an UPDATE guard would break every existing row's transitions). One legacy wallet booking exists; it settled long ago and is unaffected.

---

## Known-open — tracked, low priority (⚠️ not regressions, do NOT re-flag as new bugs)

- **`verify-step7` red assertion — fixture drift, not a bug.** Test account `test2` has accumulated real `favor_provider` disputes, so its `dispute_fault_rate` is ~0.032 where the test hardcodes 0. The reputation *logic* is correct. Honest fix: make the test compute its expected value from the DB (as it already does for `review_count`) rather than relaxing the assertion. Needs a reputation-scope session. **Do not weaken the assertion.**
- **Footer / homepage still show "Become a Provider" to admins.** Cosmetic. Item 17 covered the navbar; the footer is a site-wide sitemap. One-line fix if/when wanted.
- **`/admin` cold-load delay is a `next dev` artifact, not a real problem.** The blank-for-~8s dashboard was `next dev` compiling the API route on first request (12s cold, 1.5s after); it does **not** happen in a production build. A `Promise.all` shape improvement was kept, but it was NOT the cure. Confirm in a production build (`npm run build && npm start`) before treating as an issue.

---

## Deferred — external integrations (⏸️ INTENTIONAL, post-launch)

Need signed vendors, credentials, and/or compliance review. **Not bugs — deliberately not built yet.** KYC still works: admins verify documents manually.

- **(9)** **DigiLocker** integration — deferred. Manual upload + admin review is the launch mechanism.
- **(13)** Fetch **any** required document from DigiLocker (not just Aadhaar) — deferred, part of the DigiLocker integration.
- **(11)** **EPFO** employment-history verification — **rejected for launch** (❌). Not needed for home services; remove the "not connected" copy / make it absent. Revisit only if a real need appears.

## Config, not code (⚙️)

- **(8)** Signup **"email invalid / rate limit exceeded"** — **Supabase Auth email configuration**, not app code. Fix: add a real **custom SMTP** provider (Resend/SendGrid) in the Supabase dashboard to remove the free-tier email cap; keep "confirm email" on for launch. No repo change.
- **pg_cron IS enabled** on the live project. The nightly reputation recompute, stale-offer expiry sweep, and trust-tier document-expiry demotion are scheduled and active. (An earlier note claiming it was *not* enabled has been corrected — it is live; `nightly-expire-documents` runs at `20 2 * * *` and is asserted in `verify-hardening`.)

---

## Open OTP / anti-substitution decision (🔜 noted for Step 15)

- **Uber-style arrival OTP:** the customer holds an OTP; the provider must enter it to transition to `arrived`. Decision: **implement at Step 15** (with live tracking). Confirms the *verified* individual actually showed up (anti-substitution — core to the "trusted individuals" model) and upgrades `arrived` from provider-self-reported to customer-attested.
- **Provider substitution (sending someone else): rejected (❌).** Destroys the verified-individual trust model and creates a safety liability. The "provider is busy / knows someone capable" case is served by **that person onboarding as their own verified provider**, not by substitution.

---

## Principles reaffirmed during the issue passes

- **Friction asymmetric to intent:** customers frictionless; providers do a short, one-time, honestly-status'd application; strict guarantees underneath.
- **Whoever benefits from a claim doesn't get to make it:** providers can't self-verify, self-rate, or self-mark-paid; customers confirm payment; the system (webhook) confirms online payment.
- **Simple interface, strict guarantees** — simplify UX, never simplify away a safety gate.
- **Browser verification catches what scripts can't** — the Bucket-B trust-tier and `category_usage` defects were both "the DB was right, the screen was wrong / the grant leaked"; only a real browser + a discriminating assertion surfaced them.
