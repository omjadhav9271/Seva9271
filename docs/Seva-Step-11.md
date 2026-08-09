# Seva — Playbook Step 11: Matching & Ranking (PostGIS + Reputation)

> Step 11 of `/docs/Seva-Claude-Code-Playbook.md` (architecture §5, §6.2). Read `CLAUDE.md` and `/docs/Seva-Decisions-Log.md` first. This is where the **reputation engine you built in Step 7 finally gets used** — today providers are sorted by a plain star average and distance isn't considered at all. Step 11 makes matching *the right provider, found fast*: near you, trustworthy, available. Do this after Bucket C is committed.

---

## Where you are (grounded in the current repo)

- **PostGIS is NOT enabled.** `service_providers.latitude` / `longitude` exist as loose `NUMERIC` columns (likely null on most seeded rows). No spatial index, no distance function.
- **Listing is naive.** `app/providers/page.tsx` and `app/services/page.tsx` both do `.eq('status','approved').order('rating', …)` — a plain star-average sort. City is a text filter. **The Step-7 `reputation_score` is fetched nowhere and drives nothing.**
- **A constraint is already on record.** The Step-7 PII-hardening migration (`20260727120000`) notes: *"Step 11 (matching): distance must come from a SECURITY DEFINER PostGIS RPC that returns a distance"* — i.e. **never hand raw provider coordinates to a customer** (stalking / safety). Customers get *how far*, not *where*.
- You have `reputation_score`, `trust_tier`, `is_available`, `rating`, `total_reviews`, `category_id` — everything a good ranking needs, except the geography wiring.

## What this step adds

1. **PostGIS proximity** — a real geographic distance between customer and provider, spatially indexed so it scales.
2. **Reputation-weighted ranking** — combine *proximity* + *reputation_score* (Step 7) + *availability* into one ranked result. The best-matched provider surfaces first.
3. **Coordinates never leak** — matching runs in a `SECURITY DEFINER` RPC that returns **distance**, not lat/lng. This is a safety invariant, not a nicety.
4. **Category + distance filtering** — "electricians within 10 km, ranked by match quality."

---

## The design

**Ranking is explainable and tunable**, like the reputation engine. A provider's match score blends:
- **Proximity** — closer is better, decaying with distance (a great provider 40 km away shouldn't outrank a good one 2 km away for an on-site home service).
- **Reputation** — the Step-7 `reputation_score` (the manipulation-resistant trust score, not the raw star average).
- **Availability** — `is_available` providers rank above unavailable ones.
- (Optional, tunable) a small **trust_tier** nudge.

The score is computed server-side and returned with a `distance_km` the customer *can* see; the raw coordinates they *cannot*.

---

## The migration (source of truth)

`supabase/migrations/20260818120000_seva_matching_postgis.sql`:

```sql
/* Seva — Step 11: PostGIS proximity + reputation-weighted matching. Run AFTER Bucket C.
   Customers receive DISTANCE, never raw coordinates (safety — see 20260727120000). */

-- 1) PostGIS + a generated geography point + a spatial index.
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS geo geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
         ELSE NULL END
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_providers_geo ON service_providers USING GIST (geo);

-- 2) search_providers: the ONLY matching entry point. SECURITY DEFINER so it can read geo and
--    compute distance WITHOUT exposing coordinates. Returns distance_km, never lat/lng.
CREATE OR REPLACE FUNCTION public.search_providers(
  p_lat double precision, p_lng double precision,
  p_category_id uuid DEFAULT NULL,
  p_radius_km double precision DEFAULT 25,
  p_limit int DEFAULT 30
) RETURNS TABLE (
  id uuid, business_name text, bio text, category_id uuid, category_name text,
  rating numeric, total_reviews int, reputation_score numeric, trust_tier int,
  hourly_rate numeric, is_available boolean, city text,
  distance_km double precision, match_score double precision
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH origin AS (
    SELECT ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography AS g
  )
  SELECT sp.id, sp.business_name, sp.bio, sp.category_id, sc.name AS category_name,
         sp.rating, sp.total_reviews, sp.reputation_score, sp.trust_tier,
         sp.hourly_rate, sp.is_available, sp.city,
         round((ST_Distance(sp.geo, o.g) / 1000)::numeric, 2)::double precision AS distance_km,
         -- match_score: proximity decay + reputation + availability + a small tier nudge.
         -- Tunable weights; documented so it's explainable like the reputation engine.
         (
           0.45 * exp(-(ST_Distance(sp.geo, o.g) / 1000) / 8.0)   -- proximity, ~8km decay scale
         + 0.40 * (COALESCE(sp.reputation_score, 0) / 5.0)         -- Step-7 trust score, normalized
         + 0.10 * (CASE WHEN sp.is_available THEN 1 ELSE 0 END)    -- available first
         + 0.05 * (COALESCE(sp.trust_tier, 1) / 3.0)               -- small verified-tier nudge
         )::double precision AS match_score
  FROM service_providers sp
  JOIN service_categories sc ON sc.id = sp.category_id
  CROSS JOIN origin o
  WHERE sp.status = 'approved'
    AND sp.geo IS NOT NULL
    AND (p_category_id IS NULL OR sp.category_id = p_category_id)
    AND ST_DWithin(sp.geo, o.g, p_radius_km * 1000)   -- uses the GIST index
  ORDER BY match_score DESC, distance_km ASC
  LIMIT p_limit;
$$;
-- Anyone may search (it's how customers find providers) — but it returns distance, not coords.
GRANT EXECUTE ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int) TO anon, authenticated;

-- 3) Keep raw coordinates unreadable by clients. Confirm the SELECT policy on service_providers
--    does NOT expose latitude/longitude/geo to anon/authenticated. If a public provider SELECT
--    policy exists that includes coordinates, restrict its columns (Step 1/Step 7 already revoked
--    much of this; verify geo/lat/lng are not client-selectable). Matching goes through the RPC only.
```

> **Seeding note:** most existing providers likely have null `lat/lng`, so they won't appear in results until they have coordinates. Add a small backfill for the demo/seed providers (set plausible Mumbai coordinates per city) so the feature is demonstrable — a data step, not logic. Real providers get coordinates at onboarding (see below).

---

## App wiring

- **Capture provider coordinates at onboarding — as a STATIC service base, never live device location.** Per the decisions log ("Location & tracking"): a provider sets their **service base** by **typing an address and/or dropping a map pin**, which you geocode to `latitude`/`longitude`. Do **not** use the provider's live device location for matching — a provider isn't always standing at their base, and their base is what ranking needs (live device position is Step 15 tracking, not this). Without coordinates a provider can't be matched — surface that honestly ("add your location so customers nearby can find you").
- **Customer location for search.** On `/providers` and `/services`, get the customer's location (a "near me" button via `navigator.geolocation`, with a manual city fallback if they decline). Pass it to `search_providers`.
- **Replace the naive queries.** Swap the `.eq('status','approved').order('rating')` fetches for `supabase.rpc('search_providers', { p_lat, p_lng, p_category_id, p_radius_km })`. Render **distance** ("2.3 km away"), the reputation/trust indicators (from Step 7), and availability. Keep a graceful fallback: if the customer won't share location, fall back to the city-filtered list (current behavior) rather than a dead end.
- **Show why it ranked.** Optionally surface the match factors lightly ("Nearby · Highly rated · Available") — explainable, like the reputation breakdown.
- `lib/supabase.ts` — a `ProviderSearchResult` type.

---

## Gotchas / decisions baked in

- **Coordinates never reach the client — this is a safety invariant, not UX.** A customer learning a provider's exact home/location is a real stalking risk (many providers are individuals working from home). The RPC returns `distance_km`; raw `geo`/`lat`/`lng` stay server-side. Do not add coordinates to any client-selectable column "to draw a map."
- **Reputation finally drives ranking.** Use the Step-7 `reputation_score` (the trust score), not the raw `rating` star average, as the reputation term — that's the whole reason it was built.
- **Proximity decays, doesn't hard-cut** (beyond the radius filter): a slightly-farther excellent provider can still beat a nearer mediocre one, but distance matters a lot for on-site services. Weights are tunable in one place.
- **Generated `geo` column + GIST index** — distance filtering uses `ST_DWithin` against the index, so it scales; don't compute distance in the client or in a full table scan.
- **Graceful location fallback** — never dead-end a customer who declines location sharing; fall back to the city list. (Honest-signposting principle.)
- **Matching, not fraud or tiers** — Step 11 ranks. Fraud detection (Step 13) and tier *perks* (Step 15) are separate; don't build them here. `trust_tier` is only a small ranking nudge here.

---

## Definition of done

- PostGIS is enabled; `service_providers` has a spatially-indexed `geo` point derived from lat/lng.
- `search_providers(lat, lng, category, radius)` returns approved, in-radius providers ranked by a blended **proximity + reputation_score + availability** score, each with a `distance_km`.
- 🔴 The RPC (and the client) **never expose raw coordinates** — only `distance_km`. A client cannot select `latitude`/`longitude`/`geo` off `service_providers`.
- `/providers` and `/services` use the RPC with the customer's location, show distance + reputation/trust + availability, and **fall back gracefully** to the city list if location is declined.
- Providers can add their location during onboarding; a provider without coordinates simply isn't matched (surfaced honestly), and existing/demo providers are backfilled so the feature is demonstrable.
- The Step-7 `reputation_score` measurably affects order (a higher-reputation provider outranks a lower one at similar distance).
- `npm run typecheck` and `npm run build` pass.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read /docs/Seva-Architecture.md (§5, §6.2), CLAUDE.md, and
/docs/Seva-Decisions-Log.md first. We are on Playbook Step 11: matching & ranking (PostGIS +
reputation). Bucket C is committed.

Read these first, then propose a short plan and WAIT for my OK before editing:
- CLAUDE.md and /docs/Seva-Step-11.md (this spec — the source of truth)
- supabase/migrations/20260727120000_seva_provider_pii_hardening.sql (the note: Step 11 distance
  must come from a SECURITY DEFINER RPC, coordinates never exposed) and the provider SELECT policies
- supabase/migrations/20260726120000_seva_reputation_engine.sql (reputation_score — the ranking input)
- app/providers/page.tsx and app/services/page.tsx (the naive .order('rating') listing to replace)
- app/become-provider/page.tsx (where provider location gets captured), lib/supabase.ts

Build:
1. Migration supabase/migrations/20260818120000_seva_matching_postgis.sql EXACTLY as in
   /docs/Seva-Step-11.md: enable postgis; add the generated geo geography column + GIST index;
   the search_providers SECURITY DEFINER RPC returning distance_km + a blended match_score
   (proximity decay + reputation_score + availability + small trust_tier nudge), granted to
   anon+authenticated; and confirm raw latitude/longitude/geo are NOT client-selectable.
2. app/become-provider: capture the provider's STATIC service base — a "type an address and/or
   drop a map pin" flow, geocoded to latitude/longitude and stored with the application. Do NOT
   use the provider's live device location (that's Step 15 tracking; ranking needs their fixed
   base). Honest note that without a location they won't be matched. Backfill plausible
   coordinates for the existing demo/seed providers so the feature is demonstrable.
3. app/providers/page.tsx and app/services/page.tsx: replace the .eq('status','approved')
   .order('rating') fetch with supabase.rpc('search_providers', {...}) using the customer's
   location (a "near me" button via navigator.geolocation; manual city fallback if declined —
   never a dead end). Show distance ("2.3 km away"), reputation/trust + availability, ranked by
   match_score.
4. lib/supabase.ts: a ProviderSearchResult type.

Do NOT (later steps or invariants):
- Expose raw coordinates to the client anywhere — return distance only (safety invariant).
- Build fraud detection (Step 13) or tier PERKS (Step 15) — trust_tier is only a ranking nudge here.
- Change reputation math, escrow, disputes, the state machine, or onboarding gates.

Done when:
- postgis enabled; geo point + GIST index exist; search_providers returns in-radius approved
  providers ranked by proximity + reputation_score + availability, each with distance_km.
- A client CANNOT select latitude/longitude/geo off service_providers; only distance_km is exposed.
- /providers and /services use the RPC with the customer's location, show distance + reputation +
  availability, and fall back to the city list if location is declined.
- reputation_score measurably changes rank order; providers can add location at onboarding; demo
  providers backfilled.
- npm run typecheck and npm run build pass.

I'll apply the migration via supabase db push. After I confirm, add scripts/verify-step11.mjs
asserting: search_providers returns ranked results with distance_km; a nearer/higher-reputation
provider outranks a farther/lower one; the radius filter excludes out-of-range providers; and —
critically — that latitude/longitude/geo are NOT selectable by an anon/authenticated client
(the coordinate-privacy invariant). Then a watch-along browser check via the Claude-in-Chrome
extension (confirm it's connected; pause for my OK before sign-in): "near me" on /providers ranks
by distance+reputation and shows "X km away", and declining location falls back to the city list.

Finish by reporting what changed and how you verified each "Done when" — especially the
coordinate-privacy invariant and that reputation_score actually moves the ranking.
```
