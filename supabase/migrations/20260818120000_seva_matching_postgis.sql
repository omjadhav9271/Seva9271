/* Seva — Step 11: PostGIS proximity + reputation-weighted matching. Run AFTER Bucket C.
   Customers receive DISTANCE, never raw coordinates (safety — see 20260727120000).

   Two deliberate deviations from the Step-11 spec, both load-bearing:

   1) PostGIS goes into `extensions`, not `public`. Every other extension on this project lives
      there (pgcrypto, uuid-ossp, pg_stat_statements). The spec's `SET search_path = public`
      would leave ST_Distance/geography unresolvable and the function would fail to create.

   2) The matching point is SNAPPED TO A ~250 m GRID, and the precise point never enters the
      matching path at all. Returning distance_km from an attacker-chosen origin is NOT the same
      as keeping coordinates private: three calls from three origins trilaterate a provider's
      exact home, which is the stalking risk 20260727120000 exists to prevent. Snapping destroys
      the information rather than hiding it — an attacker who knows this algorithm still recovers
      only the grid node, with the true position uniformly distributed inside the cell. A jitter
      derived from the provider id would NOT do this: the id is in the URL, so a known offset is
      subtractable. This is the Airbnb approach (approximate circle pre-booking) and it is the
      settled answer for marketplaces where an individual's home is the service location.
      Cost: none. The generated column is STORED, so the GIST index is built on the snapped point
      and ST_DWithin stays index-driven. At the 8 km proximity decay scale a ~250 m shift moves
      match_score by ~3%, well inside the reputation term's influence. */

-- 1) PostGIS + a generated, GRID-SNAPPED geography point + a spatial index.
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;

-- 0.0025 degrees ≈ 278 m N-S and ≈ 262 m E-W at Mumbai's latitude (19°N). ST_SnapToGrid rounds to
-- the nearest node, so the true position sits within ±139 m of the stored point on each axis.
-- Schema-qualified throughout: generated-column expressions are resolved at DDL time and must not
-- depend on whatever search_path the migration runner happens to have.
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS geo extensions.geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE WHEN longitude IS NOT NULL AND latitude IS NOT NULL
         THEN extensions.ST_SnapToGrid(
                extensions.ST_SetSRID(extensions.ST_MakePoint(longitude, latitude), 4326),
                0.0025
              )::extensions.geography
         ELSE NULL END
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_providers_geo ON service_providers USING GIST (geo);

-- 2) search_providers: the ONLY matching entry point. SECURITY DEFINER so it can read geo and
--    compute distance WITHOUT exposing coordinates. Returns distance_km, never lat/lng.
--    experience_years / is_verified / category_slug are included beyond the spec's list purely so
--    the existing provider cards keep rendering their verified badge, experience line and category
--    gradient — all three are already in the public column grant, so nothing new is exposed.
CREATE OR REPLACE FUNCTION public.search_providers(
  p_lat double precision, p_lng double precision,
  p_category_id uuid DEFAULT NULL,
  p_radius_km double precision DEFAULT 25,
  p_limit int DEFAULT 30
) RETURNS TABLE (
  id uuid, business_name text, bio text, category_id uuid, category_name text, category_slug text,
  rating numeric, total_reviews int, reputation_score numeric, trust_tier int,
  hourly_rate numeric, experience_years int, is_verified boolean, is_available boolean, city text,
  distance_km double precision, match_score double precision
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  WITH origin AS (
    SELECT ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography AS g
  )
  SELECT sp.id, sp.business_name, sp.bio, sp.category_id, sc.name AS category_name, sc.slug AS category_slug,
         sp.rating, sp.total_reviews, sp.reputation_score, sp.trust_tier,
         sp.hourly_rate, sp.experience_years, sp.is_verified, sp.is_available, sp.city,
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
-- Explicit REVOKE first: Postgres grants EXECUTE to PUBLIC by default, which is broader than intended.
REVOKE ALL ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int) TO anon, authenticated;

-- 3) The provider's STATIC service base (decisions log, "Location & tracking"): address/pin at
--    onboarding, geocoded — never a live device position, which is Step-15 tracking.
--    A separate RPC rather than extra parameters on submit_provider_application: adding params
--    there would create an OVERLOAD, not a replacement, and PostgREST could no longer resolve the
--    existing 9-argument call. It also lets an already-approved provider move without re-entering
--    the application gate. Writes coordinates ONLY — never status, is_verified or kyc_status.
CREATE OR REPLACE FUNCTION public.set_provider_service_base(
  p_lat double precision, p_lng double precision,
  p_address text DEFAULT NULL, p_city text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL THEN
    RAISE EXCEPTION 'A latitude and longitude are required to set your service base';
  END IF;
  IF p_lat < -90 OR p_lat > 90 OR p_lng < -180 OR p_lng > 180 THEN
    RAISE EXCEPTION 'Those coordinates are out of range';
  END IF;

  UPDATE service_providers
     SET latitude   = p_lat,
         longitude  = p_lng,
         address    = COALESCE(NULLIF(btrim(p_address), ''), address),
         city       = COALESCE(NULLIF(btrim(p_city), ''), city),
         updated_at = now()
   WHERE user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No provider application found for this account';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_provider_service_base(double precision,double precision,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_provider_service_base(double precision,double precision,text,text) TO authenticated;

-- 4) Keep raw coordinates unreadable by clients. `geo` is a NEW column and table-level SELECT was
--    revoked in 20260727120000, so it inherits no privilege — but state it rather than rely on it,
--    and then FAIL THE MIGRATION if the invariant does not hold. A silent leak here is a stalking
--    risk, so it should not be possible to apply this file and be wrong about it.
REVOKE SELECT (latitude, longitude, geo) ON service_providers FROM anon, authenticated;

DO $$
DECLARE leaked text;
BEGIN
  SELECT string_agg(DISTINCT column_name, ', ') INTO leaked
  FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'service_providers'
    AND privilege_type = 'SELECT' AND grantee IN ('anon', 'authenticated')
    AND column_name IN ('latitude', 'longitude', 'geo');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'Coordinate-privacy invariant violated: % selectable by anon/authenticated', leaked;
  END IF;
END $$;

-- 5) Demo backfill (data, not logic). Only approved rows that have NO coordinates at all, so it
--    can never move a provider who has set a real base. Deterministic from the row id, so repeated
--    runs and other environments produce the same spread instead of random drift.
UPDATE service_providers sp
   SET latitude  = c.lat + ((('x' || substr(md5(sp.id::text), 1, 4))::bit(16)::int % 1000) - 500) / 10000.0,
       longitude = c.lng + ((('x' || substr(md5(sp.id::text), 5, 4))::bit(16)::int % 1000) - 500) / 10000.0
  FROM (VALUES ('mumbai', 19.0760, 72.8777)) AS c(city, lat, lng)
 WHERE sp.status = 'approved'
   AND sp.latitude IS NULL
   AND lower(btrim(coalesce(sp.city, ''))) = c.city;
