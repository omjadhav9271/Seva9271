/* Seva — fix a regression introduced by 20260806120000 (HARD-3). Run AFTER it.

   HARD-3 added "skip the notification for a booking born under negotiation" to
   notify_on_new_booking, but rebuilt the function body from the Step-4 ORIGINAL
   (20260713120000) instead of the current definition. Three migrations later
   (20260716140000_seva_notification_booking_links) had added the deep link, so the rebuild
   silently dropped it and every "New booking request" notification went out with link = NULL —
   the provider's bell entry stopped opening the booking.

   Caught by verify-step4's "↳ deep-links to this booking" assertion, which is exactly why that
   assertion exists. The lesson is the one this repo keeps relearning with CREATE OR REPLACE:
   re-declare from the LATEST definition, never from the migration that introduced the function.

   This is 20260716140000's body, with only the Step-10 negotiation skip added. */

CREATE OR REPLACE FUNCTION public.notify_on_new_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider_user uuid;
BEGIN
  -- Step 10: a booking born under negotiation is not a booking request. start_negotiation sends
  -- the provider a "New offer" notification carrying the amount; telling them they have a request
  -- to "accept" is both duplicate and wrong — there is nothing to accept yet.
  IF NEW.status = 'negotiating' THEN RETURN NEW; END IF;

  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = NEW.provider_id;
  IF v_provider_user IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, type, link)
    VALUES (v_provider_user, 'New booking request',
            'You have a new booking request. Open Bookings to accept.', 'info',
            '/bookings/' || NEW.id);
  END IF;
  RETURN NEW;
END; $$;
