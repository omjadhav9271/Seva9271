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
- **(18) Customer payment = UPI only — ✅** *(presentation revised 2026-08-08 — see "Item 18 was REVISED" below: the full list is now shown with Cash and Seva Wallet visible-but-disabled as "Coming soon". UPI remains the only method a customer can actually select, and the DB guards are unchanged.)* UPI/card/netbanking into escrow is the single active path (COD still deferred). 🔴 **The wallet is untouched and still the provider payout ledger** — escrow releases into it, disputes claw back from it. Nothing in the migration touches `credit_wallet`, `debit_wallet`, `wallet_transactions`, `release_escrow_on_confirm` or `resolve_dispute`; both were re-proven working after the change.
- **(20) Booking detail polish — ✅** Display only. Service, the other party *with which side they are*, date/time, work hours + listed rate, the price labeled for what it actually is (charged › agreed › listed), payment method + escrow state, booked-on, the customer's brief, and a **status timeline** read from the existing `booking_events` audit trail. The list rows gained hours and an escrow badge.

### Bucket C verification pass (2026-08-08) — browser-proven end to end

*Suite at the end of this pass: **568 passed, 0 failed, 1 skipped** (`node scripts/verify-all.mjs`), from 543/1/2 at the start. Point-in-time, not a target — the one remaining skip is the intentional admin-read note described below, not lost coverage.*

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
- **Every fix above is now ASSERTED, because each was a one-time correction with nothing stopping it coming back** — which is exactly how the footer regressed after item 17 fixed the navbar. Checkout: the Payment section must contain **zero selectable controls** (structural, not textual — it fires on a re-added chooser whatever its options are labelled, where grepping for "wallet" would wave through one offering "Balance" or "Seva Credit"). Public copy: no wallet-as-payment *claim*, matched against the **rendered HTML** rather than the source, since what the visitor receives is what matters. Footer: absent for an admin **and still present for a customer** — the second half catches an over-applied fix that would delete the main signup path.

### The fourth account, and the isolation gap it closes (2026-08-08)

**There is a fourth test account** — `OUTSIDER_*` in `.env.local`, documented in `.env.example`. It is `role='customer'`, party to **no** booking, and it owns the pending **"Divyanshu Verma"** application (whose documents are REAL — do not sweep that storage folder as test litter).

**The gap it fixes, because the shape of it recurs.** Isolation checks generally test three readers: a party, `anon`, and a signed-in stranger. The suite only had three accounts and **the third was the admin**, who may legitimately read offers and disputes for case handling. So the stranger assertion could not be made — `verify-step10` skipped it honestly rather than passing something meaningless, and the case sat **untested**: an RLS change exposing `offers` to every authenticated user would have passed that file clean. **`anon` being blocked says nothing about a logged-in non-party** — they are different policies.

Now asserted and passing: *"a signed-in NON-ADMIN outsider sees no offers."* Wired in as **optional** — `authClient` returns a null userId for an unconfigured prefix, so a checkout without the account degrades to the skip instead of failing, and the skip text now says the case is **UNTESTED** rather than implying coverage. The admin note remains a skip **on purpose**: admin read access is intended, so there is nothing there to assert, and one honest skip beats a green line that means nothing.

**Reuse it.** Any future "an outsider must not see X" check should take `OUTSIDER_*`, never `ADMIN_*`/`STRANGER_*`. The rest of the suite was swept for the same confusion — `verify-step10` was the only instance; the other skips are data-availability conditions ("no category currently in use"), not identity ones.

**Defect found & fixed during Bucket C:** `bookings.payment_method` **defaulted to `'wallet'`** — and `release_escrow_on_confirm` settles on `payment_status='held'` or `payment_method='cod'`, so a wallet booking matched neither and could reach `confirmed` and then never pay anyone. Default is now `'upi'`, with an INSERT-only trigger refusing new `'wallet'` bookings (`'wallet'` stays legal in the CHECK, and the guard is INSERT-only, for the same reason as the COD guard: an UPDATE guard would break every existing row's transitions). One legacy wallet booking exists; it settled long ago and is unaffected.

---

## Step 11 — PostGIS matching & ranking (✅ DONE, verified DB + browser)

Migrations `20260818120000_seva_matching_postgis.sql` and `20260818130000_seva_service_base_signed_in_guard.sql`. The Step-7 `reputation_score` now drives what customers see; before this, `/providers` and `/services` sorted by a plain star average and distance counted for nothing.

- **`search_providers` is the only matching entry point** — `SECURITY DEFINER`, granted to anon + authenticated, returning `distance_km` and a blended `match_score` (0.45 proximity decay at an 8 km scale + 0.40 reputation_score + 0.10 availability + 0.05 trust_tier). Filter is `ST_DWithin` against a GIST index.
- **Both listing pages rank through it**, with "Use my location" (`navigator.geolocation`) or a city anchor, and the card shows **"2.3 km away"**. Declining location keeps the full catalog with an honest sentence — never a dead end.
- **Providers set a STATIC service base** at onboarding: typed address → geocoded (`/api/geocode`) → confirm. Not device location; that is Step-15 tracking.

### 🔴 The coordinate-privacy invariant was strengthened, because "distance only" did not deliver it

The spec treated *"the RPC returns distance, not lat/lng"* as the safety property. It isn't sufficient. **The attacker chooses the origin.** Three calls from three points trilaterate a provider's exact home from the returned distances — the precise stalking risk `20260727120000` exists to prevent, with every coordinate column still correctly revoked.

**The fix: `geo` is a generated column snapped to a ~250 m grid (`ST_SnapToGrid`, 0.0025°), and the precise point never enters the matching path at all.** The RPC cannot leak what it never computes with.

- **Why snapping, not jitter.** A per-provider offset derived from the provider id is *reversible* — the id is in the URL, so a known algorithm is subtractable. Snapping **destroys** the information: even with full knowledge of the algorithm an attacker recovers the grid node, with the true position uniformly distributed in the cell. The guarantee survives the source being public. This is Airbnb's approach (approximate circle pre-booking), the settled answer where an individual's home is the service location.
- **Cost: none.** `STORED` generated column → the GIST index is built on the snapped point → `ST_DWithin` stays index-driven. Measured displacement 54–148 m; ranking moves ~3% at the 8 km decay scale.
- **Consequence for the UI:** distances render to **one decimal**. `2.31 km` would advertise precision that deliberately does not exist. Asserted.

### Two deviations from the spec's migration, both load-bearing

1. **PostGIS installs into `extensions`, not `public`** — every other extension here does. The spec's `SET search_path = public` would leave `ST_Distance`/`geography` unresolvable and the function would fail to create. All PostGIS references in DDL are schema-qualified because generated-column expressions resolve at DDL time.
2. **A separate `set_provider_service_base` RPC** instead of new parameters on `submit_provider_application`. Adding parameters would create an **overload**, not a replacement, and PostgREST could no longer resolve the existing 9-argument call. It also means moving your base never re-stamps `applied_at` or re-enters the application gate — **verified: status, is_verified and applied_at are untouched by a base change.**

### Found while verifying my own migration (⚠️ read this before writing another definer function)

`20260818120000` did `REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO authenticated;` and I read that as "anon excluded". **It isn't.** Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role`, so a new function is created with EXECUTE granted **directly to `anon`** — and revoking from `PUBLIC` does not remove a direct role grant. The first verify run passed on *"No provider application found"*, which looked like a refusal but was actually anon executing the function and matching no row (`auth.uid()` is NULL). `20260818130000` closed it with an explicit `must be signed in` guard, a named `REVOKE … FROM anon`, and a `DO` block that fails the migration if either half stops holding.

**The lesson generalises: "it happens to write nothing" is not "it refuses", and a test that accepts any error will not tell them apart.**

---

## Known-open — tracked, low priority (⚠️ not regressions, do NOT re-flag as new bugs)

- **Most `SECURITY DEFINER` functions in `public` are executable by `anon`** — ambient, pre-existing, and NOT a Step-11 regression. Same root cause as the note above (Supabase's default function privileges). `submit_provider_application`, `transition_booking`, `submit_review`, `respond_offer`, `start_negotiation` and others each defend themselves with an internal `auth.uid()` check, which is why nothing is exploitable today. But the outer fence is missing across the board and every one of those functions moves money or state. **Deliberately not swept during Step 11** — auditing ~15 money- and state-changing functions is a security-scope session, not a footnote to a matching step. Do it before public launch.
- **The geocoder is Nominatim (OpenStreetMap), keyless.** Fine for launch scale: onboarding-time only, one call per provider, server-proxied with an identifying User-Agent and a 1 req/s throttle (their usage policy). It is **not** a production geocoder at volume — Architecture §3 names Google/Mapbox, and `GEOCODER_URL` / `GEOCODER_USER_AGENT` exist so the swap is config, not code.

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
- **Provider substitution (sending someone else): rejected (❌).** Destroys the verified-individual trust model and creates a safety liability. The "provider is busy / knows someone capable" case is served by **that person onboarding as their own verified provider**, not by substitution. *(The supply-side version of this same problem — a shop dispatching whichever worker is free — is answered in "Supply-side model" below.)*

---

## Supply-side model — individuals vs shops (architectural, decided pre-Step-11, ⏸️ POST-LAUNCH)

Real Indian trades often run on **shops that dispatch interchangeable workers** — an electrician-shop owner sends whichever of his two or three workers is free. That collides head-on with Seva's core promise (**verified individuals with portable reputation**): the customer read reviews for the shop, but a stranger arrives, so the reputation they trusted describes nobody who is in their home. **This is the substitution problem again, arriving from the supply side instead of the fraud side** — and it gets the same answer, because the reasoning that rejected substitution above does not stop applying just because the request comes from an owner rather than a provider.

**Decision — a two-tier model in which the INDIVIDUAL is always the unit:**

- The **worker is always the provider** — own profile, own KYC, own reputation. Non-negotiable; this is what Seva *is*, and no affiliation arrangement may erode it.
- A worker MAY **affiliate with a shop/org**. The shop gets a page and an owner dashboard, **earns a cut of its affiliated workers' jobs**, and carries a **blended** reputation derived from theirs.
- Customers always book a **named individual** ("Suresh, 4.8★, affiliated with Ravi's Electrical"), never "an electrician from the shop". The reputation is Suresh's; the shop rides on it.

**Why this shape and not the obvious two:** it converts the shop owner from an obstacle into a distributor. The naive objection to individuals-only is *"why would the owner let his workers join?"* — he'd read it as poaching. Under affiliation he profits from their platform jobs and his shop's standing grows through them, so he **wants** them on Seva; but he still **cannot** dispatch a substitute, because the booking names a person whose own reputation is on the line. The incentive is aligned *with* the trust model rather than against it.

**Rejected alternatives (both are coherent — they're rejected for what they cost):**
- **Individuals-only forever** — fights the existing shop economy, so supply acquisition stays hard in shop-dominated trades.
- **Shops-as-providers** — this is Urban Company, the employment model Seva defines itself against (`CLAUDE.md`: *a store of individuals, not an employer of workers*). Reputation detaches from the person and the "verified individual in your home" promise is gone.

**Sequencing — do NOT build this now (⏸️).** Orgs, affiliations, revenue splits and blended reputation are a large entity model; bolting them on now would derail matching and probably the reputation engine. **Launch with individuals only** — independent tradespeople who want direct customers without a shop's cut exist in quantity, and that is all launch requires. Supply in shop-dominated trades is a **go-to-market problem, not a Step-11 problem**: add affiliation when real customer demand exposes a supply gap you cannot fill. Recorded here now so it is neither lost nor allowed to creep into Step 11.

---

## Location & tracking — two features that merely share an input (decided pre-Step-11)

A recurring source of confusion, named here because it makes Step 11 feel far bigger than it is: **proximity-matching and live tracking are separate features that both happen to use location.** Keep them apart.

> ✅ **Step 11 is now BUILT** — see "Step 11 — PostGIS matching & ranking" below for what shipped, including the grid-snap hardening the coordinate invariant turned out to need. The split described here held: matching took one static point per provider and nothing else. The map-pin half of "address and/or pin" was not built — typed-address geocoding covers it; a pin needs a map dependency and can come later.

- **Matching (Step 11 — NOW).** Needs location **once, at search time**: the provider's **service base** (typed address and/or a dropped map pin, geocoded to lat/lng, set at onboarding) and the customer's search location (**"near me"** device geolocation *or* a typed address, with the existing city-list fallback when permission is declined). Rank by distance + reputation + availability; return **distance only — coordinates never leak** (existing safety invariant). **One static location per provider. No device tracking, no animation, no ETA.**
- **Live tracking (Step 15 — LATER).** The Uber-style experience: continuous device GPS between `en_route` and `arrived`, "he's 5 minutes away", the moving dot, the path, the ETA — needing realtime streaming, maps, and battery/permission handling. This is also the **only** place where two further distinctions matter: **urgent** (watch the provider approach live) vs **scheduled** (check the ETA before a 5 pm appointment), and the **dual location** a shop-affiliated worker has (the shop's fixed base vs the worker's live position — which additionally depends on the post-launch affiliation model above). All of it ships with the arrival OTP. **Do not pull any of it into Step 11.**

**Why the split matters:** designing live tracking now is precisely what makes matching feel overwhelming — it mixes a simple static feature with a hard realtime one, and the hard one has no bearing on *ranking*. Both the urgent and the scheduled case need the identical thing from matching: one provider location, one customer location, distance computed once. Their difference only appears once movement is being shown.

**Effect on the Step 11 spec: essentially none.** The playbook already says *"give providers a geography point + service radius"* and Architecture §5 already filters with `ST_DWithin` — both are static-service-base by construction. The single clarification is **how that point is captured: address text and/or map pin at onboarding, never the provider's live device location.** A provider is not always standing at their base, and their base is what ranking needs.

---

## Feature-enablement conditions — when deferred payment options become safe to turn on

> These are **preconditions, not a backlog.** Enable by precondition, **not** by calendar date or feature-parity envy. A future session must not switch these on just because they're stubbed and "look ready."

### Cash / COD — enable only when payment can be ENFORCED
Cash has no escrow protection; the platform never holds the money, so it cannot claw it back. Safe to enable **only when ALL of these exist**:
1. **Two-sided cash confirmation** built — both customer *and* provider confirm the cash changed hands; neither self-attests alone; a mismatch opens a dispute. (Provider must NEVER be able to mark themselves paid — same self-attestation rule as everywhere.)
2. **Dispute cash-path** built — the "I paid" / "they didn't" mismatch resolves through the admin/evidence flow.
3. **Reputation-gated eligibility** — new/low-reputation customers get no COD (or a tiny cap); COD unlocks as they build trustworthy history. (Reputation engine exists; the gating rule does not yet.)
4. **Incentive alignment** — online remains the priced/nudged default so cash self-selects to a small, watchable population.

Until all four: **Cash stays off.** This is the fraud hole deliberately closed at launch — do not reopen it early. *(Enforced in the DB today: the INSERT-only COD guard from `20260721120000` refuses new `payment_method='cod'` bookings.)*

### Seva Wallet (CUSTOMER prepay balance) — enable only when money can be HELD responsibly
⚠️ **Distinct from the existing provider payout ledger**, which is live and is NOT this. A customer-facing prepay balance is new, unbuilt, and higher-risk (holding customers' funds). Safe to enable **only when ALL of these exist**:
1. **Top-up flow + reconciling ledger** — customer loads money via UPI; every rupee in/out/held is a ledger entry that reconciles exactly.
2. **Refund & closure rules** — how a customer withdraws their balance, and what happens to it on account closure — answered **before** holding a single rupee.
3. **Regulatory check** — holding customer prepaid balances can trigger RBI prepaid-instrument (PPI) rules in India; get a real look before enabling, not after.
4. **A concrete benefit over UPI** — instant refunds-to-wallet, cashback, or faster checkout. If UPI already does the job, the wallet is complexity for its own sake.

Until all four: **customer wallet stays off.** "Uber has a wallet" is not a reason — Uber's solves a problem; only build ours when it solves one of ours.

### (22) Honest signposting of unbuilt features (✅ DONE — principle, applies app-wide)

Anywhere a capability is deferred, show a calm **"Coming soon"** or **"verified manually for now"** — **never** a dead button, a silent no-op, or an alarming "not connected" error. An error voice for a feature that was simply never built reads as an outage the user has hit: something broken, possibly their fault, possibly worth retrying. It costs trust and generates support contacts about a system working exactly as intended.

As applied:

- **Checkout** — Cash and Seva Wallet are **shown, disabled, and labelled "Coming soon", each with the reason** ("Cash can't be held in escrow…", "A prepaid Seva balance… not open to customers yet"). Listing them is what makes the checkout look complete and the roadmap legible; saying *why* is what stops "Coming soon" reading as an arbitrary restriction.
- **KYC / DigiLocker** — the control reads **"DigiLocker · Coming soon"**, and the message is *"DigiLocker is coming soon. For now, upload the document and our team verifies it — usually within 24–48 hours."* It previously said **"DigiLocker isn't connected yet"**, which sounds like a fault. Upload is now phrased as the active path (**"Upload"**), not the consolation prize (**"or upload"**) for a control that cannot do anything.
- **EPFO** — absent from the UI entirely (item 11, rejected for launch). Verified: no `.tsx` surface references it; only an unused adapter export remains in `lib/provider-application.ts`.
- **Footer** — the audit turned up the worst case of this: **seven of nine footer links pointed at `/how-it-works`**, so "Privacy Policy" silently delivered the how-it-works page. A misrouting link is worse than a dead one — the user cannot tell whether they misread it or the site is broken. Unbuilt destinations (About Us, Careers, Press & Media, Help Center, Safety Guidelines) now render as plain text with a "Soon" chip rather than links that go somewhere else.

> ⚠️ **Privacy Policy and Terms of Service are a LAUNCH BLOCKER, not a "coming soon" feature.** They now carry the same honest "Soon" chip, which is better than misrouting — but they are a legal requirement for a marketplace handling payments and KYC documents in India, not an optional page. **The label must not become the reason they are forgotten.** They need real content before public launch; the chip is a stopgap for a pre-launch build.

**How to apply it to something new:** show it, disable it, label it "Coming soon", say why in one line, and make sure the working alternative is the visually primary control. Never leave the reason to a tooltip alone.

### 🔴 Item 18 was REVISED here — the earlier "no chooser at all" is superseded

The first implementation removed the payment chooser outright, and this log carried a note arguing checkout should *not* signpost deferred methods. **That is no longer the decision.** The current, intended behaviour is the one described above: the full list is visible, only UPI is selectable.

Recorded because the reasoning still matters and will resurface:

- The concern was that a disabled "Seva Wallet" implies we hold customer balances (we do not — see the two-wallets warning above) and that a greyed "Cash" advertises the off-platform arrangement escrow exists to prevent.
- The answer is the **reason line on each entry**, which the earlier version lacked. "Cash — Coming soon" alone invites the customer to ask for it off-platform; "Cash — can't be held in escrow, so we can't protect or refund it yet" tells them why the platform is safer, at the exact moment they are deciding.
- The assertion changed with it and is now **stronger**, not weaker: `ui-check-step10` no longer checks "there is nothing to click" but that **every control in the Payment section is disabled**, that Cash and Seva Wallet are each present-and-disabled, and that both carry a "Coming soon" label. The property that protects the customer is *non-selectability*, not absence.
- **Defence in depth is unchanged:** a `disabled` attribute is a UI affordance, never a control. The DB still refuses both on INSERT — the COD guard (`20260721120000`) and the wallet guard (`20260817120000`).

---

## Principles reaffirmed during the issue passes

- **Friction asymmetric to intent:** customers frictionless; providers do a short, one-time, honestly-status'd application; strict guarantees underneath.
- **Whoever benefits from a claim doesn't get to make it:** providers can't self-verify, self-rate, or self-mark-paid; customers confirm payment; the system (webhook) confirms online payment.
- **Simple interface, strict guarantees** — simplify UX, never simplify away a safety gate.
- **Browser verification catches what scripts can't** — the Bucket-B trust-tier and `category_usage` defects were both "the DB was right, the screen was wrong / the grant leaked"; only a real browser + a discriminating assertion surfaced them.
