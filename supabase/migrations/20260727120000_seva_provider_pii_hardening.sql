/* Seva — provider PII hardening. Run AFTER Step 7.

   Closes an invariant-#6 hole: `anyone_can_read_providers` (row-level, USING true) predates the
   expansion migration that added `phone`/`work_address` to service_providers, so anonymous
   visitors could read every provider's phone number — the exact direct-contact channel that
   enables disintermediation (§7.3), plus KYC `documents` and home coordinates.

   Fix = column-level SELECT grants (same pattern as the Step-1 UPDATE grants): the public
   CATALOG stays public (discovery needs it), the CONTACT/PII columns become server-only.
   RLS policies are untouched. */

-- 1) Public reads: catalog columns only.
--    `user_id` MUST stay readable: the RLS policies on bookings / booking_events / messages /
--    payment_transactions subquery `SELECT user_id FROM service_providers`, and policy
--    expressions run with the CALLER's privileges — revoking it would break every provider-side
--    read in the app. It's a bare UUID, not contact info.
--    NOT granted (server-only): phone, address, work_address, latitude, longitude, documents.
--    Step 11 (matching): distance must come from a SECURITY DEFINER PostGIS RPC that returns a
--    computed distance — do NOT re-grant raw latitude/longitude to serve the radius search.
REVOKE SELECT ON service_providers FROM anon, authenticated;
GRANT SELECT (
  id, user_id, category_id, business_name, bio, experience_years, hourly_rate,
  rating, total_reviews, total_bookings, reputation_score, is_verified, is_available,
  city, state, status, opening_hours, closing_hours, working_days, gallery,
  created_at, updated_at
) ON service_providers TO anon, authenticated;

-- 2) A provider still reads their OWN full row (form prefill etc.) through a definer view
--    filtered to auth.uid() — same pattern as public_profiles. security_barrier stops the
--    planner from pushing a leaky predicate below the user_id filter (which could otherwise
--    evaluate attacker functions against other providers' hidden columns).
CREATE OR REPLACE VIEW my_provider_profile WITH (security_barrier) AS
  SELECT * FROM service_providers WHERE user_id = auth.uid();
REVOKE ALL ON my_provider_profile FROM anon, authenticated;
GRANT SELECT ON my_provider_profile TO authenticated;

-- NOTE for the app: client code must never select('*') on service_providers (partial column
-- grants make PostgREST's * expansion fail with 42501). All current call sites use explicit
-- column lists — keep it that way, or read via my_provider_profile for own-row access.
