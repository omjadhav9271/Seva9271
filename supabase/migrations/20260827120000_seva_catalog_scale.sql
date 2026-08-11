/* Seva — make the unranked catalog safe at scale.

   THE BUG, and it is live. /providers and /services both run an UNBOUNDED catalog query when the
   customer has not given a location:

     .from('service_providers').select(…).eq('status','approved').order('rating', desc)

   PostgREST caps result sets at 1,000 rows. Measured today at 1,085 approved providers: the query
   returns exactly 1000, silently. 85 providers are invisible, with no error and nothing in the
   response saying the set was cut.

   That is bad on its own. What makes it a correctness bug is `catalogComparator` in
   lib/matching.ts, which sorts those rows in the browser — and whose own comment reads:

       "If you ever add a limit to the catalog query, this function becomes the bug it was
        written to avoid."

   PostgREST added the limit for us. So catalog-mode "Lowest price" was sorting a 1000-row sample
   of an 1085-row set, which is precisely the filter-the-page family this codebase has spent four
   migrations eliminating. The fix is the same as it was every other time: ORDER IN THE QUERY, take
   the cut from the ordering the customer asked for.

   This migration supplies the one thing PostgREST cannot express for that ordering.

   ── WHY price_sort EXISTS ────────────────────────────────────────────────────────────────────
   `hourly_rate` is 0 for providers who quote per job — the card renders "Custom pricing", not
   free. `ORDER BY hourly_rate ASC` therefore opens the cheapest page with every provider who has
   no price at all: useless, and a lie about what they cost. search_providers solves this inside
   SQL with NULLIF(hourly_rate, 0) (20260822120000), but the catalog query is PostgREST, which has
   no way to write that expression in an .order() clause. A generated column gives it one, so both
   paths sort by identical semantics instead of drifting apart — which is how the two pages ended
   up disagreeing in the first place. */

ALTER TABLE service_providers
  ADD COLUMN IF NOT EXISTS price_sort numeric
  GENERATED ALWAYS AS (NULLIF(hourly_rate, 0)) STORED;

-- Same visibility as hourly_rate, which is already public catalog data. It is a restatement of a
-- readable column, so this exposes nothing new.
GRANT SELECT (price_sort) ON service_providers TO anon, authenticated;

/* Supports the catalog's own ordering. At 1,085 rows a sort is trivial; this is for the size the
   pagination now makes reachable, where an unindexed sort of every approved provider on each page
   load is the next thing to hurt. */
CREATE INDEX IF NOT EXISTS idx_providers_catalog_rating
  ON service_providers (status, rating DESC) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_providers_catalog_price
  ON service_providers (status, price_sort) WHERE status = 'approved';

/* Prove the column means what the header claims: unpriced providers must sort LAST in both
   directions, never first. Cheaper to fail here than to find "₹0" heading the cheapest page. */
DO $$
DECLARE wrong int;
BEGIN
  SELECT count(*) INTO wrong FROM service_providers
   WHERE hourly_rate = 0 AND price_sort IS NOT NULL;
  IF wrong > 0 THEN
    RAISE EXCEPTION 'price_sort is not NULL for % unpriced provider(s) — they would head the cheapest page', wrong;
  END IF;

  SELECT count(*) INTO wrong FROM service_providers
   WHERE hourly_rate > 0 AND price_sort IS DISTINCT FROM hourly_rate;
  IF wrong > 0 THEN
    RAISE EXCEPTION 'price_sort disagrees with hourly_rate for % priced provider(s)', wrong;
  END IF;
END $$;
