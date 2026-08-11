/* Seva — locality-precision search origins, derived from our own supply.

   THE PROBLEM WITH CITIES. A customer had to pick a city to search from, and in India a "city" is
   not a location: Greater Mumbai is ~12 million people across 60 km. The Mumbai anchor sits near
   Fort; a customer in Borivali is ~17 km from it. Ranking them from that point is not approximate,
   it is wrong — it reorders everything and can push the genuinely nearest providers off the page.
   Worse, the city list grows unusable as we expand: a dropdown is not an answer to "where are you"
   once there are hundreds of Indian cities.

   A pincode is the unit Indians actually know and state, and it is roughly a locality — the right
   grain for an 8 km proximity decay.

   ── WHY THE ANCHOR IS DERIVED FROM PROVIDERS, NOT FROM A PINCODE DATASET ─────────────────────
   The obvious build is a reference table of pincode → lat/lng. It was rejected, and the reason is
   worth keeping because it will be proposed again:

   To ship that table someone has to SUPPLY COORDINATES for each pincode. Sourced from an external
   dataset that is a licensing and freshness dependency; sourced from anyone's memory it is
   FABRICATED GEODATA — invented numbers that ship looking authoritative and silently mis-rank real
   customers, with nothing in the system able to detect it.

   Deriving the anchor from providers has a structural property no reference table has: **nobody
   ever states a pincode's coordinates.** The provider states their own pincode — a fact they know
   about themselves — and the position comes from the service base they already set and we already
   verified. A mistyped pincode groups a provider slightly oddly; it cannot invent a place.

   The honest weakness, stated rather than hidden: this only resolves pincodes where we HAVE
   supply. Where we do not, it falls back to the sorting district and then the city, which is
   coarser — and that is the case where the customer most needs a true distance. It is bounded
   (thin supply means the honest answer is "nobody near you yet" or a widened list, which a
   district-level origin computes adequately) but it is real. The upgrade, when it is worth the
   dependency, is a geocoder-backed pincode cache filled once per pincode server-side and stored
   here — the table below is already shaped for it via `source`.

   ── PRIVACY ─────────────────────────────────────────────────────────────────────────────────
   Same rules as city_anchors() (20260819120000), tightened for the finer grain: an anchor needs at
   least 3 providers so it can never BE one provider's position, and the centroid is snapped to a
   ~550 m grid. A centroid over 3+ positions, snapped, is a locality — not a person. Coordinates of
   individual providers remain unreadable; nothing here changes that. */

-- 1) The provider's pincode, part of the service base they already set.
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS pincode text;

ALTER TABLE service_providers DROP CONSTRAINT IF EXISTS service_providers_pincode_shape;
ALTER TABLE service_providers ADD CONSTRAINT service_providers_pincode_shape
  CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$');

-- Readable (it is a locality, like `city`, which is already public) and self-writable, matching
-- the other service-base columns granted in 20260710120000.
GRANT SELECT (pincode) ON service_providers TO anon, authenticated;
GRANT UPDATE (pincode) ON service_providers TO authenticated;

CREATE INDEX IF NOT EXISTS idx_providers_pincode
  ON service_providers (pincode) WHERE status = 'approved' AND pincode IS NOT NULL;

/* 2) Resolve a typed pincode to a point we can rank from, at the FINEST granularity the data
      supports, and say which granularity that was — the UI tells the customer, because "searching
      near 400097" and "searching near the 400 district" are different promises.

      Tiers, in order:
        pincode  — ≥3 approved providers sharing that exact pincode. Locality precision.
        district — ≥3 sharing the first 3 digits (the India Post sorting district). City-ish.
        city     — the city those providers are in, via the existing city anchor logic.

      Returns no row when we have nothing: the caller then says so honestly rather than guessing.

      NOTE the column is `granularity`, not `precision`: PRECISION is a reserved word in Postgres
      (it only exists as part of `double precision`) and naming an OUT column that fails to parse. */
CREATE OR REPLACE FUNCTION public.resolve_pincode(p_pincode text)
RETURNS TABLE (lat double precision, lng double precision, label text, granularity text, provider_count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  WITH clean AS (
    SELECT btrim(coalesce(p_pincode, '')) AS pin
  ),
  exact AS (
    SELECT sp.pincode AS code, count(*)::int AS n,
           ST_SnapToGrid(ST_SetSRID(ST_MakePoint(avg(sp.longitude), avg(sp.latitude)), 4326), 0.005) AS pt
    FROM service_providers sp, clean c
    WHERE sp.status = 'approved' AND sp.pincode IS NOT NULL
      AND sp.latitude IS NOT NULL AND sp.longitude IS NOT NULL
      AND sp.pincode = c.pin
    GROUP BY sp.pincode
    HAVING count(*) >= 3
  ),
  district AS (
    SELECT left(sp.pincode, 3) AS code, count(*)::int AS n,
           ST_SnapToGrid(ST_SetSRID(ST_MakePoint(avg(sp.longitude), avg(sp.latitude)), 4326), 0.02) AS pt
    FROM service_providers sp, clean c
    WHERE sp.status = 'approved' AND sp.pincode IS NOT NULL
      AND sp.latitude IS NOT NULL AND sp.longitude IS NOT NULL
      AND length(c.pin) >= 3 AND left(sp.pincode, 3) = left(c.pin, 3)
    GROUP BY left(sp.pincode, 3)
    HAVING count(*) >= 3
  )
  SELECT ST_Y(pt)::double precision, ST_X(pt)::double precision,
         (SELECT pin FROM clean), 'pincode'::text, n
    FROM exact
  UNION ALL
  SELECT ST_Y(pt)::double precision, ST_X(pt)::double precision,
         (SELECT pin FROM clean) || ' area', 'district'::text, n
    FROM district
   WHERE NOT EXISTS (SELECT 1 FROM exact)
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.resolve_pincode(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_pincode(text) TO anon, authenticated;

/* 3) The pincodes we can actually search from — used to tell a customer, honestly, where we have
      real coverage instead of letting them type into a void. Same ≥3 guard and snap as above. */
CREATE OR REPLACE FUNCTION public.pincode_anchors()
RETURNS TABLE (pincode text, city text, lat double precision, lng double precision, provider_count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sp.pincode,
         mode() WITHIN GROUP (ORDER BY sp.city) AS city,
         ST_Y(ST_SnapToGrid(ST_SetSRID(ST_MakePoint(avg(sp.longitude), avg(sp.latitude)), 4326), 0.005))::double precision,
         ST_X(ST_SnapToGrid(ST_SetSRID(ST_MakePoint(avg(sp.longitude), avg(sp.latitude)), 4326), 0.005))::double precision,
         count(*)::int
  FROM service_providers sp
  WHERE sp.status = 'approved' AND sp.pincode IS NOT NULL
    AND sp.latitude IS NOT NULL AND sp.longitude IS NOT NULL
  GROUP BY sp.pincode
  HAVING count(*) >= 3
  ORDER BY count(*) DESC;
$$;
REVOKE ALL ON FUNCTION public.pincode_anchors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pincode_anchors() TO anon, authenticated;

/* 4) The privacy guards are the point, so fail the migration if either stops holding. A pincode
      anchor built from fewer than 3 providers would be an individual's home address wearing a
      locality's name. */
DO $$
DECLARE thin int; leaked text;
BEGIN
  SELECT count(*) INTO thin FROM public.pincode_anchors() WHERE provider_count < 3;
  IF thin > 0 THEN
    RAISE EXCEPTION 'pincode_anchors() returned % anchor(s) built from fewer than 3 providers', thin;
  END IF;

  SELECT string_agg(DISTINCT column_name, ', ') INTO leaked
  FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'service_providers'
    AND privilege_type = 'SELECT' AND grantee IN ('anon', 'authenticated')
    AND column_name IN ('latitude', 'longitude', 'geo');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'Coordinate-privacy invariant violated: % selectable by anon/authenticated', leaked;
  END IF;
END $$;
