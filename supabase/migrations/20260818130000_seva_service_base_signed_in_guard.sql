/* Seva — Step 11 follow-up: make set_provider_service_base refuse anon explicitly.
   Run AFTER 20260818120000.

   FOUND BY VERIFYING THE PREVIOUS MIGRATION'S OWN CLAIM. 20260818120000 did:
       REVOKE ALL ON FUNCTION ... FROM PUBLIC;
       GRANT EXECUTE ON FUNCTION ... TO authenticated;
   and I read that as "anon excluded". It isn't. Supabase ships
       ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, ...
   so a new function is created with EXECUTE granted DIRECTLY to `anon`. Revoking from PUBLIC does
   not remove a direct grant to a role, so anon could still call it.

   Impact was nil — auth.uid() is NULL for anon, the UPDATE matched no row and the caller got
   'No provider application found'. But "it happens to write nothing" is not the same guarantee as
   "it refuses", and the difference matters the next time someone edits this function.

   NOTE (deliberately NOT swept here): this is ambient across the project — submit_provider_application,
   transition_booking, submit_review and other definer functions are anon-executable for the same
   reason, and each defends itself with an internal auth.uid() check instead. That is a real pattern
   worth auditing, but auditing ~15 money- and state-changing functions is a security-scope session,
   not a footnote to a matching step. Recorded in the decisions log as known-open. */

CREATE OR REPLACE FUNCTION public.set_provider_service_base(
  p_lat double precision, p_lng double precision,
  p_address text DEFAULT NULL, p_city text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Say no to an unauthenticated caller in the function itself, the way every other definer
  -- function here does. The grant below is the outer fence; this is the one that actually holds.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'must be signed in';
  END IF;

  IF p_lat IS NULL OR p_lng IS NULL THEN
    RAISE EXCEPTION 'A latitude and longitude are required to set your service base';
  END IF;
  IF p_lat < -90 OR p_lat > 90 OR p_lng < -180 OR p_lng > 180 THEN
    RAISE EXCEPTION 'Those coordinates are out of range';
  END IF;

  UPDATE service_providers
     SET latitude   = p_lat,
         longitude  = p_lng,
         address    = COALESCE(NULLIF(btrim(p_address), ''), address),
         city       = COALESCE(NULLIF(btrim(p_city), ''), city),
         updated_at = now()
   WHERE user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No provider application found for this account';
  END IF;
END;
$$;

-- The grant that 20260818120000 intended. anon is named explicitly because that is the role that
-- actually holds the privilege — revoking PUBLIC leaves it in place.
REVOKE EXECUTE ON FUNCTION public.set_provider_service_base(double precision,double precision,text,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_provider_service_base(double precision,double precision,text,text) TO authenticated;

-- Fail the migration rather than let the intent silently not hold a second time.
DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.set_provider_service_base(double precision,double precision,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'set_provider_service_base is still executable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.set_provider_service_base(double precision,double precision,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'set_provider_service_base is not executable by authenticated';
  END IF;
END $$;
