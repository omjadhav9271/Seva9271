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

### Scale test — 485 providers across 7 regions (2026-08-10)

`scripts/seed-scale-providers.mjs` seeds hundreds of approved providers across real localities in Bengaluru, Pune, Mumbai, Mumbai Suburban, Thane, Kalyan-Dombivli and Navi Mumbai (`--purge` removes every one via the `auth.users` cascade). What it established:

- **The GIST index is used and it is fast.** `Index Scan using idx_providers_geo`, 12 ms in the DB, **52–77 ms median end-to-end** from a client in India, at 485 providers with 173 inside a 25 km radius.
- **Cross-region isolation is correct.** Bengaluru returns only Bengaluru (96), Pune only Pune (78). The MMR origins legitimately span adjacent cities — Andheri→Dombivli really is ~24 km.
- **🔴 The ~250 m grid snap does NOT collapse micro-locality ranking**, which was the open question when the snap was chosen. From Khadakpada, Kalyan West, providers resolved distinctly at 0.13 / 0.18 / 0.37 / 0.64 / 0.92 / 1.1 / 1.4 / 1.7 km, and reputation still beat proximity across that range: **Birla College Road at 1.1 km (rep 4.87) outranked Kala Talao at 0.18 km (rep 3.99)** — six times farther and still first.
- **Reputation's effect grows with density.** At 5 providers, zeroing one reputation moved it rank 1 → 4. At 485, the same change pushed it **out of the top 30 entirely**. `verify-step11` now treats falling out of the result window as the stronger pass it is, instead of comparing a number against `undefined`.

**A UX defect the density exposed, now fixed:** `formatDistance` rendered everything under a kilometre as **"Under 1 km away"**. In a dense locality that is most of the page — 7 of the top 12 in Kalyan — collapsing 130 m and 920 m into one label, so the customer could not tell next-door from a 12-minute walk. Sub-kilometre distances now render in **100 m buckets** ("~400 m away"), which sits just outside the ±139 m snap bound: informative without overclaiming. It only became visible with realistic density; five providers spread across Mumbai never showed it.

### Two real Step-11 bugs, found by using it (2026-08-10) — migration `20260819120000`

Reported from actual use: *"I chose a location and Electrician, it didn't give sorted results and didn't show how far away the provider is."* Both causes were real, and both were invisible at 5 providers.

**1. The city dropdown offered cities the ranking could not honour.** `/providers` built its dropdown from the cities present in provider rows, while `CITY_ANCHORS` was a hardcoded list of four (Mumbai, Thane, Navi Mumbai, Pune). Picking anything else — **Kalyan, Bengaluru, Mumbai Suburban, i.e. 312 of 485 providers** — found no anchor and fell silently back to the unranked catalog: no match ordering, no distances, no explanation. Fixed by `city_anchors()`, which derives the list from the data, so *the cities offered* and *the cities we can rank from* are the same set by construction. Privacy is preserved by two guards: **a city needs ≥3 providers** (a centroid over one provider IS that provider's snapped point) and the centroid is **snapped to a ~2.2 km grid**, making it a city-level point rather than anything traceable to a person. The migration fails if either guard stops holding.

**2. The category filtered the results, not the query.** `/services` called `search_providers` unfiltered with `limit 60` and then filtered by category in the browser. **A filter applied after a ranked cut is a sample, not a filter:** electricians near Kalyan showed **2 of the 7** in range, and the 5 it dropped included nearer ones. The category id now goes into the RPC, and changing category re-queries rather than re-filters.

Also added: a **"Nearest first"** sort. *Best match* trades distance for reputation, which is the right default but not always the question being asked — someone who needs a plumber now wants nearest, and there was no way to ask for it.

Both are asserted in `ui-check-step11`: every option in the city dropdown must have an anchor **and** actually produce distances when picked; a category-filtered search must return *all* in-range providers of that category, not a sample of a wider ranking.

---

## Search & location (post-Step-11) — ✅ DONE

Migrations `20260822120000_seva_search_sort.sql` and `20260823120000_seva_booking_service_location.sql`. Three things: stop showing blank pages, make the controls human, and give the provider a way to actually reach the customer.

- **Widening search, not a fixed radius — ✅** A 25 km `ST_DWithin` returned **nothing** when the nearest provider was 26 km away: a blank screen, which reads as a broken product rather than as thin supply. The client now tries **15 km → 50 → 150**, stopping as soon as three come back, and says *"Nobody within 15 km — showing the nearest within 50 km"* when it had to widen. Past 150 km it returns empty and the page says **"No providers serve your area yet — we're expanding."** The cap is the point: an electrician 400 km away is not a result. **Client-side loop, deliberately** (three hardcoded tries in `lib/matching.ts`) — the alternative was a plpgsql radius loop plus another DROP+CREATE of `search_providers`, for a behaviour the UI has to explain anyway. Widening never relaxes a filter: it finds more people, it does not quietly drop "available now".
- **The sort runs in the query — ✅** `p_sort` (`match` | `distance` | `rating` | `reviews` | `price_low` | `price_high`) chooses the ORDER BY. This was the last member of the filter-the-page family: a client-side "Top rated" over a match-ranked cut shows the best rated **of the 60 that came back**, so the genuinely best-rated provider in range sat unreachable at rank 61 while the control looked like it worked. 🔴 **`match_score` is byte-for-byte unchanged** — only the ORDER BY moved, so "Best match" still means what every prior ranking assertion measured.
- **Human controls, not thresholds — ✅** A segmented toggle (**Best match · Nearest · Top rated**) plus a **More…** dropdown (Most reviewed · Lowest price · Highest price) and an **Available now** checkbox, on both `/services` and `/providers`. Six pills would be a wall rather than a choice, so the three a customer reaches for are one tap and the long tail is two — but every one of the six is a `p_sort` value, never a client-side re-shuffle. **A reputation-score or trust-tier threshold was rejected (❌):** the numbers exist and a slider is easy, but asking a customer to set a minimum on a manipulation-resistant composite hands them our job — the ranking already weights reputation and verification. The star-rating floor stays ("4+" is a control people already understand).
- **Price sorting has a trap, now closed — ✅** `hourly_rate` is **0** for providers who quote per job; the card renders that as *"Custom pricing"*, not free. A plain `ORDER BY hourly_rate ASC` opens the cheapest page with every provider who has no price at all — useless, and a lie about what they cost. `NULLIF(hourly_rate, 0)` with `NULLS LAST` on both directions puts them at the **end** of cheapest *and* dearest: unpriced, not extreme. (This is also why the descending sorts are written as negated ASC clauses — a bare `DESC` flips to `NULLS FIRST` and would put them back on top.)
- **Catalog mode sorts client-side, on purpose — ✅** and the distinction is the whole lesson: the unranked catalog query returns **every** approved provider, so ordering it orders the entire set. Ranked mode returns a **cut**, where the same code would be the bug. `catalogComparator` carries that warning at its definition; if a limit is ever added to the catalog query, it becomes unsafe.
- **Two precisions, two jobs — ✅** *Ranking* uses a **coarse** origin: GPS if already permitted, else a typed **pincode** mapped to an existing city anchor, else the city picker. GPS **prefills an editable field and never locks in as "home"** — people search for a parent's flat or an office — and it is only read without prompting when permission was already granted. **We do not geocode (❌):** a pincode is enough for an 8 km decay curve, and our own geocoder already fails on the Indian addresses that matter (*Prem Auto*, *Don Bosco School*). *Navigation* uses the **precise** typed address, handed to Google Maps, which geocodes it far better than we would.
- **The service address is ON THE BOOKING, revealed after acceptance — ✅** Captured per booking, **not** as a profile home address (❌): a customer books for their flat, then a parent's home, then the office — one stored address is wrong for most bookings and sends the provider to the wrong door. `bookings.address` + `service_pincode` + an optional map pin **lost their SELECT grant** (same mechanism as the provider coordinate lockdown) and are readable only through `booking_service_location()`, which decides per caller: the customer and admins always; the **provider only from `accepted` onward**. Before that they see the **pincode only** — enough to judge the trip, not enough to find the door. 🔴 **The boundary is `accepted`, not the `confirmed` status**, which in this state machine means the customer confirmed the work is *done* — gating on it would hand over a navigation address after the job. Cancelled and expired close it again. **Reviewed against the working feature and deliberately kept at `accepted` (2026-08-10)** — the provider needs the address to plan and travel, which is the entire purpose of revealing it, and every earlier state (`requested`, `negotiating`) is a booking that may never happen. Do not "tighten" this to `en_route` or `confirmed` without a reason that outweighs that.
- **Navigation is delegated — ✅** An **Open in Google Maps** button (directions to the address; the optional GPS pin offered as a secondary link for when Google can't place the words). No in-app map, no route, no ETA, no live position.

### Three defects found by driving it in a browser (2026-08-10) — none visible to the DB suite

Each was invisible to 33 green DB assertions, because each lived in *when the page asked*, not in what the database answered.

- **The reveal did not appear until a reload.** `handleTransition` updates the status **optimistically**, so the effect that re-reads the address fired while `transition_booking` was still in flight; the RPC correctly answered *"still requested → withheld"*, the status never changed a second time, and the provider sat looking at *"unlocks once you accept"* on a booking they had just accepted. Fixed by refreshing the location **after the server confirms**, not merely when the local status string changes. Asserted in `ui-check-step10` with a marker that does not survive a reload, so the check proves the reveal was *live*.
- **`?city=` was silently overwritten by the GPS prefill.** Arriving from the homepage hero ranked from the chosen city and then jumped to "your location", because the prefill's closure read a stale `origin` after two awaits. **This is the same defect the hero control already has a note about** — a customer's explicit location choice being discarded — arriving by a new route. Fixed with an `autoLocate` prop (off when `?city=` is present) *and* a live `originRef` guard, so a choice made while the prefill is in flight always wins.
- **🔴 Ranking was non-deterministic under ties** — migration `20260824120000`. The same search returned `Prakash Nair, Nikhil Naik` at `LIMIT 30` and `Nikhil Naik, Prakash Nair` at `LIMIT 60`: identical `match_score`, identical rounded distance, so every ORDER BY key was equal and the plan decided. **Not just a flaky test — a fairness problem.** Ties are common (a blend of rounded inputs over a dense population), every filter change re-queries, and position 1 is worth real money to whoever holds it. Fixed with a final `sp.id` tie-break: arbitrary, but the *same* arbitrary answer forever. `CREATE OR REPLACE` with an unchanged signature, so no overload risk.

**A check-design note worth reusing:** `ui-check-step11`'s "before sharing a location" section *granted* geolocation and then asserted the un-located state. That was harmless while location was only read on click, and became wrong the moment the control learned to prefill — it passed standalone and failed inside `verify-all`, the classic signature of a check racing the app rather than of a wrong expectation. The precondition is now **explicit** (permission denied), and the prefill has its own positive assertion. Adding a second `<select>` to those pages also broke three assertions that said `document.querySelectorAll('select')`; they are now scoped by `aria-label`. **When a UI check starts reporting nonsense like "cities that cannot rank: reviews, price_low", suspect the selector before the feature.**

**Still deferred (⏸️), unchanged:** live tracking, the moving dot, ETA and the arrival OTP remain **Step 15** — nothing here moves toward them, and `search_providers` still returns distance only. The **map-pin picker for the provider's service base** is still unbuilt (typed-address geocoding covers it); the geocoder's failure on small Indian landmarks is still open and is still the strongest argument for it.

**Open / worth knowing:**
- `notes` is free text the provider can read from the moment a booking exists, so a customer *can* type their address into it. The structured field is protected; a sentence cannot be. The booking form labels the address field as where the address goes, which is the part we control.
- The pincode→city map in `lib/matching.ts` covers the seven rankable cities (Mumbai, Mumbai Suburban, Thane, Navi Mumbai, Kalyan, Pune, Bengaluru). Every target resolves against the **live** `city_anchors()` list, so it can never offer a city we cannot rank from — an unrecognised pincode falls through to the picker rather than guessing. Extend it when real supply reaches a new region.

---

## Realistic data, pincode precision & scale (2026-08-11) — ✅ DONE

Prompted by a real observation: *"best match or nearest is not working on seeded data"*, plus *"I don't like selecting a city — in India a small place holds a large population"*, plus *"can the system handle 60 / 600 / 1000 providers for a category?"*. All three were right, and the first was right for a reason nobody had guessed.

### 🔴 The ranking was never broken — the seed data made it untestable, and the nightly job proved it

Measured before touching anything: **484 providers claiming 76,367 reviews between them, against 8 actual rows in `reviews`**, and only **3 distinct `reputation_score` values** (sd 0.078) across 485 providers.

The old seeder wrote `reputation_score` directly. `nightly-reputation` then recomputed every score from real reviews at 02:00, found none, and returned the Bayesian prior for everyone — flattening the spread overnight, every night. **You cannot fake reputation_score; the engine owns it (invariant 1) and will overwrite you.** That is the system working correctly.

With the reputation term constant, `match_score` collapsed to `0.45 × proximity + 0.10 × availability + a constant`, so **"Best match" and "Nearest" returned the same top-10 set**, merely reshuffled. And because `rating` was fake (48 distinct values on one page) while `reputation_score` was real (2 values), the number shown and the number ranked on described different worlds — a 4.96★ provider sat below a 3.4★ one with no explanation available to anyone.

**The fix is to seed INPUTS, not outputs.** `seed-scale-providers.mjs` now gives each provider a hidden `quality`, generates real bookings and dated reviews as noisy samples of it, lets the `update_provider_rating` trigger set `rating`/`total_reviews`, and calls `recompute_all_reputation()` — the same function the cron runs. Nothing writes a score. Result: **99 distinct reputation values (sd 0.205)**, Best-match vs Nearest overlap **10/10 → 5/10**, and it survives 02:00 because the numbers were always the engine's own. Review counts follow a heavy-tailed mixture (18% have none) so Bayesian shrinkage is visible; ~8% quote per job, so the "Custom pricing" branch and the unpriced-sorts-last rule are exercised instead of being dead code.

**Migration `20260825120000` fixes the same disease at its source:** the four `@seva.demo` providers seeded by migration `20260710121000` claimed 312/205/128/96 reviews with **zero** rows — baked into a migration, so every fresh database was born with it, and it defeated the rating filter ("4+ stars" admitting a provider on the strength of reviews that don't exist). Counters are now reconciled from the reviews table, and the migration fails if any still disagree.

### Location is a PINCODE, not a city (migration `20260826120000`)

A city is not a location in India: Greater Mumbai is ~12 million people across 60 km, and the city anchor sits near Fort — so a Borivali customer was ranked from **17 km away**. The first pincode implementation made it worse by mapping pincodes to *city* anchors, throwing away the precision that made pincodes worth asking for. Measured after the fix, four Mumbai pincodes resolve to four points spanning **5.3 / 12.5 / 17.3 / 20.1 km** from that single old anchor.

**❌ A pincode reference table was rejected, and the reasoning is the part to keep.** Shipping one means *supplying coordinates for pincodes* — from an external dataset (a licensing and freshness dependency) or from memory, which is **fabricated geodata**: invented numbers that ship looking authoritative and silently mis-rank real people, with nothing in the system able to detect it.

Deriving anchors from providers has a property no reference table has: **nobody ever states a pincode's coordinates.** The provider states their own pincode — a fact about themselves — and the position comes from a service base we already verified. A mistyped pincode groups someone oddly; it cannot invent a place. `resolve_pincode()` answers at the finest grain the data supports (exact pincode → 3-digit sorting district) with the same ≥3-provider and grid-snap guards as `city_anchors()`, and reports **which** grain, because "near 400097" and "near the 400 area" are different promises.

**Honest weakness, recorded not hidden:** this only resolves pincodes where we have supply. Where we don't, it degrades to the district — and that is exactly where a customer most needs a true distance. It is bounded (thin supply means the honest answer is "nobody near you yet" anyway) but real. The upgrade, when it earns its dependency, is a geocoder-backed pincode cache filled once per pincode server-side; the table is already shaped for it via `source`.

**The city dropdown is gone from both pages** — it does not scale past a handful of Indian cities. An uncovered pincode gets a plain sentence plus a few clickable areas we genuinely cover: a short list of places that work, not a dropdown of everywhere we might one day be. `/providers` gained a **category dropdown** in that slot, which is what customers actually filter on. **Name search stayed** (asked for, and "the electrician my neighbour recommended" is a real journey) — repositioned to narrow *within* a category.

### 🔴 The 1,000-row cap: the same bug, three times (migration `20260827120000`)

PostgREST caps result sets at 1,000 rows. At **1,085 approved providers** that stopped being theoretical, and it bit in three places:

1. **The catalog** on `/providers` and `/services` was an unbounded select — returned exactly 1000, silently, hiding 85 providers. Worse, `catalogComparator` sorted them client-side *believing it had the complete set*; its own comment had warned "if you ever add a limit to the catalog query, this becomes the bug it was written to avoid." PostgREST added the limit for us. Both pages now bound and **server-order** the catalog, with category, availability, rating floor and text pushed into the query — bounding it turned every remaining client-side filter into the same sample bug, so they had to move together.
2. **The admin review queue** selected every row with `applied_at` — 1,082 of them, truncated to 1,000 *oldest-first-dropped*, so the one genuinely pending application fell off the end and the console showed an empty queue while an applicant waited. Its follow-up `.in(provider_id, [1000 uuids])` then exceeded the URL limit and returned Bad Request, which the route destructured away — every completeness count silently became "0 of N". Now: the backlog is fetched separately, oldest-waiting first, bounded, with `.in()` chunked and its failure returned loudly instead of read as "no documents". Counts are returned so the console can say what it is not showing.
3. **`verify-step9`** enumerated every approved provider and searched client-side, reporting "approved provider still missing from the list" for a provider that was perfectly visible. Now it asks about that provider directly — testing the property instead of by enumeration.

**Pagination:** both pages show 30 and offer "Show 30 more". "Is there more" is answered by asking for one row past the page — no count query that could disagree with the list it labels. Offset paging is safe now only because `20260824120000` made the order deterministic.

**`price_sort`** (generated `NULLIF(hourly_rate,0)`) exists because PostgREST cannot express that in an `.order()` clause, and without it the catalog's "Lowest price" opens with every provider who has *no* price — useless, and a lie about what they cost.

### What the scale harness proves (`scripts/verify-scale.mjs`, 35/0/1)

The central assertion is the **prefix property**: for the same query, `limit N` must equal the first N of `limit BIG`. It is the formal version of "the page you see is the top of the list you asked for", and one property catches three bug classes — non-deterministic ordering, a cut taken before the sort, and unstable pagination. Verified at 24 / 96 / 555 / 671 / 911 matches, across all six sorts, plus filter integrity at every size and **45–62 ms per page**.

### Seed data that the ENGINES can read (2026-08-11, second pass)

The first pass fixed `reputation_score`. The same disease turned out to be in two more places, and the pattern is the thing to remember: **Seva derives three verdicts from evidence, and the seeder was writing verdicts.**

```
rating / total_reviews  ←  reviews                (update_provider_rating trigger)
reputation_score        ←  reviews + outcomes     (compute_reputation)
trust_tier              ←  verified documents     (recompute_trust_tier)
```

- **🔴 `trust_tier` was fabricated for 435 providers** — tier 2 or 3 with **zero** verified documents. `recompute_trust_tier()` derives it from `provider_documents`, and `nightly-expire-documents` re-runs that logic, so those tiers were fiction with an expiry date exactly as the reputation scores had been. The seeder now writes documents (photo_id + selfie for everyone; a credential for ~30%; an in-date police check for ~8%) and calls the function. Note `pan`/`id_secondary` are deliberately not used as the credential — 20260817120000 excludes them so a PAN photocopy cannot buy the tier a trade certificate means.
- **Bookings had no history.** 20,202 seeded bookings shared **145 `booking_events`** and **24 `payment_transactions`**, so every seeded booking rendered an empty timeline and the escrow ledger described almost none of the money the platform believed it had moved. Now a full transition trail per booking (144,795 rows — `17,851×8 + 1,147×1 + 140×6`, arithmetic that matches exactly) and a payment row per settled booking, in **paise**, with the 1% split. The trail is synthesised rather than driven through `transition_booking` (~7 authenticated RPCs × 20k bookings is unaffordable); shapes were copied from real rows rather than invented, and the fidelity contract below enforces the match.
- **The `@seva.demo` providers get real history too.** 20260825120000 correctly reset them to "New on Seva", which was truthful but left the four best-known names looking empty. They are real approved providers and now look like it.
- **~8% quote per job** (`hourly_rate` 0), so the "Custom pricing" UI branch and the unpriced-sorts-last rule are exercised instead of being dead code.

### The contract: `scripts/verify-data-fidelity.mjs` (16/0/4)

The three failures above were not really seeding bugs. They were one missing rule: **nothing asserted that a stored verdict must be derivable from stored evidence.** This file is that rule, and it runs against **all** data rather than seeded rows — a production row that violates it is the worse bug, and if it only checked seeds it would have to know which rows are seeds, which is precisely the distinction that should not exist.

It re-derived the entire hand diagnosis independently, which is the point: the next occurrence costs seconds. Its skips are enumerated exclusions, not holes — six trail-less bookings and one payment-less booking belong to verify-suite fixtures (inserted directly at a chosen status, so legitimately trail-less). They are **not deleted**: several feed the accumulated reputation fixtures `verify-step7`/`step8` assert against on a 2-decimal knife-edge, and perturbing the system to make a new checker green is the wrong way round.

Two of its own bugs are worth recording, because both are the same family this log keeps documenting:
- it shipped with `range()` paging and **no `ORDER BY`**, reporting "82 providers never scored" and "6 bookings with no events" — *misses*, not violations, indistinguishable from real findings by eye. Third occurrence of unstable pagination in this codebase (after `search_providers` and the seeder itself, on the same day). **Assume any `range()` without a total order is wrong.**
- it conflated **arithmetic** with **policy**: eight real payments charge 15% because that is what the platform charged when they were taken. They balance perfectly. `fee + provider = amount` is the invariant; the 1% *rate* is policy that changed, so it is asserted only for rows written since 20260730120000.

### ⚡ The catalog was being fetched and thrown away (efficiency)

`providers = ranked ?? catalog`, so once a location is known the catalog is dead weight — but its effect depended on every filter, so **each sort/category/availability change fired a second full query whose result was discarded on arrival**. Two round trips per interaction, one pure waste, and invisible to the existing "no re-query loop" assertion because that one counts only `search_providers`. Now guarded, and `ui-check-step11` counts catalog reads separately: a filter change while ranked must cost **one** query.

🔴 **The guard hung the page on the first attempt, and the lesson generalises.** The catalog fetch starts on mount; the GPS prefill sets `origin` while it is in flight; the effect re-runs, its cleanup marks the first run stale, and that run's `if (!mounted) return` skips its own `setLoading(false)`. An early `return` in the new run meant nothing ever cleared it — so exactly the customers who had already granted location sat on "Loading providers…" forever. **An early return from an effect must still settle any state that effect owns.** Caught by the assertion added alongside the guard, which is the only reason it was not shipped.

**Still open:** both pages still make one catalog request on first paint before the prefill resolves. That one is unavoidable without knowing the permission state before render, and it is a single request rather than one per interaction.

### GPS is the primary location control — and the preference is EARNED (2026-08-11)

Asked for directly: *"give first preference to GPS everywhere, keep pincode secondary — it will improve accuracy."* Adopted **for the customer's search origin**, with two deliberate limits and one addition.

**✅ Layout now says what the product means.** The old arrangement — a wide pincode field on the left, a modest button beside it — read as *"type a pincode; there is also a location thing"*. GPS is now the full-width primary CTA with the benefit on the label ("finds people nearest you"); the pincode sits under it as the visibly secondary path. A device fix is typically 100–200 m where a pincode is a 2–5 km locality, so on the merits GPS genuinely does find nearer people.

**❌ The pincode is NOT hidden behind a toggle.** Collapsing it would add a click for exactly the people who cannot use GPS — desktop users, anyone who has denied the permission, anyone on a locked-down device. Honest signposting says show the alternative and let the hierarchy persuade. Preference, not coercion.

**✅ GPS now leads the PROVIDER'S service base too — and it retires a documented blocker.** This looks like a reversal of "never the device's live position" and is not: what changed is the *capture method*, not the model. It is a **one-time reading**, taken while the provider stands at their shop, which they confirm and which never updates itself. One static point per provider; continuous position is still Step-15 and still absent.

The reason to lead with it is the known-open geocoder failure, not a preference: Nominatim returned **no match** for *Prem Auto*, *Don Bosco School*, *Rita Memorial School* and *Mangla Park* during the Kalyan scale test — precisely the shop-and-landmark addresses Indian providers give. Such a provider could not set a base at all, so they never appeared in search. **One tap on GPS resolves it with no geocoder in the path**, and more accurately than any address lookup would have managed. This is the map-pin picker's job, done without a map dependency. The typed address remains in full for the provider who is *not* at their base while signing up — the case the original decision was written to protect, and still real. A fix rougher than **5 km is refused outright** for a service base: ranking rests on that point for as long as they trade, so a 42 km guess is not a base.

**Providers now also state their pincode**, written by a plain UPDATE on their own row rather than a new argument to `set_provider_service_base` (which would create the overload PostgREST cannot resolve — the trap from 20260818120000, hit twice since). This is the bootstrapping the `20260826120000` header flagged: `resolve_pincode()` builds locality anchors from pincodes providers state about themselves, so without real providers supplying one the customer-side pincode search only ever works on seeded data.

**❌ Device position still stays out of the BOOKING's service address.** GPS and a typed address answer *different questions*: GPS is *"where is this device now"*, an address is *"where do I want service"*. Someone booking for a parent's flat is not at that flat, so it remains an *optional* pin labelled "only if you are at the service address now", alongside a required address.

**⚠️ Known-open:** the provider-side GPS path is **browser-verified but not yet asserted**. `ui-check-step9` owns `/become-provider` and has a history of camera-related timeouts; adding to it was judged more likely to destabilise 48 passing assertions than to protect this one. Worth adding when that check is next touched.

**🔴 The addition that makes it honest: `coords.accuracy` was being thrown away.** Grep confirmed zero uses. We ranked from a 30 km IP guess exactly as confidently as from a 100 m fix. Desktop browsers geolocate by WiFi/IP — measured on this project at **124 m** on a home connection, but a VPN or corporate gateway can put the same call tens of kilometres out. So the fix is now graded and the verdict shown: **≤1 km** reports its precision ("accurate to ±135 m"), **1–5 km** adds "a pincode would be more precise", **>5 km** admits "your device could only place you roughly" and points at the pincode. *Telling the customer when GPS let them down is what earns the GPS-first default; silently ranking from a bad fix is how you lose it.*

**⏸️ Still no auto-prompt on page load.** In Chrome a DENIED geolocation permission is sticky per-origin, so a prompt fired before the visitor knows what the page is for is the one people reflexively dismiss — and that dismissal costs GPS for that site more or less permanently. You get one ask; spend it after they have seen what it is for. A browser that has already granted permission is still prefilled silently, which is the zero-friction best case.

**Two fixes that came with it:** the geolocation timeout moved **10s → 20s** (GPS is primary now, the spec is ambiguous about whether the permission-prompt wait counts against it, and a real prompt was observed sitting unanswered for ~55s; a cached fix returns in ~0ms so the higher ceiling costs nothing in the common case), and the failure copy stopped saying *"Pick your city instead"* — a control deleted with the city dropdown, whose wording was being patched by a `String.replace` at the call site.

**Verified against the real browser API, not an override** (2026-08-11): permission `prompt → granted`, a real fix at 12.6614/77.4505 accurate to **124 m**, source network/WiFi rather than device GPS, and a repeat fix in **0 ms** from the 5-minute cache. That real position sits ~40 km from the nearest provider, so it exercised the widening ladder by accident — *"Nobody within 15 km — showing the nearest providers within 50 km"*, 30 Bengaluru providers at 30–35 km. **Under the old fixed 25 km radius that real location would have rendered a blank page.** Asserted in `ui-check-step11`: the GPS control precedes the pincode field, a 40 m fix reports its precision and does not nag, and a 30 km fix admits it is rough.

---

## Known-open — tracked, low priority (⚠️ not regressions, do NOT re-flag as new bugs)

- ~~**`/services` hardcodes its own category chips.**~~ **RESOLVED (2026-08-10).** The page carried a 14-entry array against a 25-row table, so **11 categories — Laundry, Maid, Mason, Painter, Security, Tailor, Water Tanker, Mobile Repair, Cycle Repair, Auto Rickshaw, Cow Dung — could not be filtered from the browse page at all**, and its labels had drifted from the DB names ("Farm Fresh" vs "Farm Fresh Delivery"). Categories are admin-managed, so a hardcoded mirror is a bug waiting for the next insert. Chips now come from `service_categories`. What stays in code is only the *look* — `lib/categories.ts` maps slug → icon + colour + gradient, with a neutral default so a category added tomorrow renders correctly today instead of vanishing. `/providers` used the same shared map, replacing its own partial copy that covered 12 of 25 slugs (the rest rendered slate-grey). Long DB names are shortened for the chip only (`chipLabel`: "Mobile Repair / Accessories" → "Mobile Repair"); the card still shows the full name. Asserted in `ui-check-step11`: **every category in the DB must have a chip.**
- ~~**Text search on `/providers` filters the returned page, not the query.**~~ **RESOLVED (2026-08-10, migration `20260820120000`).** It was not the low-impact case it looked like: measured from Mumbai centre, typing **"electric" returned an EMPTY page while 11 matching providers sat in range**, because none of them happened to be in the ranked top 30 that the browser was filtering. `search_providers` now takes `p_query` and matches business name, category and city server-side. The function was **dropped and recreated** rather than gaining a defaulted parameter — `CREATE OR REPLACE` with an extra defaulted arg makes an *overload*, not a replacement, and PostgREST then cannot resolve a call matching both. Matching uses `strpos()` on lowercased text rather than `ILIKE '%'||q||'%'`, so a query containing `%` or `_` is literal text instead of a wildcard (verified: `50%_x` returns 0, not everything). The migration re-asserts the coordinate-privacy invariant afterwards, since the whole function body was rewritten. Asserted in `ui-check-step11`: a typed term must return **all** in-range matches, and the check reports how many the old top-30-then-filter approach would have found.

- ~~**Text search on `/services` filters the returned page, not the query.**~~ **RESOLVED (2026-08-10.)** The `/providers` fix above left its twin standing for a day, and this was the worse of the two: `/services` asks for **60** rows and filtered *those* by the typed text, so measured from Mumbai centre "electric" showed **2 of the 11** in range — 9 matching providers invisible, with no sign anything was missing. It matters more here than on `/providers` because **the homepage search box lands on this page**, so it was the defect most customers would actually meet. `searchQuery` now goes into `search_providers` as `p_query` (debounced 350 ms, the same as `/providers`), and the client-side match is kept only for catalog mode, where there is no query to push down. Verified in the browser: 2 → all 11. Asserted in `ui-check-step11` as its own section, so the two pages can no longer drift apart.
- ~~**The homepage's "Your location" box was wired to nothing.**~~ **RESOLVED (2026-08-10.)** The hero search wrote `?location=…`, and `/services` reads only `q` and `category` — so a customer typed their city, pressed *Find Services Near Me*, and landed on an unranked national list with their choice silently discarded. **The identical defect had already been found and fixed on `/services` itself** (its own dead "Location" input, replaced by the real location controls); the homepage copy of it was missed, which is how a dead control survived on the front door of a location-matching product. It is now a **city picker built from `city_anchors()`** — the same source `/providers` and `/services` use, so the hero can never offer a city that then fails to rank — emitting `?city=`, which `/services` honours on arrival by ranking from that anchor and reflecting the choice in its own picker. Empty stays a real choice ("Anywhere in India"), not a placeholder. Asserted in `ui-check-step11`: the free-text input must be absent, the offered cities must equal the rankable set exactly, and arriving with `?city=` must produce distances.

- ~~**`/services` rating floor and availability toggle filtered the returned page.**~~ **RESOLVED (2026-08-10, migration `20260821120000`.)** The last two of the family, and the reason the family kept recurring: the category and the text query were each moved server-side in their own session, while *these* stayed in the browser, applied to the 60 rows already ranked. So "Available Now" showed the available providers **among the top 60**, not the available providers in range (51 vs the full page), and a 4.8-rated provider ranked 61st was unreachable whatever you set. `search_providers` now takes `p_min_rating` and `p_available_only`. **Semantics deliberately unchanged:** the floor still compares against the raw star average, so results do not shift meaning — only the set being filtered gets bigger. That preserves the existing consequence that an unrated provider (rating 0) is excluded by *any* floor; whether "New on Seva" should survive a rating filter is a product question, and settling it inside a bug fix would be a behaviour change smuggled in. **The structural fix matters more than either filter:** `runSearch` now takes no filter arguments at all and reads the current filter state directly, so a new filter cannot be half-wired by forgetting one call site — which is exactly how these two were left behind. One debounced effect re-queries on any filter change. Asserted in `ui-check-step11` for both controls, each reporting what the old approach would have found.
- ~~**`/services` re-queried in a render loop.**~~ **RESOLVED (2026-08-10.)** Found while browser-testing the two fixes above, and the most expensive of the three: once ranked, `/services` issued **162 `search_providers` calls in 12 idle seconds — 13.5 per second on a page nobody was touching** (`/providers`, measured as the control, made zero). The slug→id map `categoryIds` was an object literal rebuilt on every render and used as an effect dependency, so a fresh identity each render re-queried, `setRanked` produced a new array, that re-rendered, and round it went. `useMemo` keyed to `categories` breaks the cycle. **The lesson is about what our checks could see:** every existing assertion passed throughout — correct cards, correct ranking, correct distances, no coordinate leak — because none of them looked at request *rate*. A page can be perfectly correct and still be a denial-of-service against your own database. `ui-check-step11` now counts outbound `search_providers` requests over an idle window on both pages and requires **zero**.

- **The geocoder cannot resolve small Indian landmarks** — a real onboarding risk, found during the Kalyan scale test. Nominatim resolved *Khadakpada*, *Birla College*, *Kala Talao*, *Kalyan West* and *Kalyan Junction*, but returned **no match** for *Prem Auto*, *Don Bosco School*, *Rita Memorial School*, or *Mangla Park / Sai Circle* — exactly the shop-and-landmark addresses Indian providers actually give. A provider typing "Prem Auto, Kalyan" gets nothing and cannot set a service base. Mitigations to weigh: fall back to the locality (Khadakpada resolves even when Mangla Park doesn't), let the provider drop a map pin (the deferred half of the Step-11 spec), or move to Google/Mapbox, whose Indian POI coverage is far better. **This is the strongest argument yet for building the map-pin picker.**
- **A `no_fault` dispute still costs the provider operationally.** Step 8's *fault-based trust hit* is correctly gated (`no_fault` → neither side), but the reputation engine's operational term is **not fault-aware**: it uses `avg((status='disputed')::int)` over the provider's bookings, so merely *being disputed* lowers completion and raises the dispute rate whatever the outcome. A provider cleared of wrongdoing still takes a small hit, and a vexatious complaint is therefore not free. Surfaced by `ui-check-step8`'s "not penalized when not at fault" assertion (3.51 → 3.50), which sits on a 2-dp rounding knife-edge and so fails only at certain booking counts — the same fixture-drift family as the old `verify-step7` note. **Not caused by Step 11 or by seeded providers**: the prior is a constant 4.0 and every operational query is scoped `WHERE provider_id = p_subject_id`, so extra providers cannot move another provider's score. Needs a reputation-scope session to decide whether `no_fault` disputes should be excluded from the operational metric.
- **The admin provider queue is unpaginated.** `/api/admin/provider-applications` selects every row with a non-null `applied_at`, then builds an `.in('provider_id', …)` from all of their ids. At 485 providers that is **482 rows / 232 KB / 2.1 s** — still working, but it grows linearly and the `.in()` list will eventually hit PostgREST URL limits. Worth pagination before real supply arrives. (It did **not** cause the `ui-check-admin` timeout seen during this session — that was dev-server degradation, and the check passes 34/0 against a fresh server.)
- **`listUsers()` truncation — FIXED, but note the shape.** Seven scripts looked up test accounts via `service.auth.admin.listUsers()` with `perPage: 200` (two used the 50 default). Seeding 480 users pushed the test accounts off page one and **five ui-check scripts aborted with "Cannot run: test accounts not found"** — which reads like missing credentials, not a truncated list. Now `listAllUsers()` in `scripts/lib/creds.mjs` pages until a short page returns. It would have failed identically on the 201st real signup.
- **A long-running `next dev` degrades badly — restart before any browser pass.** Re-confirmed hard this session: six UI checks failed on timeouts that looked like real app bugs (missing offer button, missing negotiation panel, missing Decision page). A clean restart turned all six green with no code change. Suspect the server before the code when several unrelated browser checks fail at once.

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

## Site-wide auth gate — the whole app sits behind sign-in (✅ done)

`localhost:3000` (and every other route) now opens on the sign-in page unless there is a session.
One `<AuthGate>` in `app/layout.tsx` wraps `<main>`; `components/auth-gate.tsx` holds the public
list, which is **`/auth/signin` and `/auth/signup` only**. Everything else — including
`/how-it-works` and the provider catalog — requires a session.

- **The list is an allowlist, deliberately.** A new page is gated the moment it exists, rather
  than gated whenever someone remembers to add a guard. This supersedes the per-page redirect that
  `/profile`, `/wallet` and `/bookings` each carried a copy of — **those copies are still in the
  code and were deliberately left there.** They are now unreachable (the gate redirects first), but
  they are correct, they are the `loading`-aware version commit `a715c60` fixed, and removing six
  working guards to tidy up buys nothing while risking the exact hard-refresh bug that commit
  closed. Redundant, not wrong.
- **`/api/**` is untouched and must stay that way.** Route handlers do not render through a
  layout, so the gate never sees them — correct, because `/api/payments/webhook` is called by
  **Razorpay, not a browser**, and authenticates by verifying the HMAC signature. Gating it would
  silently stop escrow reconciliation (invariant 5). The other routes authenticate the Bearer
  token via `lib/api-auth`.
- **`?next=` survives the detour.** A shared provider link opened by a signed-out person returns
  them to that link after sign-in instead of dumping them on the homepage. `lib/next-param.ts`
  allows only same-site absolute paths — `//evil.com`, `/\evil.com` and absolute URLs are dropped,
  because `next` is attacker-supplied and an unchecked redirect after a real sign-in on the real
  domain is an open redirect wearing the trust of the flow the victim just completed.

### ❌ Rejected: middleware + cookie-backed sessions

The stricter-looking option — add `@supabase/ssr`, swap `lib/supabase.ts` to a cookie-storing
browser client, redirect at the edge in `middleware.ts` — was considered and **rejected**. Do not
"upgrade" to it without a reason that isn't on this list:

- It buys **no data protection here.** Every page except `/how-it-works` is `'use client'` and
  fetches under RLS, so **no page server-renders user data**; the real boundary is, as always, in
  the database.

  Be precise about what the client gate does and does not do, because it is easy to overclaim: it
  controls what the browser **shows**, not what the server **sends**. Page copy is retrievable
  either way — a client page's markup sits in its JS chunk, which anyone can download. Verified
  by fetching both kinds unauthenticated: `/` returns only `Loading…`, while `/how-it-works` —
  the one server component — has its full text in the HTML, because `children` is server-rendered
  and passed as a prop into the client gate. Neither carries user data. If the goal ever becomes
  "the marketing copy itself must not leave the server without a session", **that** is a reason to
  revisit middleware; nothing above is.
- It would move the whole app's session storage from localStorage to cookies to gate routing —
  invalidating every existing session, and putting a new dependency under the auth foundation.
- The existing API auth (`Authorization: Bearer`, no SSR cookie session) is a deliberate choice
  this would sit awkwardly beside.

What it *would* buy: the redirect lands before any HTML/JS is sent, so no brief "Loading…" on a
cold deep link. That is the entire upside.

### ✅ The chrome no longer signposts gated pages

Navbar and Footer render outside the gate (they are the frame the sign-in page is drawn in), so
they used to offer a signed-out visitor `/services`, `/providers`, `/how-it-works`,
`/become-provider` and the five footer service links — every one of which now bounces back to the
sign-in page they are already on. **Dead controls, which honest signposting forbids.** Signed out:

- **Navbar** shows no nav links at all (`links = !user ? [] : …`), and the logo points at
  `/auth/signin` rather than `/`. Keyed on `user`, not `!loading && !user`, so the links are never
  shown optimistically and then withdrawn.
- **Footer** drops the Popular Services column entirely and filters every `href`-bearing entry out
  of Company, leaving a 3-column grid. What stays is what is still true without an account: the
  brand blurb, location, contact details, and the "Soon" entries — already plain text with a chip,
  so they promise nothing.
- **Both auth pages' own logos** are plain text instead of links to `/`.

Verified by enumerating **every anchor** on the signed-out pages and asserting each resolves to a
public route — a sweep, rather than a list of the links someone remembered — plus the other
direction, that all of it returns signed in (and that an admin still gets the admin-shaped nav).

`scripts/ui-check-auth-gate.mjs` holds all of it, **32/32**, and runs first in `verify-all`'s UI
block: once everything is gated, a broken gate fails every other UI check at its own first
navigation, which reads as six unrelated feature regressions instead of one cause.

Two things that check learned the hard way, both of which had it reporting green against nothing:

- **The sweep must prove it saw the whole page before "none gated" means anything.** The mobile
  menu's links are not in the DOM while it is closed, and the button that opens it is subject to
  the same hydration race as any form fill — clicked too early it does nothing. The same page swept
  **7 anchors on one run and 3 on the next**, silently exempting a second copy of the navigation.
  It now retries the click until the nav's anchor count actually grows, and a short sweep is a hard
  FAIL rather than a confident "none gated".
- **"The gated page never rendered" has to be sampled DURING the redirect, not after it.** Read
  once the URL has settled, `main` is the sign-in page — so the check was reporting a leak on all
  ten gated routes when the gate was working perfectly.

### ✅ CLOSED — password reset now exists (2026-08-11)

The "Forgot password?" link pointed at `/auth/forgot-password`, **which had never existed**. It
404'd, and behind the gate it bounced silently back to the sign-in page — worse, because the
customer could not tell whether they had misclicked or the site was broken. It spent one release
as plain text with a "Soon" chip (item 22's rule for unbuilt destinations). **It is a real link
again**, and both pages behind it are built.

`/auth/forgot-password` asks for the address and sends the link; `/auth/reset-password` is where
that link lands. Four decisions in there are load-bearing:

- **The request page cannot be used to find out who is on Seva.** Supabase does its half already
  (it mails nothing to an unknown address and still reports success); the UI has to not undo that,
  so there is no "no account found" branch anywhere, and the confirmation names the address the
  visitor typed rather than confirming it exists. Otherwise the form is a free enumeration oracle:
  type an address, learn whether that person is a Seva user. The one error that IS shown is
  Supabase's rate limit, because that is a fact about the request rather than about the account.
- **Both halves are on the gate's public list, and the second one is the subtle part.**
  `/auth/reset-password` is reached with **no session yet** — the token is still in the URL
  fragment waiting for supabase-js to exchange it. Gating that route would redirect first, and
  since `?next=` carries only pathname and search, **the fragment — the token itself — would be
  thrown away**. An expired link would also bounce to sign-in unexplained, when saying "this link
  is dead, here is a fresh one" is that page's entire job.
- **Saving a new password signs the user out everywhere**, and the form says so before they click.
  `updateUser` leaves every other session alive, and the person most likely to be resetting a
  password is someone who believes another party has it — so leaving that party signed in would
  defeat the exercise. It also means the new password is used once, immediately, which is the
  cheapest possible confirmation that it is what they think it is.
- **The client is on the implicit flow** (`lib/supabase.ts` calls `createClient` with no auth
  options, and supabase-js defaults `flowType: 'implicit'`), so the happy path arrives as
  `#access_token=…` and the client picks it up itself. The page therefore *waits* for the happy
  path rather than parsing it, and spends its code on the two failure shapes instead: a dead link,
  and `?token_hash=` in the query, which is what Supabase's newer templates emit and what survives
  a later switch to PKCE. Reading the error out of the fragment is **best-effort by design** —
  supabase-js strips it during its own init, before React renders — so a second branch catches the
  same case from "auth settled and nobody is signed in" with a less specific message.

**⚠️ Not defended against, deliberately:** someone already signed in can open `/auth/reset-password`
and set a new password without knowing the old one. That is not introduced here —
`updateUser({ password })` behaves that way from any live session on any page — and the mitigation
is the project setting ("Secure password change", requiring recent re-authentication), not a
client-side check. Noted so the absence of an old-password field does not read as an oversight.

**Verified end to end in `ui-check-auth-gate` (now 44/44), against a real recovery link:** a
throwaway user is created, `admin.generateLink({ type: 'recovery' })` produces the genuine link,
the browser follows it, sets a password through the real form, and then the assertions that
actually matter run outside the UI — the **new** password signs in, the **old** one does not, and
a session opened *before* the reset can no longer refresh, which is what proves the sign-out was
global rather than local. The user is deleted afterwards, so no test account's password is ever
touched. The request page is exercised with an address that has **no account**, on purpose: it
drives the whole path and the neutral confirmation while sending no mail, so the check cannot burn
the project's email quota however often it runs.

**Still open:** the email itself is Supabase's default template on Supabase's shared SMTP, which is
rate-limited and not branded. Fine for now; a custom SMTP sender is a launch item, not a bug.

### 🔴 REAL GAP, newly surfaced: sign-up asks for consent to documents that do not exist

The same enumeration found `/terms` and `/privacy` linked from the sign-up consent line — **neither
route exists**, which is why the footer has always shown these two as "Soon". So the form said
"By creating an account, you agree to our Terms and Privacy Policy" over links that 404'd, and
that behind the gate silently bounced back to sign-in.

They are now plain text, and **the wording is deliberately unchanged** — a consent line is not
copy to improvise on. This does not resolve anything: asking users to agree to documents that have
never been written is the pre-existing legal exposure already flagged under item 22, now visible
at the exact moment consent is collected. **Publishing Terms and Privacy is a launch blocker**;
the honest rendering is only the stopgap that stops the site misrouting people in the meantime.

---

## Principles reaffirmed during the issue passes

- **Friction asymmetric to intent:** customers frictionless; providers do a short, one-time, honestly-status'd application; strict guarantees underneath.
- **Whoever benefits from a claim doesn't get to make it:** providers can't self-verify, self-rate, or self-mark-paid; customers confirm payment; the system (webhook) confirms online payment.
- **Simple interface, strict guarantees** — simplify UX, never simplify away a safety gate.
- **Browser verification catches what scripts can't** — the Bucket-B trust-tier and `category_usage` defects were both "the DB was right, the screen was wrong / the grant leaked"; only a real browser + a discriminating assertion surfaced them.
