/* Seva — make the search order DETERMINISTIC under ties.

   THE BUG, found by a browser check disagreeing with a direct query on the same data:

     search_providers(…, limit 30) → Prakash Nair, Nikhil Naik, …
     search_providers(…, limit 60) → Nikhil Naik, Prakash Nair, …

   Same origin, same filters, same ordering mode — different order. Both providers score
   match_score = 0.885690 and sit at the same rounded distance, so every ORDER BY key was equal and
   Postgres was free to return them in whatever order the plan produced. Changing LIMIT changed the
   plan, and so changed the answer.

   WHY IT MATTERS BEYOND A FLAKY TEST. Ties are not rare here — match_score is a blend of four
   rounded-ish inputs and the seeded population is dense, so equal scores are common. A customer
   who re-runs the same search (every filter change re-queries) can see two providers swap places
   for no reason they can perceive, and "position 1" is worth real money to the provider who holds
   it. Non-determinism in a ranking is a fairness problem, not just a test problem.

   THE FIX: a final `sp.id` tie-break. It is arbitrary but STABLE — the same two providers resolve
   the same way on every query, forever, and nobody's position drifts between page loads.

   CREATE OR REPLACE, not DROP + CREATE: the signature is UNCHANGED, so this is a true replacement
   and cannot create the overload trap that 20260820120000 and 20260821120000 had to work around.
   The overload risk exists only when the argument list changes.

   🔴 NOTHING ELSE MOVES. match_score is identical, every filter is identical, and the sort modes
   are identical — the only difference from 20260822120000 is one extra ORDER BY key that can never
   change the order of two rows that differ on any earlier key. */

CREATE OR REPLACE FUNCTION public.search_providers(
  p_lat double precision, p_lng double precision,
  p_category_id uuid DEFAULT NULL,
  p_radius_km double precision DEFAULT 25,
  p_limit int DEFAULT 30,
  p_query text DEFAULT NULL,
  p_min_rating numeric DEFAULT NULL,
  p_available_only boolean DEFAULT false,
  p_sort text DEFAULT 'match'
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
  ), s AS (
    SELECT lower(btrim(coalesce(p_sort, 'match'))) AS mode
  )
  SELECT sp.id, sp.business_name, sp.bio, sp.category_id, sc.name AS category_name, sc.slug AS category_slug,
         sp.rating, sp.total_reviews, sp.reputation_score, sp.trust_tier,
         sp.hourly_rate, sp.experience_years, sp.is_verified, sp.is_available, sp.city,
         round((ST_Distance(sp.geo, o.g) / 1000)::numeric, 2)::double precision AS distance_km,
         -- UNCHANGED from 20260818120000 — copied verbatim, not re-tuned.
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
  CROSS JOIN s
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
    AND (p_min_rating IS NULL OR p_min_rating <= 0 OR sp.rating >= p_min_rating)
    AND (NOT COALESCE(p_available_only, false) OR sp.is_available)
  ORDER BY
    CASE WHEN s.mode = 'distance'   THEN ST_Distance(sp.geo, o.g) END ASC NULLS LAST,
    CASE WHEN s.mode = 'rating'     THEN -COALESCE(sp.rating, 0) END ASC NULLS LAST,
    CASE WHEN s.mode = 'reviews'    THEN -COALESCE(sp.total_reviews, 0) END ASC NULLS LAST,
    CASE WHEN s.mode = 'price_low'  THEN NULLIF(sp.hourly_rate, 0) END ASC NULLS LAST,
    CASE WHEN s.mode = 'price_high' THEN -NULLIF(sp.hourly_rate, 0) END ASC NULLS LAST,
    match_score DESC,
    distance_km ASC,
    sp.id ASC          -- the last word: arbitrary, but the SAME arbitrary answer every time
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int,text,numeric,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int,text,numeric,boolean,text) TO anon, authenticated;

/* Re-assert the coordinate-privacy invariant: the whole body was restated, so prove again that it
   exposes no coordinate column and that the raw columns remain unreadable. */
DO $$
DECLARE leaked text;
BEGIN
  SELECT string_agg(a.attname, ', ') INTO leaked
  FROM pg_proc p
  JOIN unnest(p.proallargtypes, p.proargnames) WITH ORDINALITY AS a(atttypid, attname, ord) ON true
  WHERE p.oid = 'public.search_providers(double precision,double precision,uuid,double precision,int,text,numeric,boolean,text)'::regprocedure
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

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'search_providers';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one search_providers, found %', n;
  END IF;
END $$;

/* The property this file exists for, asserted directly: the SAME query at two different LIMITs
   must agree on the rows they share. This is the exact comparison that caught the bug — a browser
   check reading the page (limit 60) disagreed with a direct query (limit 30) on identical data. */
DO $$
DECLARE a uuid[]; b uuid[];
BEGIN
  SELECT array_agg(id) INTO a FROM (
    SELECT id FROM public.search_providers(19.0760, 72.8777, NULL, 15, 10, NULL, NULL, false, 'match')
  ) t;
  SELECT array_agg(id) INTO b FROM (
    SELECT id FROM public.search_providers(19.0760, 72.8777, NULL, 15, 60, NULL, NULL, false, 'match') LIMIT 10
  ) t;

  IF a IS NULL OR array_length(a, 1) < 10 THEN
    RAISE NOTICE 'stable-order check skipped: fewer than 10 providers near the test origin';
  ELSIF a IS DISTINCT FROM b THEN
    RAISE EXCEPTION 'search order is not stable across LIMIT — ties still resolve non-deterministically';
  END IF;
END $$;
