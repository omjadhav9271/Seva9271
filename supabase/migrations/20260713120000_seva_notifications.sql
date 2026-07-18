/* Seva — Step 4: notifications wiring. Run AFTER the Step 3 migration. */

-- Notifications are system-generated only → drop client insert so the bell can be trusted.
-- (select/update/delete on OWN notifications remain: read, mark-read, dismiss.)
DROP POLICY IF EXISTS "insert_own_notification" ON notifications;

-- 1) New booking request → notify the provider.
CREATE OR REPLACE FUNCTION public.notify_on_new_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider_user uuid;
BEGIN
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = NEW.provider_id;
  IF v_provider_user IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (v_provider_user, 'New booking request',
            'You have a new booking request. Open Bookings to accept.', 'info');
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_notify_new_booking ON bookings;
CREATE TRIGGER trg_notify_new_booking AFTER INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION public.notify_on_new_booking();

-- 2) Status transition → notify the OTHER party (reads the booking_events log Step 2 writes).
CREATE OR REPLACE FUNCTION public.notify_on_booking_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer uuid; v_provider_user uuid; v_recipient uuid;
  v_title text; v_type text;
BEGIN
  SELECT b.customer_id, sp.user_id INTO v_customer, v_provider_user
  FROM bookings b JOIN service_providers sp ON sp.id = b.provider_id
  WHERE b.id = NEW.booking_id;

  IF    NEW.actor_role = 'customer' THEN v_recipient := v_provider_user;
  ELSIF NEW.actor_role = 'provider' THEN v_recipient := v_customer;
  ELSE  v_recipient := v_customer;   -- system/admin: default to the customer
  END IF;

  v_title := CASE NEW.to_status
    WHEN 'accepted'    THEN 'Booking accepted'
    WHEN 'en_route'    THEN 'Provider is on the way'
    WHEN 'arrived'     THEN 'Provider has arrived'
    WHEN 'in_progress' THEN 'Work has started'
    WHEN 'completed'   THEN 'Job marked complete'
    WHEN 'confirmed'   THEN 'Job confirmed'
    WHEN 'paid'        THEN 'Payment received'
    WHEN 'cancelled'   THEN 'Booking cancelled'
    WHEN 'disputed'    THEN 'A dispute was raised'
    ELSE 'Booking updated'
  END;
  v_type := CASE NEW.to_status
    WHEN 'accepted' THEN 'success' WHEN 'confirmed' THEN 'success' WHEN 'paid' THEN 'success'
    WHEN 'cancelled' THEN 'warning' WHEN 'disputed' THEN 'error'
    ELSE 'info'
  END;

  IF v_recipient IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (v_recipient, v_title, 'Booking status is now "' || NEW.to_status || '".', v_type);
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_notify_booking_event ON booking_events;
CREATE TRIGGER trg_notify_booking_event AFTER INSERT ON booking_events
FOR EACH ROW EXECUTE FUNCTION public.notify_on_booking_event();

-- 3) New message → notify the recipient (the party who isn't the sender).
CREATE OR REPLACE FUNCTION public.notify_on_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_customer uuid; v_provider_user uuid; v_recipient uuid;
BEGIN
  SELECT b.customer_id, sp.user_id INTO v_customer, v_provider_user
  FROM bookings b JOIN service_providers sp ON sp.id = b.provider_id
  WHERE b.id = NEW.booking_id;
  v_recipient := CASE WHEN NEW.sender_id = v_customer THEN v_provider_user ELSE v_customer END;
  IF v_recipient IS NOT NULL AND v_recipient <> NEW.sender_id THEN
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (v_recipient, 'New message', 'You have a new message about a booking.', 'info');
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_notify_message ON messages;
CREATE TRIGGER trg_notify_message AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION public.notify_on_message();

-- 4) Realtime for the bell (guarded so re-runs don't error).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
  END IF;
END $$;
