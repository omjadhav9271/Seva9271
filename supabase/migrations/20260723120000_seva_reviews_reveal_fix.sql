/* Seva — Step 6 fix: the reciprocity-reveal SELECT policy recursed.

   20260722120000 defined read_revealed_reviews with an inline `EXISTS (SELECT 1 FROM reviews …)`
   in its USING clause. A table reference inside a policy on that same table re-applies the policy
   to the subquery, so every client read failed with:
       infinite recursion detected in policy for relation "reviews"
   That breaks all review reads (provider page, booking-review component, reciprocity checks).

   Fix: move the counterpart-exists test into a SECURITY DEFINER function. It's owned by the
   migration role (BYPASSRLS), and SECURITY DEFINER SQL functions are not inlined, so its internal
   read of `reviews` runs with the definer's rights and does NOT re-enter the policy — no
   recursion. The reveal semantics are unchanged: you always see your own; the counterpart's
   review is visible once the other direction exists, or after 14 days. */

CREATE OR REPLACE FUNCTION public.review_reciprocated(p_booking_id uuid, p_direction text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM reviews r2
    WHERE r2.booking_id = p_booking_id AND r2.direction <> p_direction
  );
$$;
REVOKE EXECUTE ON FUNCTION public.review_reciprocated(uuid,text) FROM public;
GRANT  EXECUTE ON FUNCTION public.review_reciprocated(uuid,text) TO anon, authenticated;

DROP POLICY IF EXISTS "read_revealed_reviews" ON reviews;
CREATE POLICY "read_revealed_reviews" ON reviews FOR SELECT USING (
  reviewer_id = auth.uid()
  OR public.review_reciprocated(reviews.booking_id, reviews.direction)
  OR reviews.created_at < now() - interval '14 days'
);
