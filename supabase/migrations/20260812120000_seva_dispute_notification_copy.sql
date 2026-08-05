/* Seva — dispute notification copy. Run AFTER 20260811120000.

   Copy only: no money, no state, no reputation, no signature changes. Two problems, both about a
   party being told something useless or something twice.

   1) "Your dispute has been reviewed and resolved." told the reader nothing they did not already
      know from the title. It now names WHICH WAY the case went, phrased for that party, and sends
      them to the settlement summary on the booking page. No amounts are quoted in the message —
      the page reads those back from the payment ledger, and a number restated here is a number
      that can disagree with it.

   2) notify_on_booking_event fires on EVERY booking_events row, so a dispute produced two
      notifications for the same fact: raise_dispute's own "Dispute raised" plus a generic
      "A dispute was raised — Booking status is now 'disputed'." from the trigger. A favor_customer
      resolution likewise added "Booking cancelled" next to "Dispute resolved". The trigger now
      skips any event carrying a dispute_id in its meta — those are exactly the transitions
      raise_dispute and resolve_dispute already announce, with better copy. ('paid' was already
      skipped, which is why a refunded customer never saw "Payment received".)

   resolve_dispute below is a mechanical transformation of the 20260730120000 declaration — which
   was verified byte-identical to the deployed function (md5 49981157e1ef5ef876cdf27880721279,
   3584 bytes) before this file was generated. The ONLY edits are the two message locals and the
   notification INSERT. Escrow, clawback, fee, status exits and reputation are untouched. */

CREATE OR REPLACE FUNCTION public.resolve_dispute(
  p_dispute_id uuid, p_outcome text, p_fault text, p_notes text DEFAULT NULL,
  p_refund_amount numeric DEFAULT NULL
) RETURNS disputes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d disputes; b bookings; v_provider_user uuid; v_amount numeric; v_next text;
  v_refund numeric; v_remainder numeric; v_fee numeric; v_payout numeric;
  v_msg_customer text; v_msg_provider text;
  c_fee_pct constant numeric := public.platform_fee_pct();
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  IF p_outcome NOT IN ('favor_customer','favor_provider','partial','no_fault') THEN
    RAISE EXCEPTION 'invalid outcome %', p_outcome;
  END IF;
  IF p_fault NOT IN ('customer','provider','none') THEN
    RAISE EXCEPTION 'invalid fault party %', p_fault;
  END IF;

  SELECT * INTO d FROM disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dispute not found'; END IF;
  IF d.status = 'resolved' THEN RAISE EXCEPTION 'already resolved'; END IF;

  SELECT * INTO b FROM bookings WHERE id = d.booking_id FOR UPDATE;
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  v_amount := COALESCE(b.price_charged, b.price_agreed, b.total_amount);

  v_refund := CASE WHEN p_outcome = 'favor_customer' THEN COALESCE(p_refund_amount, v_amount)
                   WHEN p_outcome = 'partial'        THEN p_refund_amount
                   ELSE 0 END;
  IF p_outcome = 'partial' AND (v_refund IS NULL OR v_refund <= 0 OR v_refund >= v_amount) THEN
    RAISE EXCEPTION 'partial resolution needs a refund amount strictly between 0 and %', v_amount;
  END IF;

  IF b.payment_status = 'released' THEN
    IF v_refund > 0 THEN
      PERFORM public.credit_wallet(v_provider_user, v_refund, 'debit',
              'Dispute clawback for booking ' || b.id::text, b.id);
    END IF;
  ELSIF b.payment_status = 'held' THEN
    v_remainder := v_amount - COALESCE(v_refund, 0);
    IF v_remainder > 0 THEN
      v_fee    := round(v_remainder * c_fee_pct, 2);
      v_payout := v_remainder - v_fee;
      PERFORM public.credit_wallet(v_provider_user, v_payout, 'credit',
              'Dispute payout for booking ' || b.id::text, b.id);
      UPDATE payment_transactions SET status='released', provider_amount=v_payout,
             platform_fee=v_fee, updated_at=NOW()
        WHERE booking_id = b.id AND status='captured';
    END IF;
  END IF;

  v_next := CASE WHEN p_outcome = 'favor_customer' THEN 'cancelled' ELSE 'paid' END;
  UPDATE bookings SET
    status = v_next,
    payment_status = CASE WHEN b.payment_status IN ('held','released')
                          THEN CASE WHEN p_outcome IN ('favor_customer','partial') THEN 'refunded'
                                    ELSE 'released' END
                          ELSE b.payment_status END,
    updated_at = NOW()
  WHERE id = b.id;

  UPDATE disputes SET status='resolved', outcome=p_outcome, fault_party=p_fault,
    refund_amount=v_refund, resolution_notes=p_notes,
    resolved_by=auth.uid(), resolved_at=NOW()
  WHERE id = p_dispute_id RETURNING * INTO d;

  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (b.id, 'disputed', v_next, auth.uid(), 'admin',
          jsonb_build_object('dispute_id', d.id, 'outcome', p_outcome, 'fault', p_fault));

  -- Say WHICH WAY it went, to each side in their own terms, and point at the settlement summary
  -- on the booking page. Deliberately no amounts here: the page reads them back from the ledger,
  -- and a figure restated in a notification is a figure that can contradict it.
  v_msg_customer := CASE p_outcome
      WHEN 'favor_customer' THEN 'Resolved in your favour — a refund has been issued.'
      WHEN 'partial'        THEN 'Resolved with a partial refund to you.'
      WHEN 'favor_provider' THEN 'Resolved in the provider''s favour.'
      ELSE                       'Resolved — no fault was found on either side.'
    END || ' Open the booking for the full settlement: what was paid, the platform fee, and what each side ended up with.';
  v_msg_provider := CASE p_outcome
      WHEN 'favor_customer' THEN 'Resolved in the customer''s favour — a refund has been issued to them.'
      WHEN 'partial'        THEN 'Resolved with a partial refund to the customer.'
      WHEN 'favor_provider' THEN 'Resolved in your favour.'
      ELSE                       'Resolved — no fault was found on either side.'
    END || ' Open the booking for the full settlement: what was paid, the platform fee, and what each side ended up with.';

  INSERT INTO notifications (user_id, title, message, type, link) VALUES
    (b.customer_id, 'Dispute resolved', v_msg_customer, 'info', '/bookings/' || b.id),
    (v_provider_user, 'Dispute resolved', v_msg_provider, 'info', '/bookings/' || b.id);

  PERFORM public.compute_reputation('provider', b.provider_id);
  PERFORM public.compute_reputation('customer', b.customer_id);
  RETURN d;
END; $$;

REVOKE EXECUTE ON FUNCTION public.resolve_dispute(uuid,text,text,text,numeric) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_dispute(uuid,text,text,text,numeric) TO authenticated; -- guarded by is_admin() inside


-- ─────────────────────────────────────────────────────────────────────────────
-- notify_on_booking_event: leave dispute transitions to the RPCs that own them.
-- Faithful copy of the 20260806120000 version with ONE added guard.
CREATE OR REPLACE FUNCTION public.notify_on_booking_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer uuid; v_provider_user uuid; v_recipient uuid;
  v_title text; v_type text;
BEGIN
  -- Money settlement ('paid') is notified with explicit recipients by release_escrow_on_confirm.
  IF NEW.to_status = 'paid' THEN
    RETURN NEW;
  END IF;
  -- Step 10: the bargaining RPCs notify explicitly, with copy that is careful never to leak how
  -- far a declined offer was from the provider's floor. A generic 'status is now "expired"' both
  -- duplicates that and undoes the care taken over it.
  IF NEW.to_status IN ('negotiating', 'expired') THEN
    RETURN NEW;
  END IF;
  -- Dispute transitions carry a dispute_id in meta. raise_dispute and resolve_dispute already
  -- notify both parties (and every admin) with copy that names the raiser, the reason and the
  -- outcome; a second generic line is duplication, not reassurance.
  IF NEW.meta ->> 'dispute_id' IS NOT NULL THEN
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
