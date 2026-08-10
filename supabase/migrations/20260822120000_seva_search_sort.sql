/* Seva — the SORT runs in the query, not over the page.

   THE BUG THIS PREVENTS. /services offered "Highest Rated" and "Nearest first" as client-side
   sorts over whatever search_providers had already returned. That is the same defect as the
   category (20260819120000), the text query (20260820120000) and the rating/availability filters
   (20260821120000), wearing a different hat: **re-ordering a ranked cut is a sample, not a sort.**
   search_providers returns the top N by match_score, so the highest-rated provider in range sat at
   rank 61 and "Top rated" could never show them — the control looked like it worked and quietly
   answered a different question ("the best-rated of the 60 nearest-and-most-reputable").

   THE FIX: p_sort chooses the ORDER BY, so the cut is taken from the ordering the customer asked
   for. Six values — the three primary controls, plus the three the page already offered and which
   had the same defect:

     'match'      — the blended proximity + reputation + availability + tier ranking (default)
     'distance'   — nearest first
     'rating'     — best-rated first
     'reviews'    — most reviewed first
     'price_low'  — cheapest first
     'price_high' — dearest first

   A NOTE ON PRICE, because the obvious ORDER BY is wrong here. hourly_rate is 0 for providers who
   quote per job rather than per hour — the card renders that as "Custom pricing", not as free. A
   plain ascending sort would open the cheapest page with every provider who has no price at all,
   which is both useless and a lie about what they cost. NULLIF(hourly_rate, 0) pushes them to the
   END of both directions: they are unpriced, not extreme.

   🔴 THE MATCH FORMULA IS UNCHANGED, deliberately. This migration touches ORDER BY and nothing
   else: the same weights, the same decay scale, the same terms. "Best match" must keep meaning
   exactly what it meant yesterday, or every ranking assertion in verify-step11 is measuring a
   different function than the one it was written against.

   Every branch ends in match_score DESC as the tie-break: distance_km rounds to 2 dp and rating is
   a 1-dp average, so ties are common (at 485 seeded providers, dozens share 4.50). Without a
   deterministic tie-break the same query returns a different order run to run, which reads as a
   flickering page and makes any assertion about position flaky.

   An unknown p_sort falls back to 'match' rather than raising: a sort control is not a security
   boundary, and a customer who somehow sends a bad value should get the default ranking, not an
   error page.

   DROP + CREATE again, for the reason written up in 20260820120000: in Postgres
   `CREATE OR REPLACE FUNCTION f(a,b,c DEFAULT NULL)` against an existing `f(a,b)` creates an
   OVERLOAD, not a replacement, and PostgREST then cannot resolve a call matching both. */

DROP FUNCTION IF EXISTS public.search_providers(double precision,double precision,uuid,double precision,int,text,numeric,boolean);

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
         -- match_score: proximity decay + reputation + availability + a small tier nudge.
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
    -- NULL and 0 both mean "no floor", so an unset filter can never quietly exclude anyone.
    AND (p_min_rating IS NULL OR p_min_rating <= 0 OR sp.rating >= p_min_rating)
    AND (NOT COALESCE(p_available_only, false) OR sp.is_available)
  ORDER BY
    -- Nearest first. NULLs can't occur (geo IS NOT NULL above) but ordering is stated explicitly.
    CASE WHEN s.mode = 'distance'   THEN ST_Distance(sp.geo, o.g) END ASC NULLS LAST,
    -- Descending axes are NEGATED rather than given their own DESC clause: one ASC ... NULLS LAST
    -- per expression keeps "unknown sorts last" true in both directions, which a bare DESC would
    -- invert (NULLS FIRST) and put the unpriced providers at the top of "highest price".
    CASE WHEN s.mode = 'rating'     THEN -COALESCE(sp.rating, 0) END ASC NULLS LAST,
    CASE WHEN s.mode = 'reviews'    THEN -COALESCE(sp.total_reviews, 0) END ASC NULLS LAST,
    CASE WHEN s.mode = 'price_low'  THEN NULLIF(sp.hourly_rate, 0) END ASC NULLS LAST,
    CASE WHEN s.mode = 'price_high' THEN -NULLIF(sp.hourly_rate, 0) END ASC NULLS LAST,
    -- The default, and the tie-break for every other mode.
    match_score DESC,
    distance_km ASC
  LIMIT p_limit;
$$;

-- Anyone may search (it's how customers find providers) — it still returns distance, not coords.
REVOKE ALL ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int,text,numeric,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_providers(double precision,double precision,uuid,double precision,int,text,numeric,boolean,text) TO anon, authenticated;

/* Re-assert the coordinate-privacy invariant after a DROP + CREATE, as 20260820120000 and
   20260821120000 do: the whole function was rewritten, so prove again that it exposes no
   coordinate column and that the raw columns remain unreadable. Cheaper to fail the migration
   than to find it in a browser check. */
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

/* A smoke test, deliberately NOT a full ordering proof.

   The temptation here is to assert the whole property — that 'rating' really leads with the
   best-rated provider in range, that 'distance' is monotonic — but every way of doing that in SQL
   depends on a set-returning function's output order surviving a subquery, which Postgres does not
   guarantee. An assertion that can fail spuriously does not protect the invariant; it blocks a
   deploy at random. The real ordering assertions live in scripts/verify-search-location.mjs, where
   a failure is a red line to read rather than a migration that will not apply.

   What is worth failing the migration for is the part that is definitely wrong if it is wrong: the
   three modes must be callable and an unrecognised one must fall back instead of raising. */
DO $$
BEGIN
  PERFORM public.search_providers(19.0760, 72.8777, NULL, 25, 5, NULL, NULL, false, 'match');
  PERFORM public.search_providers(19.0760, 72.8777, NULL, 25, 5, NULL, NULL, false, 'distance');
  PERFORM public.search_providers(19.0760, 72.8777, NULL, 25, 5, NULL, NULL, false, 'rating');
  PERFORM public.search_providers(19.0760, 72.8777, NULL, 25, 5, NULL, NULL, false, 'reviews');
  PERFORM public.search_providers(19.0760, 72.8777, NULL, 25, 5, NULL, NULL, false, 'price_low');
  PERFORM public.search_providers(19.0760, 72.8777, NULL, 25, 5, NULL, NULL, false, 'price_high');
  PERFORM public.search_providers(19.0760, 72.8777, NULL, 25, 5, NULL, NULL, false, 'sideways');
  PERFORM public.search_providers(19.0760, 72.8777, NULL, 25, 5, NULL, NULL, false, NULL);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'search_providers rejected a sort mode it must accept: %', SQLERRM;
END $$;
