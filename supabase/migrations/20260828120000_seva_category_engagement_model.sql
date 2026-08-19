/* Seva — the engagement model is a property of the CATEGORY, not of the platform.

   Run AFTER 20260827120000_seva_catalog_scale.sql.

   WHY THIS EXISTS
   ───────────────
   Today every one of the 25 categories runs the identical money flow: UPI → Razorpay escrow →
   a global 1% fee (platform_fee_pct(), 20260730120000) → provider wallet → release on customer
   confirm. Nothing in the schema could say otherwise, so Seva is the transacting party in all 25
   — including the ones where that is the most expensive posture available:

     • CGST §9(5) notifies "house-keeping, such as plumbing, carpentering" and passenger transport.
       Where it bites, the e-commerce operator pays GST on the FULL SERVICE VALUE, not on its fee.
       18% of an ₹800 cleaning job is ₹144 against an ₹8 platform fee. Worse, the carve-out is
       "except where the provider is liable for registration" — so the sting inverts: the smaller
       the provider, the more the platform owes.
     • §24(x) requires an operator that collects TCS to register REGARDLESS of turnover. Escrow
       does not merely add tax; it deletes the under-₹20L plan outright.

   The fix is not to pick one model globally. It is to let each category carry its own, decided on
   that category's own merits — a decision this column records and /admin/categories drives.

     placement  — household pays the provider directly; Seva charges a one-time introduction fee.
                  Money never touches Seva.               (BookMyBai)
     lead       — provider pays to be listed or per lead. Seva's revenue is advertising; there is
                  no transaction to be liable for.        (JustDial / Sulekha)
     escrow     — Seva collects, holds and releases. Highest trust, highest cost. TODAY'S MODEL.
     directory  — listed, no money, no fee. A liquidity play, not a revenue one.

   NULL means UNDECIDED, and that is the point: /admin/categories renders an undecided category
   grey and a decided one in colour, so the board doubles as the worklist. A CHECK constraint
   passes on NULL (it fails only on FALSE, never on NULL), so no explicit "OR IS NULL" is needed —
   noted because it reads like an oversight.

   NOTHING HERE CHANGES BEHAVIOUR. No booking, payment, escrow or fee path reads this column yet.
   It records decisions; wiring a model to a different checkout is later work, per category.

   🔴 THE RATIONALE FOR EACH CATEGORY'S CHOICE DOES NOT LIVE IN THIS TABLE. service_categories is
   world-readable (table-level SELECT to anon — asserted below). "We chose placement to stay
   outside §9(5)" is strategy, and strategy is not something to serve to anon. It lives in
   /docs/Seva-Decisions-Log.md.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) THE COLUMN. Nullable on purpose; no DEFAULT, so all 25 existing rows and every future
--    insert start undecided without a backfill.
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS engagement_model text;
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS model_decided_at timestamptz;

ALTER TABLE service_categories DROP CONSTRAINT IF EXISTS service_categories_engagement_model_check;
ALTER TABLE service_categories ADD CONSTRAINT service_categories_engagement_model_check
  CHECK (engagement_model IN ('placement','lead','escrow','directory'));

COMMENT ON COLUMN service_categories.engagement_model IS
  'How Seva engages with this category''s money. NULL = not yet decided (renders grey in '
  '/admin/categories). placement = introduction fee, money direct to provider. lead = listing or '
  'per-lead fee, no transaction. escrow = Seva collects and releases (§9(5)/TCS exposure). '
  'directory = free listing. Rationale per category: /docs/Seva-Decisions-Log.md.';
COMMENT ON COLUMN service_categories.model_decided_at IS
  'Stamped by trigger whenever engagement_model changes; nulled when the model is cleared. Never '
  'set by hand — see trg_stamp_category_model.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) model_decided_at CANNOT DRIFT FROM engagement_model.
--    A trigger rather than a line inside the RPC: the RPC is the only path GRANTED to a client,
--    but it is not the only path that exists — the service-role key writes this table directly,
--    and a future second RPC would have to remember. The stamp belongs to the column, so it is
--    enforced where the column is (CLAUDE.md: push integrity down to the DB).
CREATE OR REPLACE FUNCTION public.stamp_category_model_decided_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.engagement_model IS DISTINCT FROM OLD.engagement_model THEN
    NEW.model_decided_at := CASE WHEN NEW.engagement_model IS NULL THEN NULL ELSE now() END;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_stamp_category_model ON service_categories;
CREATE TRIGGER trg_stamp_category_model BEFORE INSERT OR UPDATE ON service_categories
FOR EACH ROW EXECUTE FUNCTION public.stamp_category_model_decided_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) SETTING THE MODEL — admin only, and reversible.
--    p_model = NULL sends a category BACK to undecided. That is a deliberate capability, not an
--    accident of a nullable argument: a decision made early gets re-opened when the next category
--    reveals the reasoning was wrong, and a board you cannot walk backwards on is one people stop
--    trusting.
CREATE OR REPLACE FUNCTION public.admin_set_category_model(p_id uuid, p_model text DEFAULT NULL)
RETURNS service_categories LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c service_categories; v_model text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;

  v_model := NULLIF(btrim(lower(COALESCE(p_model, ''))), '');
  IF v_model IS NOT NULL AND v_model NOT IN ('placement','lead','escrow','directory') THEN
    RAISE EXCEPTION '% is not an engagement model — use placement, lead, escrow or directory', v_model;
  END IF;

  UPDATE service_categories SET engagement_model = v_model WHERE id = p_id RETURNING * INTO c;
  IF c.id IS NULL THEN RAISE EXCEPTION 'category not found'; END IF;
  RETURN c;
END; $$;
REVOKE EXECUTE ON FUNCTION public.admin_set_category_model(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_category_model(uuid, text) TO authenticated; -- is_admin() inside

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) THE MISSING THIRD VERB. The screen could create and delete; it could not edit, so fixing a
--    typo meant deleting a category — which is refused the moment anything points at it, and would
--    cascade away its KYC requirement rows if it weren't.
--
--    🔴 THE ARGUMENTS ARE DELIBERATELY ASYMMETRIC, because the two fields are not alike:
--      • p_slug NULL/blank = KEEP THE CURRENT SLUG. It is NOT re-derived from the name. /services
--        and the category pages route on the slug, so renaming "Maid / House Help" to "House Help"
--        must not silently 404 every link that already points at /maid. Changing it requires
--        passing it explicitly.
--      • p_description NULL/blank = CLEAR IT. It is free text nothing references, and the form
--        round-trips the current value, so an empty box is an instruction rather than an omission.
--    Written down because the inconsistency looks like a bug and is not.
--
--    admin_create_category is untouched: adding parameters to it would create an OVERLOAD, not a
--    replacement, and PostgREST could no longer resolve the existing 6-argument call (the lesson
--    from set_provider_service_base in 20260818120000).
CREATE OR REPLACE FUNCTION public.admin_update_category(
  p_id uuid, p_name text, p_slug text DEFAULT NULL, p_description text DEFAULT NULL
) RETURNS service_categories LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c service_categories; v_slug text;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;

  SELECT * INTO c FROM service_categories WHERE id = p_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'category not found'; END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'a category needs a name'; END IF;

  -- Same normalisation as admin_create_category — a slug arriving from anywhere gets the same
  -- treatment, or the two paths drift and one of them starts producing broken URLs.
  IF NULLIF(btrim(COALESCE(p_slug, '')), '') IS NULL THEN
    v_slug := c.slug;
  ELSE
    v_slug := lower(btrim(p_slug));
    v_slug := regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g');
    v_slug := btrim(v_slug, '-');
    IF v_slug = '' THEN RAISE EXCEPTION 'could not derive a usable slug from %', p_slug; END IF;
    IF EXISTS (SELECT 1 FROM service_categories WHERE slug = v_slug AND id <> p_id) THEN
      RAISE EXCEPTION 'a category with the slug % already exists', v_slug;
    END IF;
  END IF;

  UPDATE service_categories SET
    name        = btrim(p_name),
    slug        = v_slug,
    description = NULLIF(btrim(COALESCE(p_description, '')), '')
  WHERE id = p_id
  RETURNING * INTO c;
  RETURN c;
END; $$;
REVOKE EXECUTE ON FUNCTION public.admin_update_category(uuid, text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_category(uuid, text, text, text) TO authenticated; -- is_admin() inside

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) ASSERT THE THINGS THAT SILENTLY BREAK.
--
--    (a) The new columns must be SELECTable. service_categories currently carries a TABLE-level
--        SELECT grant, so a new column is readable automatically — but that is exactly what was
--        assumed about service_providers, where an explicit column list meant trust_tier shipped
--        unreadable and the tier rendered nowhere for a release (20260813120000). Checked, not
--        assumed: if the grant is ever narrowed to a column list, this migration fails loudly
--        instead of the admin board quietly 42501-ing.
--
--    (b) EXECUTE must not reach anon. Supabase ships
--        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated,
--        so a new function is born with a DIRECT grant to anon, and REVOKE … FROM PUBLIC does not
--        remove a direct role grant. The REVOKEs above name anon for that reason; this proves it.
DO $$
BEGIN
  IF NOT has_column_privilege('anon', 'public.service_categories', 'engagement_model', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.service_categories', 'engagement_model', 'SELECT')
     OR NOT has_column_privilege('anon', 'public.service_categories', 'model_decided_at', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.service_categories', 'model_decided_at', 'SELECT')
  THEN
    RAISE EXCEPTION 'the new category columns are not readable — add an explicit GRANT SELECT (engagement_model, model_decided_at) ON service_categories TO anon, authenticated';
  END IF;

  IF has_function_privilege('anon', 'public.admin_set_category_model(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_update_category(uuid, text, text, text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'anon can still execute an admin category RPC — the REVOKE did not take';
  END IF;
END $$;
