/* Seva — follow-up to 20260813120000. Run AFTER it.

   category_usage() shipped as SECURITY DEFINER with EXECUTE granted to `authenticated` and no
   check of its own. That is the exact mistake 20260802120000 warns about in its own comments: a
   definer function bypasses RLS, so it must carry its own check.

   What it leaked: a per-category count of bookings. `bookings` RLS restricts rows to the two
   parties on them, so total booking volume per category is not something a signed-in customer can
   otherwise obtain — and it is the marketplace's own trading data. The provider counts are looser
   (approved providers are publicly listed) but include pending and rejected applications, which
   are not.

   Only the admin categories screen calls it, and only an admin can act on the answer, so the fix
   is to say so. Signature and return shape are unchanged — SQL → PL/pgSQL only so it can RAISE. */

CREATE OR REPLACE FUNCTION public.category_usage()
RETURNS TABLE (category_id uuid, providers int, bookings int, offered int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;

  RETURN QUERY
    SELECT c.id,
           (SELECT count(*)::int FROM service_providers sp WHERE sp.category_id = c.id),
           (SELECT count(*)::int FROM bookings b           WHERE b.category_id  = c.id),
           (SELECT count(*)::int FROM provider_services ps WHERE ps.category_id = c.id)
    FROM service_categories c;
END; $$;

-- Unchanged from 20260813120000, restated because CREATE OR REPLACE does not reset grants and the
-- next reader should not have to go and check.
REVOKE EXECUTE ON FUNCTION public.category_usage() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.category_usage() TO authenticated;  -- is_admin() inside
