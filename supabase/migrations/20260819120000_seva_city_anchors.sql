/* Seva — Step 11 fix: city anchors come from the DATA, not a hardcoded list.

   THE BUG THIS CLOSES. lib/matching.ts carried CITY_ANCHORS as four hardcoded cities (Mumbai,
   Thane, Navi Mumbai, Pune) while /providers built its city dropdown from whatever cities the
   provider rows actually contained. The two disagreed the moment providers existed anywhere else:
   picking Kalyan, Bengaluru or Mumbai Suburban — 312 of 485 providers — found no anchor, so the
   page silently fell back to the unranked catalog. No ordering by match, no distances, and no
   explanation to the customer. A dropdown must never offer a choice the ranking cannot honour.

   Deriving the anchor from provider positions needs care, because those positions are exactly what
   Step 11 refuses to expose:
     · min 3 providers per city — a centroid over ONE provider IS that provider's snapped point.
     · the centroid is then snapped to a ~0.02° (~2.2 km) grid, so it is a city-level point rather
       than anything derived from an individual. Two guards, because either alone is thin: three
       providers in one apartment block would still cluster tightly without the coarse snap.
   Net effect: what comes back is "roughly where this city is", which is public knowledge. */

CREATE OR REPLACE FUNCTION public.city_anchors()
RETURNS TABLE (city text, provider_count bigint, lat double precision, lng double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT sp.city,
         count(*) AS provider_count,
         ST_Y(ST_SnapToGrid(ST_Centroid(ST_Collect(sp.geo::geometry)), 0.02))::double precision AS lat,
         ST_X(ST_SnapToGrid(ST_Centroid(ST_Collect(sp.geo::geometry)), 0.02))::double precision AS lng
  FROM service_providers sp
  WHERE sp.status = 'approved'
    AND sp.geo IS NOT NULL
    AND sp.city IS NOT NULL
    AND btrim(sp.city) <> ''
  GROUP BY sp.city
  HAVING count(*) >= 3          -- never let a city of one reveal that one
  ORDER BY count(*) DESC, sp.city;
$$;

-- Anyone may list cities to search from; it returns coarse city points, never a provider position.
REVOKE ALL ON FUNCTION public.city_anchors() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.city_anchors() TO anon, authenticated;

/* Guard the privacy property so a future edit cannot quietly drop it: every anchor must sit on the
   0.02° grid, and no anchor may come from fewer than 3 providers. */
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM public.city_anchors()
   WHERE provider_count < 3
      OR abs((lat / 0.02) - round((lat / 0.02)::numeric)::double precision) > 1e-6
      OR abs((lng / 0.02) - round((lng / 0.02)::numeric)::double precision) > 1e-6;
  IF bad > 0 THEN
    RAISE EXCEPTION 'city_anchors() returned % anchor(s) that are not grid-snapped or are under the 3-provider floor', bad;
  END IF;
END $$;
