/* Seva — Step 11 fix: the text search filters the QUERY, not the page of results.

   THE BUG. /providers ranked the 30 best matches server-side and then filtered THOSE by the typed
   text in the browser. Same shape as the category bug fixed in 20260819120000: a filter applied
   after a ranked cut is a sample, not a filter. Typing "electrician" near Kalyan searched the 30
   rows that happened to come back, not the electricians in range — so a nearer, better-rated
   electrician ranked 31st was invisible, and the box looked like it was working.

   WHY THE FUNCTION IS DROPPED AND RECREATED rather than gaining a defaulted parameter: in Postgres
   `CREATE OR REPLACE FUNCTION f(a,b,c DEFAULT NULL)` against an existing `f(a,b)` creates an
   OVERLOAD, not a replacement, and PostgREST can then no longer resolve a call that matches both.
   That is the same trap that kept set_provider_service_base out of submit_provider_application.
   One function, one signature.

   Matching uses strpos() on lowercased text rather than ILIKE '%'||q||'%' so that a query
   containing % or _ is treated as literal text instead of a wildcard. */

DROP FUNCTION IF EXISTS public.search_providers(double precision,double precision,uuid,double precision,int);

CREATE OR REPLACE FUNCTION public.search_providers(
  p_lat double precision, p_lng double precision,
  p_category_id uuid DEFAULT NULL,
  p_radius_km double precision DEFAULT 25,
  p_limit int DEFAULT 30,
  p_query text DEFAULT NULL
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
  ORDER BY match_score DESC, distance_km ASC
  LIMIT p_limit;
$$;

-- Anyone may search (it's how customers find providers) — it still returns distance, not coords.
REVOKE ALL ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int,text) TO anon, authenticated;

/* Re-assert the coordinate-privacy invariant after a DROP + CREATE: the whole function was
   rewritten here, so prove again that it exposes no coordinate column and that the raw columns are
   still unreadable. Cheaper to fail the migration than to discover it in a browser check. */
DO $$
DECLARE leaked text;
BEGIN
  SELECT string_agg(a.attname, ', ') INTO leaked
  FROM pg_proc p
  JOIN unnest(p.proallargtypes, p.proargnames) WITH ORDINALITY AS a(atttypid, attname, ord) ON true
  WHERE p.oid = 'public.search_providers(double precision,double precision,uuid,double precision,int,text)'::regprocedure
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
