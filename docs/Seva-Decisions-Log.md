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

### Bucket C verification pass (2026-08-08) — browser-proven end to end

Driven in a real Chrome (claude-in-chrome extension), watched live, with every claim read back from the DB:

- **(14) The live capture is PROVEN** — not inferred. A real `getUserMedia` → canvas → upload landed **149,011 bytes of `image/jpeg`** in the private `kyc-docs` bucket at `<user_id>/<uuid>.jpg`, `meta.capture='live'`, born `pending`. (The scripts upload a 70-byte 1×1 PNG, so file size alone distinguishes the two paths.) The admin screen read back "Live selfie · **Captured live**".
- **(10)/(16) proven together** — three labeled docs: `photo_id` (`id_type=aadhaar`), `id_secondary` (`id_type=pan`), `selfie`. Admin saw "Primary photo ID · Aadhaar" / "Secondary ID · PAN · optional". After verifying all three, **`trust_tier` stayed 1** — the PAN did not buy the credential tier.
- **(18) proven at the DOM level, not by eye** — the Payment section contains **0 selectable controls** and "Seva Wallet" appears **0 times** on the booking page. The booking wrote `payment_method='upi'`.
- **(18) settlement is INTACT, which was the whole risk.** A real Razorpay **test** payment (`pay_TN2gYo8ePliKZz`) → ledger `captured` → `payment_status='held'`; customer confirm → provider wallet **4,622.80 → 5,216.80 (+594** = ₹600 less the 1% fee); dispute resolved `favor_customer` → **5,216.80 → 4,616.80 (−600)**. Both ledger rows present. **Removing the wallet from checkout did not break the payout ledger in either direction.**
- **(20) proven** — side-labeled counterparty ("Your provider" / "Your customer"), work hours, price label tracking reality (**AGREED → CHARGED** after settlement), escrow badge (**In escrow → Paid out**), and the timeline rendering the real `booking_events` trail.

**Camera testing policy (decided here).** The webcam starts in a script-spawned Chrome only **~1 attempt in 4** (~20-25s when it works, ~10s failures otherwise); no flag combination fixes it, and `--disable-features=MojoVideoCapture` makes it worse. Making `verify-all` depend on that coin flip buys flakiness, a popup window and a webcam light for occasional coverage. So `ui-check-step9` is now **headless by default** (deterministic degradation path — the behaviour that must never break) with **`LIVE_CAMERA=1`** opting into the headed attempt. Naming the trade honestly: a default run does **not** exercise video → canvas → upload; that leg is verified interactively in a real browser, as above.

**Fixes made in this pass:**
- **`ui-check-step9` timeouts** — one bug with two faces: the camera probe inherited the 30s CDP `send()` default (attempts take 10-25s) → intermittent `Runtime.evaluate timed out`, which is why it flaked inside `verify-all` while passing standalone; and the live branch's preview `waitFor` allowed 20s, *below* the camera's own start-up, so that branch could never finish even when the camera worked. Now 90s and 60s. **No retry loop** — retrying `getUserMedia` in one page doesn't help and leaves the renderer busy enough to time out the *next* evaluate.
- **Customer-facing copy no longer sells the wallet as a payment method** (`app/page.tsx`, `app/how-it-works/page.tsx`). Checkout was already correct; the marketing copy still said "Pay by UPI or Seva Wallet". The wallet FAQ was **reframed rather than deleted** — it is the payout ledger and the refund destination, which is true and worth saying, but it is not a way to pay.
- **The status screen no longer claims a submission that didn't happen.** `applied_at` is what the admin queue selects on, so a row without it is saved but in front of nobody; it now reads "Not sent for review yet" and points at the resubmit control instead of promising a 24–48h review. (Reachable via `reset-provider-application.mjs`, whose output was also corrected — it claimed the form comes back, which it doesn't.)

**Defect found & fixed during Bucket C:** `bookings.payment_method` **defaulted to `'wallet'`** — and `release_escrow_on_confirm` settles on `payment_status='held'` or `payment_method='cod'`, so a wallet booking matched neither and could reach `confirmed` and then never pay anyone. Default is now `'upi'`, with an INSERT-only trigger refusing new `'wallet'` bookings (`'wallet'` stays legal in the CHECK, and the guard is INSERT-only, for the same reason as the COD guard: an UPDATE guard would break every existing row's transitions). One legacy wallet booking exists; it settled long ago and is unaffected.

---

## Known-open — tracked, low priority (⚠️ not regressions, do NOT re-flag as new bugs)

- ~~**`verify-step7` red assertion — fixture drift.**~~ **RESOLVED** (commit `8d4bf50`): the test now derives the expected `dispute_fault_rate` from the DB instead of hardcoding 0, which is the honest fix that was called for. `verify-step7` is 31/0. Left here only so the old note isn't mistaken for a live issue.
- ~~**Footer / homepage still show "Become a Provider" to admins.**~~ **FOOTER RESOLVED** (2026-08-08): the footer is site-wide *navigation*, so it now follows the same rule as the navbar — `useAuth()` → an admin doesn't get the link. Asserted in `ui-check-admin` in **both** directions: absent for an admin, still present for a customer (hiding it from everyone would pass the first check while deleting the main signup path). **The homepage CTA is a deliberate NO-FIX (❌):** that band is marketing, not navigation, and "Book a Service Now" beside it has the identical mismatch for an admin — hiding one is incoherent, hiding both empties the band, and `app/page.tsx` is statically rendered, so making it auth-aware trades static rendering for a cosmetic gain on a page admins rarely land on. Navigation implies *your* options; a landing pitch does not.
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
