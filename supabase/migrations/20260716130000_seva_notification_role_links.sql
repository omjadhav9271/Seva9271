/* Seva — Step 4 follow-up: status links carry the recipient's role. Run AFTER 20260716120000. */

-- /bookings opens on the customer tab by default, so a bare link hid the booking from a
-- provider recipient. The triggers already know which side they're notifying — encode it.
-- Message notifications still deep-link to the chat and are left alone.

-- 1) New booking request → notify the provider. Recipient is always the provider, and the
--    booking is always 'requested', so land them on the tab where the Accept button lives.
CREATE OR REPLACE FUNCTION public.notify_on_new_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider_user uuid;
BEGIN
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = NEW.provider_id;
  IF v_provider_user IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, type, link)
    VALUES (v_provider_user, 'New booking request',
            'You have a new booking request. Open Bookings to accept.', 'info',
            '/bookings?role=provider&status=requested');
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
            '/bookings?role='
              || CASE WHEN v_recipient = v_provider_user THEN 'provider' ELSE 'customer' END
              || '&status=' || NEW.to_status);
  END IF;
  RETURN NEW;
END; $$;

-- 3) notify_on_message is deliberately NOT redefined here — messages keep deep-linking to
--    /bookings/<id> (the chat), as set in 20260716120000.
