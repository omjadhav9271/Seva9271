/* Seva — make rating / total_reviews agree with the reviews that actually exist.

   THE PROBLEM, measured on the live DB:

     Lata Iyer     total_reviews 312   actual review rows 0
     Sunita Sharma total_reviews 205   actual review rows 0
     Ramesh Kadam  total_reviews 128   actual review rows 0
     Imran Shaikh  total_reviews  96   actual review rows 0

   These are the demo providers inserted by 20260710121000_seva_demo_providers_seed.sql, which
   wrote plausible-looking `rating` and `total_reviews` straight onto the row. Because it is a
   MIGRATION, every fresh database is born with them — this is not stale local data that a reseed
   would clear.

   WHY IT IS WORTH A MIGRATION RATHER THAN A SHRUG.

   `rating` is what the card SHOWS. `reputation_score` is what the ranking USES, and it is derived
   by compute_reputation() from the reviews table — which, for these four, is empty. So the two
   numbers describe different worlds: a provider displaying "4.85 (312 reviews)" ranks as though
   they had none, because as far as the engine is concerned they have none. A customer sees a
   4.85-rated provider placed below a 4.1-rated one and concludes the sort is broken. They are
   right that something is broken; it is the data.

   It also quietly defeats the rating FILTER: "4+ stars" admits a provider on the strength of 312
   reviews that do not exist.

   THE FIX: recompute both columns from the reviews table, exactly as update_provider_rating()
   already does on every insert. A provider with no reviews becomes rating 0 / total_reviews 0,
   which the UI already renders honestly as "New on Seva" — the truth, and the same thing every
   genuinely new provider sees.

   This is a ONE-OFF reconciliation, not a new rule: the trigger has always kept these columns
   correct for reviews written through the app. It is only direct seed writes that drifted. */

UPDATE service_providers sp
   SET rating = COALESCE(r.avg_rating, 0),
       total_reviews = COALESCE(r.n, 0),
       updated_at = now()
  FROM (
    SELECT p.id,
           (SELECT round(avg(rv.rating)::numeric, 2) FROM reviews rv
             WHERE rv.provider_id = p.id AND rv.direction = 'customer_to_provider') AS avg_rating,
           (SELECT count(*) FROM reviews rv
             WHERE rv.provider_id = p.id AND rv.direction = 'customer_to_provider') AS n
      FROM service_providers p
  ) r
 WHERE sp.id = r.id
   AND (sp.rating IS DISTINCT FROM COALESCE(r.avg_rating, 0)
     OR sp.total_reviews IS DISTINCT FROM COALESCE(r.n, 0));

/* The scores derived from those columns are stale by definition now, so re-derive them from the
   same source of truth. This is the function the nightly cron runs; calling it here just stops the
   DB sitting wrong until 02:00. */
SELECT public.recompute_all_reputation();

/* Fail the migration if any counter still disagrees with the rows. The whole point is that these
   two can no longer describe different worlds, so it should not be possible to apply this file and
   still be wrong about it. */
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (counter %s, rows %s)', sp.business_name, sp.total_reviews, x.n), '; ')
    INTO bad
  FROM service_providers sp
  JOIN LATERAL (
    SELECT count(*) AS n FROM reviews rv
     WHERE rv.provider_id = sp.id AND rv.direction = 'customer_to_provider'
  ) x ON true
  WHERE sp.total_reviews IS DISTINCT FROM x.n;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'review counters still disagree with the reviews table: %', bad;
  END IF;
END $$;
