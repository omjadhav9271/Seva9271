/* Seva — Step 5 follow-up: correct recipients for money notifications.
   Run AFTER 20260719120000. Two problems this fixes:

   1) The escrow-release 'paid' event (inserted by release_escrow_on_confirm, actor_role
      'system') fell through the generic notify_on_booking_event to its ELSE branch and
      wrongly notified the CUSTOMER with "Payment received". The provider — who actually got
      paid — was notified of nothing.
   2) The webhook that sets payment_status='held' now inserts a provider notification itself
      (app/api/payments/webhook), so 'held' is covered on the server side.

   Money events must name their recipients explicitly, never ride the other-party path. So:
   - notify_on_booking_event SKIPS 'paid' entirely (money is handled explicitly below).
   - release_escrow_on_confirm inserts two role-specific notifications on release:
       provider → payout credited; customer → payment complete (receipt).
   Both are plain INSERTs into notifications, so the realtime bell delivers them live. */

-- 1) Generic status notifier: no longer touches 'paid'. Identical to 20260716140000 except for
--    the early return — money notifications are addressed explicitly in (2), so the other-party
--    default can never mis-deliver a 'paid' notification to the customer again.
--    (Side effect: the cod 'paid' event also stops emitting the old mis-addressed notification;
--     correct for the online-only launch — no COD money notification is added.)
CREATE OR REPLACE FUNCTION public.notify_on_booking_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer uuid; v_provider_user uuid; v_recipient uuid;
  v_title text; v_type text;
BEGIN
  -- Money settlement ('paid') is notified with explicit recipients by
  -- release_escrow_on_confirm (provider: payout, customer: receipt). Skip it here so the
  -- generic other-party path never addresses a money event to the wrong party.
  IF NEW.to_status = 'paid' THEN
    RETURN NEW;
  END IF;

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
    WHEN 'cancelled'   THEN 'Booking cancelled'
    WHEN 'disputed'    THEN 'A dispute was raised'
    ELSE 'Booking updated'
  END;
  v_type := CASE NEW.to_status
    WHEN 'accepted' THEN 'success' WHEN 'confirmed' THEN 'success'
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

-- 2) Release trigger: same settlement logic as 20260718120000, plus two explicit money
--    notifications in the online (escrow) branch. Everything else is unchanged.
CREATE OR REPLACE FUNCTION public.release_escrow_on_confirm()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b bookings; v_provider_user uuid; v_amount numeric; v_fee numeric; v_payout numeric;
  v_fee_pct constant numeric := 0.15;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = NEW.booking_id FOR UPDATE;
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  v_amount := COALESCE(b.price_charged, b.price_agreed, b.total_amount);

  IF b.payment_status = 'held' THEN
    v_fee    := round(v_amount * v_fee_pct, 2);
    v_payout := v_amount - v_fee;
    PERFORM public.credit_wallet(v_provider_user, v_payout, 'credit',
              'Payout for booking ' || b.id::text, b.id);
    UPDATE payment_transactions SET status='released', provider_amount=v_payout,
              platform_fee=v_fee, updated_at=NOW()
      WHERE booking_id = b.id AND status = 'captured';
    UPDATE bookings SET payment_status='released', status='paid', updated_at=NOW() WHERE id=b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
      VALUES (b.id, 'confirmed', 'paid', NULL, 'system',
              jsonb_build_object('payout', v_payout, 'fee', v_fee));

    -- Explicit money notifications (never the generic other-party path).
    -- Provider: the payout that landed in their wallet.
    IF v_provider_user IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, type, link)
      VALUES (v_provider_user, 'Payout received',
              '₹' || trim_scale(v_payout) || ' added to your wallet', 'success',
              '/bookings/' || b.id);
    END IF;
    -- Customer: a receipt confirming the payment is complete.
    IF b.customer_id IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, type, link)
      VALUES (b.customer_id, 'Payment complete',
              'Payment of ₹' || trim_scale(v_amount) || ' complete. Thank you!', 'success',
              '/bookings/' || b.id);
    END IF;
  ELSIF b.payment_method = 'cod' THEN
    UPDATE bookings SET status='paid', updated_at=NOW() WHERE id=b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
      VALUES (b.id, 'confirmed', 'paid', NULL, 'system', jsonb_build_object('cash', true));
  END IF;  -- online-but-unpaid: stays 'confirmed' until a webhook marks it held
  RETURN NEW;
END; $$;
