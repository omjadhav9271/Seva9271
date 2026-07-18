/* Seva — Step 4 follow-up: give notifications a link to their source. Run AFTER 20260713120000. */

-- Where a notification points. NULL for pre-existing rows (they simply won't be clickable).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link text;

-- Recreate the three trigger functions so each INSERT also stamps link = '/bookings/<id>'.
-- Everything else is identical; triggers stay bound (CREATE OR REPLACE keeps them).

-- 1) New booking request → notify the provider.
CREATE OR REPLACE FUNCTION public.notify_on_new_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider_user uuid;
BEGIN
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = NEW.provider_id;
  IF v_provider_user IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, type, link)
    VALUES (v_provider_user, 'New booking request',
            'You have a new booking request. Open Bookings to accept.', 'info',
            '/bookings/' || NEW.id);
  END IF;
  RETURN NEW;
END; $$;

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
    INSERT INTO notifications (user_id, title, message, type, link)
    VALUES (v_recipient, v_title, 'Booking status is now "' || NEW.to_status || '".', v_type,
            '/bookings/' || NEW.booking_id);
  END IF;
  RETURN NEW;
END; $$;

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
    INSERT INTO notifications (user_id, title, message, type, link)
    VALUES (v_recipient, 'New message', 'You have a new message about a booking.', 'info',
            '/bookings/' || NEW.booking_id);
  END IF;
  RETURN NEW;
END; $$;
