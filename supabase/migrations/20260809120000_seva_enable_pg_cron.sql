/* Seva — enable pg_cron and actually schedule the two jobs the codebase assumes are running.

   Verified against the live project on 2026-07-30: pg_extension held only pg_stat_statements,
   pgcrypto, plpgsql, supabase_vault and uuid-ossp. pg_cron was never installed, so cron.job did
   not exist and NEITHER scheduled job had ever run — through Steps 7 to 10.

   Two different mistakes produced the same outcome:

     nightly-reputation     20260726120000 left it as a comment addressed to the dashboard. Nobody
                            ran it. Time-decay and rater-weight changes therefore never propagated
                            — a reputation_score only moved when a booking event fired, and a score
                            never drifted down as good behavior aged. Step 11 ranking was about to
                            consume those as if they were fresh.

     hourly-expire-offers   20260807120000 fixed that by scheduling in SQL instead of prose — but
                            wrapped it in `IF NOT EXISTS (SELECT 1 FROM pg_extension ...) RETURN`,
                            so on a project without pg_cron it printed a NOTICE and reported
                            success. The migration is recorded in schema_migrations, the schema
                            looks complete, and expire_stale_offers() has never been called.
                            Abandoned negotiations sit in 'negotiating' forever, each one holding
                            the customer's 3-per-day anti-probe slot against that provider.

   So this migration is deliberately UNGUARDED. A guard is what hid the problem: it converts "this
   deployment cannot run its background jobs" into a NOTICE nobody reads. If pg_cron is unavailable
   the correct behaviour is to fail the push, loudly, here. pg_cron ships in the supabase/postgres
   image, so local `db reset` and the hosted project both satisfy it.

   Placement note: pg_cron is relocatable=false with no schema in its control file, and its install
   script creates the `cron` schema itself — so a bare CREATE EXTENSION puts the extension in
   pg_catalog and its objects in cron. Confirmed on the live DB in a rolled-back transaction rather
   than assumed. Do not add WITH SCHEMA.

   Schedules are unchanged from what each step specified: reputation at 02:00 daily, the offer
   sweep hourly at :07 (offers carry a 24h expiry, so the sweep period is the error bar on
   "expires in 24 hours" — an hour is a fair rounding, a day would double the advertised window).

   verify-hardening.mjs now asserts both jobs are present and active, so a silently unscheduled job
   fails the suite instead of waiting three steps to be noticed. */

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- The extension is owned by whoever ran this migration; on Supabase that is postgres, which also
-- runs the verify path. Idempotent and a no-op when already granted.
GRANT USAGE ON SCHEMA cron TO postgres;

DO $$
BEGIN
  -- Idempotent: unschedule any previous definition before re-adding it. cron.unschedule() raises
  -- if the job is absent, hence the EXISTS guard on each.

  PERFORM cron.unschedule('nightly-reputation')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nightly-reputation');
  PERFORM cron.schedule('nightly-reputation', '0 2 * * *',
                        $job$SELECT public.recompute_all_reputation();$job$);

  PERFORM cron.unschedule('hourly-expire-offers')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hourly-expire-offers');
  PERFORM cron.schedule('hourly-expire-offers', '7 * * * *',
                        $job$SELECT public.expire_stale_offers();$job$);

  RAISE NOTICE 'scheduled nightly-reputation (0 2 * * *) and hourly-expire-offers (7 * * * *)';
END $$;

-- Fail the migration rather than the feature: assert what we just claimed to do. Both functions
-- are SECURITY DEFINER with EXECUTE revoked from anon/authenticated; the jobs run as the scheduling
-- role (postgres), which owns them, so the revokes do not block the sweep.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(j.jobname, ', ')
    INTO v_missing
    FROM (VALUES ('nightly-reputation'), ('hourly-expire-offers')) AS j(jobname)
   WHERE NOT EXISTS (
     SELECT 1 FROM cron.job c WHERE c.jobname = j.jobname AND c.active
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'pg_cron jobs missing or inactive after scheduling: %', v_missing;
  END IF;
END $$;
