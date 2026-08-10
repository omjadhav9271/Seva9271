/* Seva — Step 11 fix: the rating and availability filters run in the QUERY, not over the page.

   THE BUG. The last of the family. /services asks search_providers for 60 ranked rows and then
   applied "Minimum rating 4+" and "Available only" to THOSE in the browser. A filter applied after
   a ranked cut is a sample, not a filter: "Available only" showed the available providers among
   the top 60, not the available providers in range, and a 4.8-rated provider ranked 61st was
   unreachable no matter which filter you set. Same defect as the category (20260819120000) and the
   text query (20260820120000); this migration closes it.

   DROP + CREATE again, for the reason written up in 20260820120000: in Postgres
   `CREATE OR REPLACE FUNCTION f(a,b,c DEFAULT NULL)` against an existing `f(a,b)` creates an
   OVERLOAD, not a replacement, and PostgREST then cannot resolve a call matching both signatures.
   One function, one signature.

   SEMANTICS ARE UNCHANGED ON PURPOSE. p_min_rating compares against sp.rating — the raw star
   average, exactly what the browser was comparing — so a customer's results do not shift meaning
   with this migration; only the set being filtered gets bigger (correct). Note the consequence
   that already existed client-side: an unrated provider has rating 0, so ANY minimum rating
   excludes new providers. That is a product question about how "New on Seva" should rank against a
   rating floor, and deliberately not settled here — changing it would be a behaviour change
   smuggled into a bug fix. */

DROP FUNCTION IF EXISTS public.search_providers(double precision,double precision,uuid,double precision,int,text);

CREATE OR REPLACE FUNCTION public.search_providers(
  p_lat double precision, p_lng double precision,
  p_category_id uuid DEFAULT NULL,
  p_radius_km double precision DEFAULT 25,
  p_limit int DEFAULT 30,
  p_query text DEFAULT NULL,
  p_min_rating numeric DEFAULT NULL,
  p_available_only boolean DEFAULT false
) RETURNS TABLE (
  id uuid, business_name text, bio text, category_id uuid, category_name text, category_slug text,
  rating numeric, total_reviews int, reputation_score numeric, trust_tier int,
  hourly_rate numeric, experience_years int, is_verified boolean, is_available boolean, city text,
  distance_km double precision, match_score double precision
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  WITH origin AS (
    SELECT ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography AS g
  ), q AS (
    SELECT lower(btrim(coalesce(p_query, ''))) AS needle
  )
  SELECT sp.id, sp.business_name, sp.bio, sp.category_id, sc.name AS category_name, sc.slug AS category_slug,
         sp.rating, sp.total_reviews, sp.reputation_score, sp.trust_tier,
         sp.hourly_rate, sp.experience_years, sp.is_verified, sp.is_available, sp.city,
         round((ST_Distance(sp.geo, o.g) / 1000)::numeric, 2)::double precision AS distance_km,
         -- match_score: proximity decay + reputation + availability + a small tier nudge.
         (
           0.45 * exp(-(ST_Distance(sp.geo, o.g) / 1000) / 8.0)   -- proximity, ~8km decay scale
         + 0.40 * (COALESCE(sp.reputation_score, 0) / 5.0)         -- Step-7 trust score, normalized
         + 0.10 * (CASE WHEN sp.is_available THEN 1 ELSE 0 END)    -- available first
         + 0.05 * (COALESCE(sp.trust_tier, 1) / 3.0)               -- small verified-tier nudge
         )::double precision AS match_score
  FROM service_providers sp
  JOIN service_categories sc ON sc.id = sp.category_id
  CROSS JOIN origin o
  CROSS JOIN q
  WHERE sp.status = 'approved'
    AND sp.geo IS NOT NULL
    AND (p_category_id IS NULL OR sp.category_id = p_category_id)
    AND ST_DWithin(sp.geo, o.g, p_radius_km * 1000)   -- uses the GIST index
    AND (
      q.needle = ''
      OR strpos(lower(coalesce(sp.business_name, '')), q.needle) > 0
      OR strpos(lower(coalesce(sc.name, '')), q.needle) > 0
      OR strpos(lower(coalesce(sp.city, '')), q.needle) > 0
    )
    -- NULL and 0 both mean "no floor", so an unset filter can never quietly exclude anyone.
    AND (p_min_rating IS NULL OR p_min_rating <= 0 OR sp.rating >= p_min_rating)
    AND (NOT COALESCE(p_available_only, false) OR sp.is_available)
  ORDER BY match_score DESC, distance_km ASC
  LIMIT p_limit;
$$;

-- Anyone may search (it's how customers find providers) — it still returns distance, not coords.
REVOKE ALL ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int,text,numeric,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int,text,numeric,boolean) TO anon, authenticated;

/* Re-assert the coordinate-privacy invariant after a DROP + CREATE, as 20260820120000 does: the
   whole function was rewritten, so prove again that it exposes no coordinate column and that the
   raw columns remain unreadable. Cheaper to fail the migration than to find it in a browser check. */
DO $$
DECLARE leaked text;
BEGIN
  SELECT string_agg(a.attname, ', ') INTO leaked
  FROM pg_proc p
  JOIN unnest(p.proallargtypes, p.proargnames) WITH ORDINALITY AS a(atttypid, attname, ord) ON true
  WHERE p.oid = 'public.search_providers(double precision,double precision,uuid,double precision,int,text,numeric,boolean)'::regprocedure
    AND lower(a.attname) IN ('latitude', 'longitude', 'geo', 'lat', 'lng');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'search_providers now returns coordinate column(s): %', leaked;
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

/* Exactly one search_providers must exist. The overload trap this file re-avoids is silent at
   migration time and only shows up as a PostgREST resolution error in the browser, so assert it. */
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'search_providers';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one search_providers, found %', n;
  END IF;
END $$;
