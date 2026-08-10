/* Seva — the customer's precise service address: per-booking, and revealed to the provider only
   once the job is on.

   WHY THIS IS ON THE BOOKING AND NOT THE PROFILE. A customer books for different places — their
   own flat this week, a parent's home next week, their office the week after. One "home address"
   on the profile is the wrong model: it is either stale or wrong for most bookings, and it invites
   the provider to be shown an address that has nothing to do with the job they accepted. The
   service address is a fact about THE BOOKING, captured when the booking is made.

   `bookings.address` already existed and was already in the INSERT grant — but nothing in the app
   ever wrote it, and every party to a booking could read it. This migration makes it real and
   makes it private:

     · a pincode + optional map pin join it, so there is a COARSE locality to show before the
       reveal and a precise pin to fall back on after it;
     · the four location columns lose their SELECT grant, exactly as latitude/longitude/geo did on
       service_providers in 20260727120000;
     · booking_service_location() becomes the only way to read them, and it decides per caller and
       per booking status who sees what.

   🔴 THE REVEAL BOUNDARY IS 'accepted' AND LATER, NOT THE 'confirmed' STATUS. In this state
   machine `confirmed` means the CUSTOMER confirmed the work is DONE — it sits just before escrow
   release, at the end. Gating the address on it would hand the provider a navigation address after
   the job they had already travelled to. The boundary that means "this booking is really on" is
   the provider accepting it, so that is where the address unlocks. A booking that is still
   `requested` or `negotiating` — and one that was `cancelled` or has `expired` — shows the
   provider the pincode and nothing more.

   HONEST LIMIT, stated rather than papered over: `notes` is free text the customer writes, it
   stays visible to the provider from the moment the booking exists, and a customer can type their
   address into it. This migration protects the structured address field; it cannot stop someone
   volunteering the same information in a sentence. The UI labels the address field as the place
   the address goes, which is the part we control. */

-- 1) The service location: precise address (already present), plus a coarse pincode and an
--    OPTIONAL map pin. The pin is a fallback for Google Maps, not an input to matching — nothing
--    here feeds search_providers, and the coordinate-privacy invariant is about PROVIDER
--    coordinates, which this file does not touch.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_pincode text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_lat double precision;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_lng double precision;

-- Six digits, first digit 1-9 — the shape of an Indian PIN. Cheap, and it keeps the coarse label
-- from becoming a second free-text field that renders as "near the big temple" on the provider's
-- screen. NULL stays legal: a customer who doesn't know it is not blocked from booking.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_service_pincode_shape;
ALTER TABLE bookings ADD CONSTRAINT bookings_service_pincode_shape
  CHECK (service_pincode IS NULL OR service_pincode ~ '^[1-9][0-9]{5}$');

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_service_pin_range;
ALTER TABLE bookings ADD CONSTRAINT bookings_service_pin_range
  CHECK (
    (service_lat IS NULL AND service_lng IS NULL)
    OR (service_lat BETWEEN -90 AND 90 AND service_lng BETWEEN -180 AND 180)
  );

-- 2) A customer may still DESCRIBE the job, now including where it is. Extends the birth-state
--    grant from 20260803120000 — that file's reasoning is unchanged: state and money stay
--    ungrantable, so they keep taking their defaults.
GRANT INSERT (service_pincode, service_lat, service_lng) ON bookings TO authenticated;

/* 3) The location columns lose their SELECT grant. Same mechanism as the provider coordinate
      lockdown (20260727120000): RLS is ROW-level and cannot hide a column from one party and show
      it to the other on the same row, so the privilege has to come off the column and reads have
      to route through a definer function that can apply the per-caller, per-status rule.

      The grant list is BUILT FROM THE CATALOG rather than typed out. Hand-enumerating 19 columns
      means the next migration that adds one silently leaves it ungranted, and the failure surfaces
      as a 42501 on an unrelated page long afterwards. Withholding is the deliberate act here, so
      the withheld list is what this file names explicitly. */
DO $$
DECLARE
  withheld text[] := ARRAY['address', 'service_pincode', 'service_lat', 'service_lng'];
  cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'bookings'
    AND NOT (column_name = ANY (withheld));

  EXECUTE 'REVOKE SELECT ON public.bookings FROM anon, authenticated';
  EXECUTE format('GRANT SELECT (%s) ON public.bookings TO anon, authenticated', cols);
END $$;

/* 4) The ONLY way to read a booking's service location.

   Returns one row for a caller entitled to something, and NO rows for anyone else — a stranger
   learns nothing, not even whether the booking exists.

   `revealed` is the honest flag the UI renders against: when it is false the address and the pin
   come back NULL (not blanked client-side — never sent at all), and only the pincode is returned
   so the provider can still see the locality they are being asked to travel to. */
CREATE OR REPLACE FUNCTION public.booking_service_location(p_booking_id uuid)
RETURNS TABLE (
  booking_id uuid,
  viewer_role text,
  revealed boolean,
  address text,
  pincode text,
  lat double precision,
  lng double precision
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b            bookings%ROWTYPE;
  uid          uuid := auth.uid();
  is_customer  boolean;
  is_provider  boolean;
  admin        boolean;
  can_see      boolean;
BEGIN
  -- The outer fence. 20260818130000 is the write-up: a definer function in this schema is created
  -- with EXECUTE granted DIRECTLY to anon by Supabase's default privileges, and revoking from
  -- PUBLIC does not remove a direct role grant. The REVOKE below closes it; this refuses rather
  -- than quietly matching no row if it is ever re-granted.
  IF uid IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to view a booking address';
  END IF;

  SELECT * INTO b FROM bookings WHERE id = p_booking_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  is_customer := (b.customer_id = uid);
  is_provider := EXISTS (SELECT 1 FROM service_providers sp WHERE sp.id = b.provider_id AND sp.user_id = uid);
  admin       := public.is_admin();

  IF NOT (is_customer OR is_provider OR admin) THEN
    RETURN;   -- not a party: no row, no error, nothing learned
  END IF;

  -- The customer wrote the address and an admin handling a dispute needs it; the PROVIDER is the
  -- one this gate exists for. 'accepted' and later = the booking is on. Listed rather than
  -- expressed as "not in (requested, negotiating, …)" so that a status added later is withheld by
  -- default instead of revealed by accident.
  can_see := is_customer OR admin OR (
    is_provider AND b.status IN (
      'accepted', 'en_route', 'arrived', 'in_progress',
      'completed', 'confirmed', 'paid', 'reviewed', 'disputed'
    )
  );

  RETURN QUERY SELECT
    b.id,
    CASE WHEN is_customer THEN 'customer' WHEN is_provider THEN 'provider' ELSE 'admin' END,
    can_see,
    CASE WHEN can_see THEN b.address       ELSE NULL END,
    b.service_pincode,
    CASE WHEN can_see THEN b.service_lat   ELSE NULL END,
    CASE WHEN can_see THEN b.service_lng   ELSE NULL END;
END;
$$;
REVOKE ALL ON FUNCTION public.booking_service_location(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.booking_service_location(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.booking_service_location(uuid) TO authenticated;

/* 5) Writing the location. The direct-booking path sets these columns on INSERT through the grant
   above; the OFFER path cannot, because start_negotiation owns that insert and adding parameters
   to it would create the overload PostgREST can't resolve (20260818120000, 20260820120000). So the
   customer gets one small definer RPC — their own booking, their own address, never anyone
   else's, and never on a booking that is already finished. */
CREATE OR REPLACE FUNCTION public.set_booking_service_location(
  p_booking_id uuid,
  p_address text DEFAULT NULL,
  p_pincode text DEFAULT NULL,
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to set a booking address';
  END IF;

  UPDATE bookings
     SET address         = COALESCE(NULLIF(btrim(p_address), ''), address),
         service_pincode = COALESCE(NULLIF(btrim(p_pincode), ''), service_pincode),
         service_lat     = COALESCE(p_lat, service_lat),
         service_lng     = COALESCE(p_lng, service_lng),
         updated_at      = now()
   WHERE id = p_booking_id
     AND customer_id = uid
     -- Correcting a flat number while the provider is on the way is legitimate; rewriting where
     -- the job happened after it is settled is not.
     AND status NOT IN ('completed', 'confirmed', 'paid', 'reviewed', 'cancelled', 'expired');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That booking cannot be updated (not yours, or no longer in progress)';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_booking_service_location(uuid,text,text,double precision,double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_booking_service_location(uuid,text,text,double precision,double precision) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_booking_service_location(uuid,text,text,double precision,double precision) TO authenticated;

/* 6) Fail the migration rather than discover any of this in a browser. Each block below is a
      property the whole file exists to establish. */
DO $$
DECLARE leaked text;
BEGIN
  SELECT string_agg(DISTINCT column_name, ', ') INTO leaked
  FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'bookings'
    AND privilege_type = 'SELECT' AND grantee IN ('anon', 'authenticated')
    AND column_name IN ('address', 'service_pincode', 'service_lat', 'service_lng');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'Booking address privacy violated: % selectable by anon/authenticated', leaked;
  END IF;

  -- The other half of the same property: everything ELSE must still be selectable, or the pages
  -- that read a booking break. A lockdown that takes the whole table with it is not a fix.
  SELECT string_agg(c.column_name, ', ') INTO leaked
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'bookings'
    AND c.column_name NOT IN ('address', 'service_pincode', 'service_lat', 'service_lng')
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.column_privileges p
      WHERE p.table_schema = 'public' AND p.table_name = 'bookings'
        AND p.column_name = c.column_name
        AND p.privilege_type = 'SELECT' AND p.grantee = 'authenticated'
    );
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'Booking lockdown went too far: % is no longer selectable', leaked;
  END IF;

  IF has_function_privilege('anon', 'public.booking_service_location(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute booking_service_location';
  END IF;
  IF has_function_privilege('anon', 'public.set_booking_service_location(uuid,text,text,double precision,double precision)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute set_booking_service_location';
  END IF;
END $$;
