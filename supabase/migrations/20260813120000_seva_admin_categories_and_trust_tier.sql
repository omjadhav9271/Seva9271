/* Seva — admin cleanup pass. Run AFTER 20260812120000.

   Three gaps, all of them "the DB was built correctly and then never wired to anything".

   1) trust_tier has NO SELECT GRANT. Step 9.5 added the column; the Step-7 PII hardening had
      already replaced blanket table access with an explicit column list, and Step 10 remembered to
      add its new columns to that list — Step 9.5 did not. So `select('trust_tier')` fails with
      42501 for every client, which is the real reason the tier is surfaced nowhere. It is a
      server-computed badge meant to be read (it sits beside is_verified and reputation_score,
      both already public), so it joins the public column list. It stays server-WRITTEN: no UPDATE
      grant, recompute_trust_tier owns it (invariant #1).

   2) service_categories is writable by nobody. RLS is on with a single FOR SELECT USING (true)
      policy and no write policy, so a non-admin already cannot insert or delete — but neither can
      an admin, leaving categories editable only with the service-role key. Writes now go through
      admin-only RPCs, and the table grants are revoked as defence in depth (the disputes pattern).

   3) expire_provider_documents() was never scheduled. Only 'nightly-reputation' and
      'hourly-expire-offers' are registered, so verified documents never lapse and no provider is
      ever demoted — a tier-3 badge can outlive the police check behind it, which is precisely what
      that function exists to prevent. */

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Let clients READ the trust tier. Still not writable by them.
GRANT SELECT (trust_tier) ON service_providers TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Categories: admin-only writes.
REVOKE INSERT, UPDATE, DELETE ON service_categories FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.admin_create_category(
  p_name text, p_slug text, p_description text DEFAULT NULL,
  p_icon text DEFAULT NULL, p_color text DEFAULT NULL, p_bg_color text DEFAULT NULL
) RETURNS service_categories LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c service_categories; v_slug text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'a category needs a name'; END IF;

  -- Derive a slug when none is given, and normalise whatever we end up with: the slug is what
  -- /services and the category pages route on, so a stray space or capital breaks a URL.
  v_slug := lower(btrim(COALESCE(NULLIF(btrim(p_slug), ''), p_name)));
  v_slug := regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g');
  v_slug := btrim(v_slug, '-');
  IF v_slug = '' THEN RAISE EXCEPTION 'could not derive a usable slug from %', p_name; END IF;
  IF EXISTS (SELECT 1 FROM service_categories WHERE slug = v_slug) THEN
    RAISE EXCEPTION 'a category with the slug % already exists', v_slug;
  END IF;

  INSERT INTO service_categories (name, slug, description, icon, color, bg_color)
  VALUES (btrim(p_name), v_slug, NULLIF(btrim(COALESCE(p_description, '')), ''),
          NULLIF(btrim(COALESCE(p_icon, '')), ''),
          NULLIF(btrim(COALESCE(p_color, '')), ''),
          NULLIF(btrim(COALESCE(p_bg_color, '')), ''))
  RETURNING * INTO c;
  RETURN c;
END; $$;
REVOKE EXECUTE ON FUNCTION public.admin_create_category(text,text,text,text,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_category(text,text,text,text,text,text) TO authenticated; -- is_admin() inside

/* Deletion refuses while anything still points at the category.

   The FKs disagree with each other, which is the trap: service_providers.category_id and
   bookings.category_id are plain REFERENCES (NO ACTION — Postgres blocks the delete with a raw
   constraint error), while provider_services.category_id and category_kyc_requirements.category_id
   are ON DELETE CASCADE. So a category nobody lists as their PRIMARY category could still be
   deleted out from under the providers who offer it through provider_services, silently dropping
   those rows. This checks all three usage tables up front and fails with a sentence a human can
   act on. Only a genuinely unused category is removed — and then the cascade tidies away its
   (equally unused) KYC requirement rows, which is correct. */
CREATE OR REPLACE FUNCTION public.admin_delete_category(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_providers int; v_bookings int; v_offered int;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;

  SELECT name INTO v_name FROM service_categories WHERE id = p_id;
  IF v_name IS NULL THEN RAISE EXCEPTION 'category not found'; END IF;

  SELECT count(*) INTO v_providers FROM service_providers WHERE category_id = p_id;
  SELECT count(*) INTO v_bookings  FROM bookings          WHERE category_id = p_id;
  SELECT count(*) INTO v_offered   FROM provider_services WHERE category_id = p_id;

  IF v_providers > 0 OR v_bookings > 0 OR v_offered > 0 THEN
    RAISE EXCEPTION '% is still in use — % provider(s), % booking(s), % service listing(s). Move them first.',
      v_name, v_providers, v_bookings, v_offered;
  END IF;

  DELETE FROM service_categories WHERE id = p_id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.admin_delete_category(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_category(uuid) TO authenticated; -- is_admin() inside

-- How many things reference each category — so the admin screen can show what a delete would
-- cost, and grey out the ones it would refuse, instead of finding out by failing.
CREATE OR REPLACE FUNCTION public.category_usage()
RETURNS TABLE (category_id uuid, providers int, bookings int, offered int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id,
         (SELECT count(*)::int FROM service_providers sp WHERE sp.category_id = c.id),
         (SELECT count(*)::int FROM bookings b           WHERE b.category_id  = c.id),
         (SELECT count(*)::int FROM provider_services ps WHERE ps.category_id = c.id)
  FROM service_categories c;
$$;
REVOKE EXECUTE ON FUNCTION public.category_usage() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.category_usage() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Register the document-expiry sweep. Same guarded pattern as 20260809120000: only schedules
--    when pg_cron is actually installed, and unschedules any existing job of the same name first
--    so re-running is safe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- cron.unschedule() raises when the job is absent, hence the EXISTS guard (20260809120000).
    PERFORM cron.unschedule('nightly-expire-documents')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nightly-expire-documents');
    -- 02:20 UTC: after nightly-reputation at 02:00, so a demotion lands on a fresh score rather
    -- than racing it.
    PERFORM cron.schedule('nightly-expire-documents', '20 2 * * *',
      $job$SELECT public.expire_provider_documents();$job$);
    RAISE NOTICE 'scheduled nightly-expire-documents (20 2 * * *)';
  ELSE
    RAISE WARNING 'pg_cron is NOT installed — document expiry will not run and lapsed trust tiers will not be demoted';
  END IF;
END $$;

-- Fail the migration rather than the feature (the 20260809120000 pattern): if pg_cron is present,
-- the job must actually be there and active afterwards. Skipped entirely when the extension is
-- absent, so this cannot turn a warning into a hard failure on a DB without pg_cron.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nightly-expire-documents' AND active) THEN
    RAISE EXCEPTION 'nightly-expire-documents missing or inactive after scheduling';
  END IF;
END $$;
