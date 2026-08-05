/* Seva — dispute clarity pass. Run AFTER 20260810120000.

   Two additions, both about a dispute being ANSWERABLE rather than merely recorded. No money
   logic changes: resolve_dispute, credit_wallet, the escrow release and the reputation formulas
   are untouched by this file.

   1) ADMINS ARE TOLD. raise_dispute notified only the accused party — the review team learned
      about a case by refreshing /admin/disputes. Every admin now gets a notification linking
      straight to /admin/disputes/<dispute_id>. The party-facing message also names the reason and
      the raiser's side, so the accused knows what to answer before opening the booking.
      Everything else in the function (party check, state guard, the disputes row, the bookings
      update, the booking_events row) is a faithful copy of 20260728120000.

   2) LIVE OFFERS + DISPUTES. `bookings` has been in the realtime publication since 20260725, but
      `offers` and `disputes` were not — and respond_offer's COUNTER branch (20260806120000)
      touches offers ONLY, never bookings. So a counter-offer was invisible to the other party
      until they reloaded: clicking the notification showed the previous round. Adding both tables
      lets the booking page reflect a counter, a dispute and its resolution live. RLS still gates
      the stream (read_offers_parties / read_own_or_admin_disputes), so a subscriber receives only
      rows it could already SELECT.
      NOTE: booking_events is deliberately NOT added — every event insert in this schema is paired
      with a bookings UPDATE, which is already live. */

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) raise_dispute: same behaviour, plus admin recipients and sharper copy.
CREATE OR REPLACE FUNCTION public.raise_dispute(
  p_booking_id uuid, p_reason text, p_description text DEFAULT NULL
) RETURNS disputes LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b bookings; v_provider_user uuid; v_role text; d disputes; v_other uuid;
  v_label text; v_short text;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking not found'; END IF;
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = b.provider_id;
  IF    auth.uid() = b.customer_id   THEN v_role := 'customer';
  ELSIF auth.uid() = v_provider_user THEN v_role := 'provider';
  ELSE  RAISE EXCEPTION 'not a party to this booking'; END IF;

  IF b.status NOT IN ('arrived','in_progress','completed','confirmed','paid') THEN
    RAISE EXCEPTION 'this booking cannot be disputed at status %', b.status;
  END IF;

  INSERT INTO disputes (booking_id, raised_by, raiser_role, reason, description)
  VALUES (p_booking_id, auth.uid(), v_role, p_reason, p_description)
  RETURNING * INTO d;   -- partial unique index blocks a second open dispute

  UPDATE bookings SET status='disputed', updated_at=NOW() WHERE id = p_booking_id;
  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (p_booking_id, b.status, 'disputed', auth.uid(), v_role,
          jsonb_build_object('dispute_id', d.id, 'reason', p_reason));

  -- Human label for the notification copy; mirrors REASON_LABELS in lib/disputes.ts.
  v_label := CASE p_reason
    WHEN 'work_not_done'        THEN 'work not done'
    WHEN 'poor_quality'         THEN 'poor quality of work'
    WHEN 'overcharged'          THEN 'overcharging'
    WHEN 'no_show'              THEN 'a no-show'
    WHEN 'damage'               THEN 'property damage'
    WHEN 'payment_not_received' THEN 'payment not received'
    WHEN 'customer_behaviour'   THEN 'customer behaviour'
    ELSE 'a problem with the booking'
  END;
  v_short := left(p_booking_id::text, 8);

  -- The accused party: say WHO raised it and WHAT it is about, so they know what to answer.
  v_other := CASE WHEN v_role='customer' THEN v_provider_user ELSE b.customer_id END;
  IF v_other IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, type, link) VALUES
      (v_other, 'Dispute raised',
       'The ' || v_role || ' raised a dispute about ' || v_label || ' on booking #' || v_short ||
       '. Open it to read their message and attach your evidence.',
       'warning', '/bookings/' || p_booking_id);
  END IF;

  -- Every admin, straight to the case. Skipping auth.uid()/v_other is belt-and-braces: an admin
  -- is not normally a party, and if they were they already have the party notification above.
  INSERT INTO notifications (user_id, title, message, type, link)
  SELECT p.id, 'New dispute to review',
         'The ' || v_role || ' raised a dispute about ' || v_label || ' on booking #' || v_short || '.',
         'warning', '/admin/disputes/' || d.id
  FROM profiles p
  WHERE p.role = 'admin' AND p.id <> auth.uid() AND p.id IS DISTINCT FROM v_other;

  RETURN d;
END; $$;
GRANT EXECUTE ON FUNCTION public.raise_dispute(uuid,text,text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Realtime: offers + disputes join bookings/messages/notifications/reviews in the publication.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'offers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE offers;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'disputes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE disputes;
  END IF;
END $$;
