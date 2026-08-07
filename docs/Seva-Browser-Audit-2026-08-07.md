# Seva — Full watch-along browser audit (2026-08-07)

> Read-only audit of everything through **Bucket B**, driven in a real Chrome via the Claude-in-Chrome
> extension. **No code, migrations or app logic were changed.** Test data *was* created (bookings,
> reviews, disputes, one provider application) — see [§11 Data residue](#11-data-residue--cleanup).
>
> Companion to `Seva-Decisions-Log.md`. Where this audit found behaviour that is *better* than the
> specs, it is listed under [§7 Improvements](#7-improvements--sync-into-the-specslog) so the step docs
> can be synced. Items the Decisions Log marks ⏸️ deferred / ❌ rejected / ⚠️ known-open were treated
> as out of scope and are **not** reported as bugs.

---

## 1. Scope and method

| | |
|---|---|
| **Date** | 2026-08-07 |
| **Driver** | Claude-in-Chrome extension (`Browser 1`, local Windows Chrome), viewport ~1536×690 |
| **App** | `next dev` on `localhost:3000`, live Supabase project `edloaprufnbgjrieugcl` |
| **Accounts** | customer `test2@gmail.com` · provider `test1@gmail.com` · admin `test3@gmail.com` |
| **Payments** | Razorpay **TEST** mode only. No real money. |
| **Docs read first** | `CLAUDE.md`, `Seva-Architecture.md`, `Seva-Step-1…10`, `Seva-Step-9.5`, `Seva-Decisions-Log.md` |

### Pass/fail rule applied

- **PASS** — matches the docs, **or** differs but is strictly better/equivalent for the user and
  violates no security/trust invariant.
- **IMPROVEMENT** — a pass that is *better than the docs*, so the spec should be updated.
- **FAIL** — worse than the docs, broken, **or** deviating on a guarantee: money direction/amounts,
  who-can-do-what, RLS, self-attestation, escrow, fault-based reputation, verification gates.
  "Looks better" never overrides a security invariant.

### A note on how the counterpart was driven

The extension drives **one** Chrome profile, so both parties cannot hold sessions simultaneously.
To prove *realtime with no refresh*, the browser stayed signed in as one party while the counterpart
acted through a Node client hitting the **same RPCs the UI calls** (`transition_booking`,
`respond_offer`, `submit_review`, `raise_dispute`). Every live update reported below was then observed
in the untouched browser tab — no navigation, no reload.

---

## 2. Pre-flight

- **Dev server was stale on arrival**: `/admin/categories` returned 404 while `/admin`,
  `/admin/disputes` and `/admin/providers` all served 200. Killing the listener (PID 23976) and
  restarting `next dev` fixed it. **Environment artifact, not an app defect** — recorded here so it
  isn't rediscovered as a bug.
- All 14 pages and 5 API routes pre-warmed (`next dev` compiles per route on first request).
- Early signal from the unauthenticated warm-up: `/api/payments/webhook` → **400**,
  `/api/payments/create-order` → **401**, `/api/payments/refund` → **401**.

---

## 3. Results table

| # | Flow / step | Verdict | Notes |
|---|---|---|---|
| A1 | Login → browse → open provider → book (₹600, confirm step) | **PASS** | |
| A2 | create-order amount from DB; Razorpay TEST opened at ₹600 | **PASS** | order `order_TMfihlTHtjbQnX`, 60000 paise |
| A3 | Webhook: bad sig → 400, valid → `held`, replay → idempotent | **PASS** | |
| A4 | Chat + realtime both directions | **PASS** | |
| A5 | Provider walks accept→en_route→arrived→in_progress→complete | **PASS** | each step live in customer tab |
| A6 | Customer confirm → escrow release | **PASS** | fee ₹6 (1%), payout ₹594, wallet 4110→4704 |
| A7 | Both review; reciprocity reveal live; ₹10 reward | **PASS** | wallet ₹30→₹40 with no refresh |
| A8 | Reputation recompute + snapshot | **PASS** | 3.60→3.66 |
| A9 | Notifications land + route correctly | **PASS** | |
| B1 | "Make an offer" beside "Book at ₹X", negotiable only | **PASS** | |
| B2 | **Live counter-offer, no refresh** | **PASS** | round history, turn flip, bell +1 |
| B3 | Accept locks price; escrow charges exactly ₹520 | **PASS** | 52000 paise |
| B4 | Hidden floor never exposed | **PASS** | see §6 |
| B5 | Below-floor offer ends the negotiation | **PASS** | uniform decline copy |
| **B6** | **"Agreed ₹1,200" shown while status = `negotiating`** | **FAIL → ✅ FIXED** | [F-1](#f-1) |
| **B7** | **`list_price` vs `hourly_rate` divergence** | **FAIL → ✅ FIXED** | [F-2](#f-2) — migration `20260816120000` |
| C1 | Category-aware KYC | **PASS** | Driver → 5 slots; base category → 2 |
| C2 | DigiLocker primary, upload demoted; private-storage copy | **PASS** | |
| C3 | Submit blocked without ID; row born pending/unverified | **PASS** | 0 rows created on blocked attempt |
| C4 | Pending provider not listed, not bookable via direct link | **PASS** | "Provider not found" |
| C5 | Approve gated on verified docs — UI **and** server | **PASS** | RPC refused an admin |
| C6 | Approve → live, verified, trust 4.3, notified, bookable | **PASS** | |
| **C7** | **`0.0 / 5` on Customer Reviews header, 0-review provider** | **FAIL → ✅ FIXED** | [F-4](#f-4) |
| D1 | Dispute from each side; full identification both views | **PASS** | |
| D2 | Admin notified on raise → links to the case | **PASS** | |
| D3 | Evidence bundle: contacts, chat, timeline, payments | **PASS** | |
| D4 | Resolve → clawback from already-released escrow | **PASS** | wallet 4714→4114 |
| D5 | Money breakdown: paid / fee / received / settlement | **PASS** | both directions |
| D6 | Fault mechanism itself | **PASS** | correct in both directions |
| **D7** | **Exonerated party still loses score via cancellation rate** | **FAIL → ✅ FIXED** | [F-3](#f-3) — migration `20260815120000` |
| E1 | `/admin` hub counts | **PASS** | 5 open / 1 to review / 25 live — all match DB |
| E2 | Provider queue → approve/reject page, real trust tier | **PASS** | with caveat, see §9 |
| E3 | `/admin/categories` create + delete through the form | **PASS** | round-tripped, 0 leftover |
| E4 | In-use categories withhold delete | **PASS** | "⚠ in use" replaces trash icon |
| E5 | Admin nav: no "Become a Provider", no wallet | **PASS** | |
| E6 | test2: customer nav unchanged, `/admin/*` redirects | **PASS** | |
| F1–F15 | Security spot-checks | **PASS** | all 15 denied — §6 |
| I1–I12 | Copy/UX better than the docs | **IMPROVEMENT** | §7 |

---

## 4. Flow evidence (concrete numbers)

### Flow A — booking `3e557927-cf35-4770-9a19-e3d205cf6d37`

- Provider **Test Provider** `4a911e78-4d43-4559-b5f1-ce06765f4e1d`, ₹600 for 2h, UPI.
- Booked at `requested`; **no Pay button** until `accepted` (create-order is state-gated). Correct.
- Realtime observed with the tab untouched: `Requested → Accepted` + pay panel appeared;
  `In escrow` badge after webhook; `On the way`; `Completed` + "Confirm done".
- **Webhook probes** against the order the browser actually created:

  | probe | result |
  |---|---|
  | tampered signature | `400 {"error":"invalid signature"}` |
  | valid `payment.captured` | `200 {"ok":true,"held":true}` |
  | replay of same event | `200 {"ok":true,"idempotent":true}` |
  | inflated amount (999999 paise) | `200 idempotent` — **inconclusive**, the row was already `captured` so it short-circuited before any amount check (see §9) |

- **Escrow release on confirm:** `platform_fee = 6`, `provider_amount = 594`,
  `payment_transactions.status = released`, one `wallet_transactions` credit of ₹594,
  provider `wallet_balance` 4110 → **4704**.
- **Event trail** (from `booking_events`):
  `requested → accepted(provider) → en_route → arrived → in_progress → completed(provider)
  → confirmed(customer) → paid(**system**)`. `paid` is system-stamped, never client-driven.
- **Reviews:** customer rated axes 5/4/5/4 → UI derived **Overall 4.5** live. Provider rated 5/5/4
  → 4.7. Reveal appeared in the customer tab with no refresh; "Reviews are final and can't be edited."
- **Reward:** ₹10 credited within 24h of payment — navbar wallet ₹30 → ₹40 live.
- **Reputation:** review_count 3→4, review_score 4.23→4.32, score **3.60 → 3.66**, snapshot written
  with a full component breakdown.
- **Notifications** received by the customer: Booking accepted / on the way / arrived / work started /
  job complete / Payment complete ₹600 / You received a review. Clicking one landed on the right booking.

### Flow B — bargaining

Provider pricing (from DB, never shown to the customer): `pricing_mode=negotiable`,
`list_price=600`, **`floor_price=400`**, `auto_accept_threshold=550`, `max_counter_rounds=3`.

- Booking `1b288c02-db68-4056-ad2f-d8ea364a8e4c`: customer offered **₹450** (between floor and
  threshold) → provider notified, not auto-anything. Correct.
- Provider countered **₹520** (round 2) from the Node client → the customer tab, untouched, showed
  Round 1 "Countered", Round 2 "The provider offered ₹520 — Pending", "Your move", and
  Accept/Counter/Decline. **Live counter-offer confirmed.**
- Customer accepted → `price_agreed = 520`, pay button "Pay ₹520 securely",
  create-order wrote **52000 paise**. Escrow charges exactly the negotiated price.
- Booking `18a39c77-7555-4c88-97ed-99764426eb2a`: offer **₹100** (below the ₹400 floor) →
  booking went straight to `expired`, notification read *"Offer not accepted — Your offer wasn't
  accepted. You can book at the listed price any time."* No hint of distance-to-floor.

### Flow C — onboarding, provider `563abcc5-c0c8-40ff-867e-3bdc77d25dc8` ("Audit Test Carpentry")

- Category **Driver** rendered ID + selfie + **DL + Vehicle RC + Vehicle insurance**;
  switching to a base-only category collapsed it to **ID + selfie**. Category-aware requirements are real.
- Submitting **without** documents was refused and created **0 rows**.
- After submit the row was born: `status=pending`, `is_verified=false`, `kyc_status=submitted`,
  `rating=0`, `reputation_score=0`, `total_bookings=0`.
- Direct link to the pending provider → **"Provider not found"**.
- **Server-side approval gate** (not just a disabled button) — as admin, via RPC:

  ```
  review_provider_application → ERROR: cannot approve — required documents
                                       missing or unverified: Government photo ID, Selfie
  ```

- After verifying both documents and approving: `status=approved`, `is_verified=true`,
  `kyc_status=verified`, `trust_tier=1`, **`reputation_score=4.30`** (Bayesian prior, not 0),
  notification *"You're verified! Your provider profile is live — you can now receive bookings."*
- Public page: **"New on Seva"**, **Trust 4.3**, Avg Rating **"—"**, "Book at ₹900" (= ₹450 × 2h).

### Flow D — disputes, both directions

**Dispute 1** `7ca13dd6…` — raised by the **customer** (`poor_quality`) on the **released** booking
`3e557927…`; resolved `favor_customer` / fault `provider`.

- Money: refunded to customer **₹600**; **clawback −₹600** from the provider's wallet
  (4714 → **4114**); booking `cancelled` / `refunded`.
- Settlement card: "The provider received ₹594" → "Recovered from the provider's wallet −₹600" →
  "The customer finally paid ₹0", "The provider keeps **−₹6**", with an honest explanation that the
  wallet was debited more than the payout because the fee had already been deducted.

**Dispute 2** `4676d271…` — raised by the **provider** (`customer_behaviour`) on the **held** booking
`1b288c02…`; resolved `favor_provider` / fault `customer`.

- Money: provider receives **₹514.80**, platform fee **₹5.20** (1% of ₹520), no refund.

**Fault-based reputation — measured from `reputation_snapshots`:**

| resolution | at fault | at-fault party's `dispute_fault_rate` | exonerated party's `dispute_fault_rate` |
|---|---|---|---|
| `favor_customer` | provider | 0.000 → **0.042** ✔ | customer 0.053 → **0.053** (flat) ✔ |
| `favor_provider` | customer | 0.053 → **0.079** ✔ | provider 0.042 → **0.042** (flat) ✔ |

The fault mechanism is correct in both directions. The exonerated provider's score even *rose*
(3.51 → 3.58) as completion improved. **But see [F-3](#f-3)** — a second channel leaks a penalty
onto the exonerated party.

---

## 5. FAIL details

<a name="f-1"></a>
### F-1 — "Agreed ₹X" shown while the booking is still under negotiation

**Severity:** medium (misleading money on screen; contradicts the Step-10 mechanism).

**Symptom.** A customer who offered **₹450** saw the booking header read **"Agreed ₹1,200"** while the
status badge said `Negotiating`. The same wrong label persists on the **expired** booking where nothing
was ever agreed and the offer was ₹100.

**The DB is right; the screen is wrong.** `bookings.price_agreed` was correctly `NULL` throughout
negotiation (which is exactly what makes `/api/payments/create-order` refuse to charge an unagreed
booking — verified). Only the label is wrong.

**File:** `app/bookings/[id]/page.tsx:348-349`

```ts
const amount     = booking.price_charged ?? booking.price_agreed ?? booking.total_amount;
const priceLabel = booking.price_charged != null ? 'Charged' : 'Agreed';
```

With both `price_charged` and `price_agreed` NULL it falls through to `total_amount` and still calls
it "Agreed". Step 10 is explicit: *"Nothing is AGREED while it is being negotiated."*

#### Resolution (applied 2026-08-07)

`app/bookings/[id]/page.tsx` now labels the number for what it actually is — **charged → agreed →
listed** — instead of collapsing the last two:

```ts
const priceLabel = booking.price_charged != null
  ? 'Charged'
  : booking.price_agreed != null
    ? 'Agreed'
    : 'Listed';
```

Verified in the browser end to end on a fresh negotiation: an offer of ₹480 produced a booking
reading **"Listed ₹600"** while `Negotiating` (DB: `price_agreed = NULL`, `total_amount = 600`), and
the moment the provider accepted it flipped to **"Agreed ₹480"** with the pay button at exactly
₹480. No code path claims agreement before there is one.

---

<a name="f-2"></a>
### F-2 — `list_price` and `hourly_rate` diverge, so one provider quotes two different prices

**Severity:** medium (money shown to the customer differs by path; provider's configured price ignored).

**Symptom.** For the *same* provider and the *same* 2-hour duration:

| path | figure shown | source |
|---|---|---|
| Instant book | **₹600** | `hourly_rate 300 × 2h` |
| Offer sheet header | **"Listed at ₹600/hr"** | `list_price` (600), labelled per-hour |
| Negotiated booking `total_amount` | **₹1,200** | `start_negotiation`: `COALESCE(list_price, hourly_rate) × hours` |

"Listed at ₹600/hr" and "Book at ₹600 (2 hours)" directly contradict each other on the same screen.

**Files:**
- `app/providers/[id]/page.tsx:637` — `Listed at ₹{provider.list_price ?? provider.hourly_rate}/hr`
- `20260804120000_seva_bargaining.sql` → `start_negotiation`, which seeds
  `total_amount = COALESCE(sp.list_price, sp.hourly_rate) * COALESCE(p_duration_hours, 1)`

**Root cause.** The Step-10 migration seeds `list_price := hourly_rate`, so `list_price` reads as a
**per-hour** figure, and `start_negotiation` multiplied it by the duration. But `floor_price` and
`auto_accept_threshold` are compared **directly** against `p_amount`, which is the customer's
whole-job offer. The two halves of the same feature disagreed about the unit.

#### Resolution (applied 2026-08-07) — the columns are JOB TOTALS

Migration **`20260816120000_seva_list_price_is_a_job_total.sql`**. Three independent things force
this reading rather than per-hour:

1. **The security-critical gates already work this way, and it was verified live.** ₹100
   auto-declined against floor 400; ₹450 routed to the provider; threshold 550. Under a per-hour
   reading those gates would sit at ₹800/₹1,100 for a 2-hour job and the ₹450 offer would have
   auto-declined. It did not.
2. **`sp_pricing_sane` requires `floor_price <= list_price`**, so all four columns must share one
   unit — and by (1) that unit is the job total.
3. **Everything else in the negotiation model is a job total**: `offers.amount`, the accepted price,
   `price_agreed`, and what escrow charges.

The ladder on the only negotiable provider reads coherently as totals (floor 400 < auto-accept 550 <
list 600) and incoherently as per-hour.

**Changes:**
- `start_negotiation` no longer multiplies: `COALESCE(sp.list_price, sp.hourly_rate * duration)`. A
  negotiating booking's `total_amount` is now the same figure "Book at ₹X" shows.
- `app/providers/[id]/page.tsx` — the offer sheet reads **"Listed at ₹600 for 2 hours"** using
  `list_price ?? totalAmount`, so its reference price is always the number the customer is
  bargaining down from. The misleading `/hr` is gone.
- The Step-10 seed is undone **for fixed-price providers only**, and only where `list_price` still
  exactly equals `hourly_rate` (an untouched seed). `list_price` is never read on the fixed path, so
  this is a no-op today; it stops those rows mis-pricing the day someone switches to negotiable.
  The one negotiable provider (600 vs hourly 300, deliberately set) is untouched.
- `COMMENT ON COLUMN` now records the unit for `list_price`, `floor_price` and
  `auto_accept_threshold`, so it does not have to be re-derived.

**Deliberately NOT changed:** the floor/threshold comparisons. They already operate on job totals and
were verified correct; rewriting them to per-hour would silently double a live provider's effective
floor without their consent.

**Verified:** the offer sheet and the Book button now show the same ₹600; `verify-step10` 33/0 and
`ui-check-step10` 27/0 after the change.

---

<a name="f-3"></a>
### F-3 — An exonerated party still takes a reputation hit, via the cancellation channel

> ✅ **FIXED 2026-08-07** — migration `20260815120000_seva_dispute_cancellation_is_not_a_cancel.sql`.
> See [Resolution](#f-3-resolution) at the end of this section for the measured before/after.

**Severity:** medium — small in magnitude, but it is a **guarantee** (fault-based reputation) and it is
systematic: it scales with how many disputes you *win*.

**Symptom.** The customer **won** dispute 1 (`favor_customer`, fault = provider) and still lost score.

Measured, customer snapshots either side of the resolution:

| | before | after |
|---|---|---|
| `dispute_fault_rate` | 0.053 | **0.053** ✔ correct — no fault penalty |
| `cancellation` | 0.105 | **0.132** ← the leak |
| `ops_score` | 4.63 | 4.58 |
| **score** | **4.06** | **4.05** |

**Root cause.** `resolve_dispute` marks the booking cancelled on a customer-favourable outcome:

```sql
v_next := CASE WHEN p_outcome = 'favor_customer' THEN 'cancelled' ELSE 'paid' END;
```

and `compute_reputation`'s operational component counts `status='cancelled'` as a cancellation for
both parties:

```sql
v_ops_score := 5 - 2*cancel_rate - 3*dispute_fault_rate;
```

So a dispute resolved *in your favour* files a cancellation against you. This is the same class of
hole Step 8 was written to close ("penalty follows fault, not the existence of a dispute") — the fault
channel was fixed, this second channel was not. The at-fault party is also double-counted (fault hit
*plus* cancellation hit).

**Files:** `supabase/migrations/20260728120000_seva_disputes.sql` (`resolve_dispute`) and the
`compute_reputation` ops filter (last re-declared in `20260804120000_seva_bargaining.sql`).

**Note:** the ops denominator already excludes `requested`/`negotiating`/`expired`. A
dispute-resolution cancellation needs comparable treatment — e.g. exclude bookings whose `cancelled`
came from a dispute resolution, or attribute it only to the at-fault party.

<a name="f-3-resolution"></a>
#### Resolution (applied 2026-08-07)

Migration **`20260815120000_seva_dispute_cancellation_is_not_a_cancel.sql`** re-declares
`compute_reputation` with one behavioural change: the cancellation **numerator** now skips bookings
whose `cancelled` came from a resolved dispute, in both the provider and the customer branch.

```sql
COALESCE(avg((status='cancelled' AND NOT EXISTS (
  SELECT 1 FROM disputes d
  WHERE d.booking_id = bookings.id AND d.status = 'resolved'))::int),0)
```

Deliberately **not** changed: the denominator (a disputed-and-refunded job is still a job that
happened); `completion` on the provider branch (a refunded job genuinely did not complete — an
objective fact, not a second fault penalty); and `dispute_fault_rate`, the review component, the
blend weights and every breakdown key, which are byte-identical to the previous declaration.

Safe by construction: `raise_dispute` only admits `arrived/in_progress/completed/confirmed/paid`, so
a booking cannot be cancelled first and disputed afterwards. Any booking that is both `cancelled`
and carries a resolved dispute got there through `resolve_dispute`.

**Measured on the live DB** (two dispute-resolved cancellations were in play, both
`favor_customer`/fault=provider):

| subject | metric | before | after |
|---|---|---|---|
| customer (**exonerated**) | `cancellation` | 0.132 | **0.079** |
| customer | `dispute_fault_rate` | 0.079 | 0.079 *(unchanged — their own real fault still charged)* |
| customer | **score** | 4.02 | **4.06** |
| provider (**at fault**) | `cancellation` | 0.167 | **0.125** *(no longer double-charged)* |
| provider | `completion` | 0.458 | 0.458 *(unchanged)* |
| provider | `dispute_fault_rate` | 0.042 | 0.042 *(unchanged — fault still charged)* |
| provider | **score** | 3.57 | **3.60** |

The at-fault provider is not let off: they still carry the fault rate **and** the completion miss.
The exonerated customer keeps only the fault from the dispute they genuinely lost.

**Regression cover:** `npm run typecheck` clean; `verify-step8` (fault-based reputation) 38/0;
`verify-step7`'s `cancellation > 0` half still passes (0.063), proving genuine cancellations still
register — only dispute-resolved ones are excluded. Full suite after the fix: **543 / 1 / 2**.

---

<a name="f-4"></a>
### F-4 — `0.0 / 5` on the Customer Reviews header for a zero-review provider

**Severity:** low (cosmetic, but explicitly called out in Step 9.5).

**Symptom.** On the freshly approved provider the page correctly showed **"New on Seva"** and an
Avg Rating of **"—"** — then the *Customer Reviews* section header rendered **`0.0 / 5`** with five
empty stars. The empty state below it is fine ("No reviews yet. Reviews appear here once a completed
booking is rated.").

Step 9.5: *"Show **New** instead of `0.0` when `total_reviews = 0`. A new provider is unrated, not
zero-rated."* Two of three surfaces honour that; the reviews header does not.

**File:** `app/providers/[id]/page.tsx` (Customer Reviews section header).

#### Resolution (applied 2026-08-07)

The header now applies the **same** rule already used by the "New on Seva" badge and the Avg Rating
stat ~140 lines above it in the same file — rather than a new invention:

```tsx
{provider.total_reviews > 0 ? (
  <div className="flex items-center gap-2">…{Number(provider.rating).toFixed(1)} / 5</div>
) : (
  <span className="text-sm text-gray-500">Not rated yet</span>
)}
```

**Verified in the browser.** No zero-review provider existed (the Flow-C one had been cleaned up), so
a temporary approved provider was created, viewed, and **deleted immediately** — 0 rows left behind.
It rendered *"Customer Reviews — Not rated yet"*, consistent with its "New on Seva" badge and its
Avg Rating of "—". A rated provider was re-checked in the same pass and still shows **4.8 / 5** with
stars, so only the zero-review case changed.

---

## 6. Security spot-check matrix

All executed against the live DB with real user sessions (anon key + RLS), **all denied**:

| # | Probe | As | Result |
|---|---|---|---|
| 1 | `bookings.update({status:'completed'})` | customer | `403 permission denied for table bookings` |
| 2 | `wallet_transactions.insert(...)` | customer | `403 violates row-level security policy` |
| 3 | `profiles.update({wallet_balance})` | customer | `403 permission denied for table profiles` |
| 4 | `rpc compute_reputation` | customer | `403 permission denied for function` |
| 5 | `service_providers.update({reputation_score})` | customer | `403 permission denied for table` |
| 6 | `submit_review` on a non-settled booking | customer | `you can only review a completed, paid booking` |
| 7 | `reviews.insert(...)` directly | customer | `403 permission denied for table reviews` |
| 8 | `rpc resolve_dispute` | customer | `admin only` |
| 9 | `service_providers.update({is_verified,status})` | **provider** | `403 permission denied for table` |
| 10 | `service_providers.update({trust_tier:3})` | **provider** | `403 permission denied for table` |
| 11 | `select floor_price` | customer | `403 permission denied for table` |
| 12 | `rpc category_usage()` | customer | `admin only` — Bucket-B hardening holds |
| 13 | `rpc admin_create_category` | customer | `admin only` |
| 14 | `service_categories.insert(...)` | customer | `403 permission denied for table` |
| 15 | insert a provider row with `status='approved', is_verified=true, trust_tier=3` | customer | `403 permission denied for table service_providers` |

**Probe 15 is stronger than the Step-9 spec.** Step 9 closes the self-verification hole with *column*
grants (client may insert, but not the protected columns). In the live DB `INSERT` on
`service_providers` is revoked **outright**, so the only path in is `submit_provider_application`.
No stripped row is created at all.

**Floor-price secrecy (Flow B).** Inspected the rendered provider page directly: no `floor`/`floor_price`
key anywhere in HTML, scripts or `__NEXT_DATA__`; the threshold (550) absent; the token `400` present
**only** inside Tailwind class names (`text-gray-400`, `text-red-400`), never as money and never in
visible text. `lib/bargaining.ts` is correct by construction — `fetchPublicPricing` omits `floor_price`,
and the owner reads it only via the `my_provider_profile` definer view scoped to `auth.uid()`.

**Admin boundary.** As test2, `/admin`, `/admin/disputes` and `/admin/categories` all redirected to `/`
with the customer nav intact (Services / Providers / How It Works / Become a Provider + wallet).
As test3 the nav is Admin / Disputes / Providers / Categories with **no** "Become a Provider" and
**no** wallet chip.

---

## 7. Improvements — sync into the specs/log

Behaviour better than what the step docs describe. None violates an invariant; all are worth recording
so a future session doesn't "fix" them back.

1. **Confirm Booking summary step** before the booking is created (provider, service, date, time, type,
   payment, total). Not in Step 1/2.
2. **Escrow explainer on the pay panel** — *"Your provider has accepted. The job won't start until you
   pay. Funds are held securely in escrow and released to the provider only after you confirm the work
   is done."* Step 5 only asks for a "Pay ₹X securely" button.
3. **Pre-resolution money preview** in the admin resolve panel: "THIS WILL MOVE (OF ₹520 HELD) —
   customer refunded / provider receives / platform fee (1%)", updating live as the outcome changes,
   plus *"Escrow was already paid out — the refund is clawed back from the provider's wallet (may go
   negative)."* Step 8 only requires the post-resolution breakdown.
4. **Settlement summary explains the fee asymmetry** — *"The provider's wallet was debited more than
   the payout it had received, because the platform fee had already been deducted. Our team will settle
   the difference."* Plus "Refunds reach the original payment method within 5–7 working days."
5. **Outcome-aware, per-recipient resolution notifications** — the same event reads *"Resolved in your
   favour"* to one party and *"Resolved in the provider's favour"* to the other, both linking to the
   settlement.
6. **Evidence privacy stated in the UI** — *"Only you and our review team can see these — never the
   other party. Photos, video, audio or PDF — up to 8 files, 50 MB each."*
7. **Guardrail before assigning fault** — *"No evidence submitted by either party yet — you may want to
   wait before assigning fault."*
8. **Admin contact panel is labelled admin-only** with the reason: *"Visible to admins only — never to
   the other party. Call or email either side to verify facts before assigning fault; fault is what
   moves a trust score."* It also flips its labels correctly (`raised this dispute` /
   `responding party`) depending on who filed.
9. **Reviews marked immutable in the UI** — *"Reviews are final and can't be edited."*
10. **Dispute reason list is role-scoped** — the customer's dropdown omits provider-only reasons
    (`payment_not_received`, `customer_behaviour`).
11. **KYC document links are time-boxed** — *"Links are private and expire in 10 minutes."*
12. **Work-history copy encodes the §7.3 moat** — *"Shown on their profile. Verifying it does not change
    their rating — reputation is earned from jobs completed on Seva."*

Also worth recording: the `/admin` hub copy — *"Everything here is gated on `role='admin'`, which is
server-controlled — the DB re-checks it on every read and write"* — and the categories page —
*"only an admin can add or remove one — enforced in the database, not here."*

---

## 8. Observation (not scored as a FAIL)

**`submit_review` trusts a client-supplied overall rating.** The RPC takes `p_rating` independently of
the four axis columns and never derives or validates it against them. Step 6 documents the derivation
as a *UI* behaviour, so the implementation matches the spec — but the consequence is visible:

Test Provider's page header reads **4.7 / 5** while the three review cards render **4★, 1★, 3★**.
Cause: the cards render the mean of the axes (per Step 6), whereas the aggregate
`service_providers.rating` averages the stored `rating` column. Script-written rows carry `rating = 5`
against an axis mean of 1.5, so the two disagree.

Reviews created through the **UI** are self-consistent (mine derived 4.5 from 5/4/5/4 and stored it),
so this is latent rather than active — but the headline star average, which also feeds
`reputation_score`, is a number the client picks freely. Worth deciding whether the server should
derive `p_rating` from the axes.

---

## 9. Coverage gaps — what this audit did *not* prove

Recorded honestly so the coverage isn't overstated.

- **Trust tier could not be visually discriminated.** The badge is data-driven (`trust_tier` is in
  `DETAIL_COLUMNS` in `app/api/admin/provider-applications/route.ts` and rendered as
  `<TrustTierBadge tier={app.trust_tier} …/>`), and every provider shown as Tier 1 genuinely *is*
  Tier 1 — **zero** providers hold a verified non-base document, so `recompute_trust_tier` correctly
  returns 1 for all of them. A tier-2/3 provider would be needed to prove the badge discriminates
  on screen. The Bucket-B fix is present in code; this run could not re-demonstrate the original defect.
- **No real card was entered into Razorpay Checkout.** Entering card details is prohibited, and it
  would not have completed the flow anyway: Razorpay cannot reach `localhost`, and the webhook is the
  only path to `held`. The spec's prescribed alternative — a correctly-signed synthetic
  `payment.captured` — was used against the order the browser really created.
- **The webhook amount-mismatch check is unverified.** The inflated-amount POST returned
  `idempotent` because the ledger row was already `captured`, short-circuiting before any amount
  comparison. A fresh, uncaptured order would be needed to exercise it.
- **`partial` and `no_fault` dispute outcomes were not exercised** — only `favor_customer` and
  `favor_provider`.
- **COD / cash settlement path not exercised** (deferred per Bucket C anyway).
- **The pending application on `omjadhav9271@gmail.com` ("Divyanshu Verma") was deliberately left
  untouched** — it is a real application on the owner's own account, so it was neither approved nor
  rejected.
- **`kyc-docs` storage RLS was not probed from the browser** (covered by `verify-step9`).
- **Two simultaneous browser sessions were impossible** (single Chrome profile) — see §1.

---

## 10. `verify-all.mjs`

### After the F-1 / F-2 / F-3 fixes (current)

```
TOTAL: 544 passed, 1 failed, 1 skipped
```

The single remaining failure is the ⚠️ known-open `verify-step7` fixture drift (below); the single
skip is `verify-step10`'s intentional admin-access skip. `verify-step10` (bargaining) is **33/0** and
`ui-check-step10` **27/0** after the `start_negotiation` change, so the unit fix regressed nothing.

`ui-check-dispute-clarity` now reports **45 / 0 inside the suite**, confirming the pre-fix triage
that its 8 failures were harness interference rather than a defect.

An intermediate run (after F-3 only) showed **543 / 1 / 2**, the extra skip being
`verify-step3` — *"realtime delivery not observed (timeout 20s)"*. It recovered to **12/0** on the
next run without any change, confirming a transient Node WebSocket-egress timeout rather than a
product fault; realtime was observed directly in the browser throughout the audit.

### Before the fix (as first run)

```
TOTAL: 535 passed, 10 failed, 1 skipped
```

| script | result |
|---|---|
| verify-hardening | 15 / 0 |
| verify-provider-pii | 11 / **1** |
| verify-step2 | 27 / 0 |
| verify-step3 | 12 / 0 |
| verify-step4 | 16 / 0 |
| verify-step5 | 25 / 0 |
| verify-step6 | 26 / 0 |
| verify-step7 | 30 / **1** |
| verify-step8 | 38 / 0 |
| verify-step8-evidence | 17 / 0 |
| verify-step9 | 43 / 0 |
| verify-step9-5 | 25 / 0 |
| verify-step10 | 33 / 0 (1 skipped) |
| verify-admin | 24 / 0 |
| ui-check-step8 | 47 / 0 |
| ui-check-step9 | 35 / 0 |
| ui-check-step10 | 27 / 0 |
| ui-check-dispute-clarity | 37 / **8** |
| ui-check-live-counter-offer | 14 / 0 |
| ui-check-admin | 33 / 0 |

### Triage — none of the 10 is a new regression

1. **8 × `ui-check-dispute-clarity`** ("no settlement summary on the resolved card", amount paid / fee /
   payout / clawback / nets absent). **Run standalone it is 45 passed, 0 failed** — including the
   party-side settlement assertions (`"You keep" −₹8`, `"The customer finally paid" ₹0`, and a real
   ₹800 ledger debit) *and* the admin third-person view. This is the documented
   "fails inside `verify-all`, passes standalone" interference pattern, not a product defect.
   **The party-side money breakdown does work.**
2. **1 × `verify-provider-pii`** — audit residue. The assertion expects a non-provider account to read
   nothing from `my_provider_profile`; the failure message literally names
   `563abcc5-c0c8-40ff-867e-3bdc77d25dc8`, the provider row created for test2 in Flow C. Clears when
   that row is deleted.
3. **1 × `verify-step7`** — the ⚠️ known-open fixture drift already recorded in the Decisions Log. The
   two disputes raised during this audit moved test2's `dispute_fault_rate` to 0.047 against a
   hardcoded expectation. The reputation *logic* is correct; the test hardcodes its expected value.
   **Do not weaken the assertion** — the honest fix is to compute it from the DB.

**Clean baseline once the audit residue is removed: ~543 passed / 1 known-open failure.**

---

## 11. Data residue & cleanup

Nothing was deleted — this is the owner's call.

**Created:**

| object | id / detail |
|---|---|
| Provider profile for **test2** | `563abcc5-c0c8-40ff-867e-3bdc77d25dc8` "Audit Test Carpentry", approved + verified |
| Booking (paid → disputed → cancelled/refunded) | `3e557927-cf35-4770-9a19-e3d205cf6d37` |
| Booking (paid → disputed → released) | `1b288c02-db68-4056-ad2f-d8ea364a8e4c` |
| Booking (expired negotiation) | `18a39c77-7555-4c88-97ed-99764426eb2a` |
| Disputes (both resolved) | `7ca13dd6-cb30-4ae3-9ab5-da7a2747b69b`, `4676d271-7848-4dc5-b8b8-10a68507e1a7` |
| Reviews | 2 (one each direction) on `3e557927…` |
| Chat messages | 2 on `3e557927…` |
| Wallet movement | provider 4110 → 4114 net; customer ₹30 → ₹40 |

A category **`audit-probe-category`** was created and deleted through the admin form as part of the
Bucket-B round-trip; **0 rows remain** and the count is back to 25.

**Update 2026-08-07 — the provider row is already gone; no manual cleanup needed.**
The suite's own cleanup routines (`verify-step8` / `verify-step9` remove seeded provider rows and
their throwaway owners) deleted `563abcc5…` during the post-fix run. `test2` owns **0** provider
rows again and `verify-provider-pii` recovered on its own, 11/1 → **12/0**. The previously suggested
`delete from service_providers …` was never executed and is no longer required.

The bookings/disputes/reviews are left in place deliberately — they are legitimate history and
deleting them would perturb reputation snapshots further.

---

## 12. Process notes for the next browser session

- **Restart `next dev` before starting.** A stale server 404'd `/admin/categories` while its siblings
  served fine; the restart fixed it. Assume staleness before assuming a routing bug.
- **Warm every page *and* API route first.** `/api/admin/dispute-contacts` is GET-only, so a POST
  warm-up returns 405 without compiling the GET handler — the evidence bundle then sits on
  "Loading evidence…" for ~20s on first open.
- **Chrome's password manager fights account switching.** It repeatedly re-filled `test2@gmail.com`
  over typed input on `/auth/signin`, silently signing in as the wrong account (the `/admin` redirect
  was the tell). The reliable switch is a programmatic native-setter fill:

  ```js
  const setNative = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  ```

  followed immediately by clicking Sign In — autofill does not re-trigger on a programmatic set.
- **One Chrome profile = one session.** For any "the other side updates without refresh" assertion,
  keep the browser on one party and drive the counterpart through the same RPCs from Node.
- **Always confirm which account is live** before trusting a screen — a wrong-account session hides the
  very view you came to check.
