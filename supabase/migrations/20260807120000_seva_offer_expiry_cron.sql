/* Seva — Step 10: schedule the offer-expiry sweep. Run AFTER 20260806120000.

   expire_stale_offers() exists and is verified, but a sweep nobody calls is a sweep that never
   runs: every abandoned negotiation would sit in 'negotiating' forever, holding the customer's
   3-per-day slot against that provider and leaving both parties staring at a dead panel.

   Steps 7 and 9.5 left their cron scheduling as a comment for the dashboard. That is how a job
   ends up un-scheduled, so this one is in the migration — guarded, because pg_cron is an
   extension a fresh environment may not have. Where it is missing the migration still applies and
   simply says so; call expire_stale_offers() from an Edge Function or by hand there.

   Hourly, not nightly: offers carry a 24-hour expiry, so the sweep's period is the error bar on
   "expires in 24 hours". An hour is a fair rounding; a day would double the advertised window. */

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron is not installed — expire_stale_offers() is NOT scheduled. Schedule it manually.';
    RETURN;
  END IF;

  -- Idempotent: unschedule any previous definition before re-adding it.
  PERFORM cron.unschedule('hourly-expire-offers')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hourly-expire-offers');

  PERFORM cron.schedule('hourly-expire-offers', '7 * * * *',
                        $job$SELECT public.expire_stale_offers();$job$);

  RAISE NOTICE 'scheduled hourly-expire-offers (7 * * * *)';
END $$;
