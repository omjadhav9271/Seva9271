/* Seva — let the verify suite see the scheduler.

   20260809120000 scheduled the two jobs. This makes their absence *detectable*, which is the part
   that was actually missing: every script in scripts/ talks to the DB through PostgREST, and
   PostgREST exposes only the `public` schema. cron.job, pg_extension and the rest of the catalog
   are invisible to supabase-js, which is precisely why an unscheduled job survived Steps 7 to 10
   with a green suite.

   So: one narrow reader in public, and verify-hardening.mjs asserts against it.

   Scope is deliberately tiny. It returns jobname, schedule and active — operational metadata, no
   PII and no pricing. It does NOT return `command` (which would echo arbitrary scheduled SQL) and
   it does not return a cron.job composite, per the rule this codebase has been bitten by twice:
   a SECURITY DEFINER function bypasses column grants, so a composite return type leaks every
   column the definer can see, not the ones the caller may. Named columns only.

   EXECUTE is service_role only. The suite runs server-side with the service key; no browser client
   has any reason to enumerate the scheduler. */

CREATE OR REPLACE FUNCTION public.scheduled_jobs()
RETURNS TABLE (jobname text, schedule text, active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- pg_cron may be absent in a fresh environment; report an empty set rather than erroring, so the
  -- caller's assertion is "the job is missing" instead of an opaque 42P01 from a nested schema.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE
    'SELECT j.jobname::text, j.schedule::text, j.active FROM cron.job j ORDER BY j.jobname';
END; $$;

REVOKE EXECUTE ON FUNCTION public.scheduled_jobs() FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.scheduled_jobs() TO service_role;
