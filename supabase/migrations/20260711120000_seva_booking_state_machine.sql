/* Seva — Booking state machine. Run AFTER the Step 1 migrations. */

-- 1) PRICE: agreed (locked at booking) vs charged (set at customer-confirm).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_agreed  NUMERIC;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS price_charged NUMERIC;
UPDATE bookings SET price_agreed = NULLIF(total_amount, 0) WHERE price_agreed IS NULL;

CREATE OR REPLACE FUNCTION public.set_booking_price_agreed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price_agreed IS NULL THEN
    NEW.price_agreed := COALESCE(NULLIF(NEW.total_amount, 0),
                                 NEW.hourly_rate * COALESCE(NEW.duration_hours, 1));
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_set_price_agreed ON bookings;
CREATE TRIGGER trg_set_price_agreed BEFORE INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION public.set_booking_price_agreed();

-- 2) STATUS: expand the lifecycle. Remap legacy values, then swap the CHECK + default.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
UPDATE bookings SET status = 'requested' WHERE status = 'pending';
UPDATE bookings SET status = 'accepted'  WHERE status = 'confirmed';  -- old 'confirmed' meant provider-accepted
ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'requested';
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'requested','accepted','en_route','arrived','in_progress',
  'completed','confirmed','paid','reviewed','cancelled','disputed','expired'
));

-- 3) EVENTS: one timestamped row per transition. Written ONLY by the RPC below.
CREATE TABLE IF NOT EXISTS booking_events (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id  UUID REFERENCES bookings(id) ON DELETE CASCADE NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    UUID REFERENCES auth.users(id),
  actor_role  TEXT CHECK (actor_role IN ('customer','provider','system','admin')),
  meta        JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_events_booking ON booking_events(booking_id);
ALTER TABLE booking_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "select_own_booking_events" ON booking_events;
CREATE POLICY "select_own_booking_events" ON booking_events FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM bookings b WHERE b.id = booking_events.booking_id
    AND (b.customer_id = auth.uid()
         OR auth.uid() IN (SELECT user_id FROM service_providers WHERE id = b.provider_id))
));
-- no INSERT/UPDATE/DELETE policy → clients can't write events; the definer RPC bypasses RLS.
REVOKE INSERT, UPDATE, DELETE ON booking_events FROM authenticated, anon;

-- 4) LOCK direct status writes (same column-grant pattern as Step 1).
--    Clients may still edit descriptive fields; status/price/payment move only via the RPC.
REVOKE UPDATE ON bookings FROM authenticated;
GRANT  UPDATE (notes, address, scheduled_date, scheduled_time) ON bookings TO authenticated;

-- 5) The ONE transition function. SECURITY DEFINER so it can write locked columns,
--    but it authorizes the caller and validates every transition internally.
CREATE OR REPLACE FUNCTION public.transition_booking(
  p_booking_id    uuid,
  p_next_status   text,
  p_price_charged numeric DEFAULT NULL,
  p_meta          jsonb   DEFAULT '{}'::jsonb
) RETURNS bookings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b               bookings;
  v_from          text;
  v_role          text;
  v_provider_user uuid;
  v_allowed       boolean := false;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking not found'; END IF;
  v_from := b.status;

  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  IF    auth.uid() = b.customer_id   THEN v_role := 'customer';
  ELSIF auth.uid() = v_provider_user THEN v_role := 'provider';
  ELSE  RAISE EXCEPTION 'not authorized for this booking';
  END IF;

  v_allowed := CASE
    WHEN v_from='requested'   AND p_next_status='accepted'    AND v_role='provider' THEN true
    WHEN v_from='requested'   AND p_next_status='cancelled'                          THEN true
    WHEN v_from='accepted'    AND p_next_status='en_route'    AND v_role='provider' THEN true
    WHEN v_from='accepted'    AND p_next_status='cancelled'                          THEN true
    WHEN v_from='en_route'    AND p_next_status='arrived'     AND v_role='provider' THEN true
    WHEN v_from='en_route'    AND p_next_status='cancelled'                          THEN true
    WHEN v_from='arrived'     AND p_next_status='in_progress' AND v_role='provider' THEN true
    WHEN v_from='arrived'     AND p_next_status='disputed'                           THEN true
    WHEN v_from='in_progress' AND p_next_status='completed'   AND v_role='provider' THEN true
    WHEN v_from='in_progress' AND p_next_status='disputed'                           THEN true
    WHEN v_from='completed'   AND p_next_status='confirmed'   AND v_role='customer' THEN true
    WHEN v_from='completed'   AND p_next_status='disputed'    AND v_role='customer' THEN true
    -- STUB until Step 5 (escrow): customer "marks paid". Step 5 replaces this with the webhook.
    WHEN v_from='confirmed'   AND p_next_status='paid'        AND v_role='customer' THEN true
    WHEN v_from='confirmed'   AND p_next_status='disputed'    AND v_role='customer' THEN true
    ELSE false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'illegal transition % -> % for role %', v_from, p_next_status, v_role;
  END IF;

  UPDATE bookings SET
    status         = p_next_status,
    price_charged  = CASE WHEN p_next_status='confirmed'
                          THEN COALESCE(p_price_charged, price_charged, price_agreed, total_amount)
                          ELSE price_charged END,
    payment_status = CASE WHEN p_next_status='paid' THEN 'paid' ELSE payment_status END,
    updated_at     = NOW()
  WHERE id = p_booking_id
  RETURNING * INTO b;

  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (p_booking_id, v_from, p_next_status, auth.uid(), v_role, COALESCE(p_meta, '{}'::jsonb));

  RETURN b;
END; $$;

GRANT EXECUTE ON FUNCTION public.transition_booking(uuid, text, numeric, jsonb) TO authenticated;
