/* Seva — settle the unit of the bargaining pricing columns: they are JOB TOTALS, not per-hour.

   FOUND BY: browser audit 2026-08-07 (F-2 in /docs/Seva-Browser-Audit-2026-08-07.md).

   THE SYMPTOM. One provider quoted two different prices for the same job. On /providers/[id] the
   offer sheet said "Listed at ₹600/hr" while the button beside it said "Book at ₹600" for a
   2-hour job; starting a negotiation then produced a booking whose total_amount was ₹1,200.

   THE AMBIGUITY. Step 10 seeded `UPDATE service_providers SET list_price = hourly_rate`, which
   reads as per-hour, and start_negotiation multiplied list_price by duration_hours — also
   per-hour. But floor_price and auto_accept_threshold are compared DIRECTLY against p_amount,
   and p_amount is the customer's whole-job offer (the UI input reads "Your offer for N hours").
   So the two halves of the same feature disagreed about the unit.

   THE RESOLUTION — job totals. Three independent things force it:

     1. The security-critical comparisons already work this way, and were verified live:
        an offer of ₹100 auto-declined against floor 400; ₹450 routed to the provider; the
        threshold is 550. Under a per-hour reading those gates would sit at ₹800/₹1,100 for a
        2-hour job and the ₹450 offer would have auto-declined. It did not.
     2. The `sp_pricing_sane` CHECK requires floor_price <= list_price, so all four pricing
        columns must share one unit. Given (1), that unit is the job total.
     3. Everything else in the negotiation object model is a job total: offers.amount, the
        accepted price, price_agreed, and what escrow charges.

     The ladder on the only negotiable provider reads coherently as totals — floor 400 <
     auto-accept 550 < list 600 — and incoherently as per-hour.

   WHAT CHANGES HERE:

     (a) start_negotiation no longer multiplies list_price by duration. total_amount on a
         negotiating booking is now the same figure the "Book at ₹X" button shows, so a customer
         never sees a price nobody quoted. (price_agreed still stays NULL until an offer is
         accepted — untouched, and it is what makes /api/payments/create-order refuse to charge
         an unagreed booking.)

     (b) The Step-10 seed is undone for FIXED-price providers only. `list_price = hourly_rate` put
         a per-hour number into a job-total column. list_price is never read on the fixed path, so
         clearing it is a no-op today — but it stops those rows from silently mis-pricing the day
         someone switches to negotiable, and lets the COALESCE fallback compute a correct total.
         Rows where list_price <> hourly_rate were set deliberately and are left alone; the one
         negotiable provider (600 vs hourly 300) is untouched.

     (c) The column meaning is written down, so the next person does not have to re-derive it. */

-- ─────────────────────────────────────────────────────────────────────────────
-- (a) total_amount is a job total, seeded exactly like the instant-book path.
CREATE OR REPLACE FUNCTION public.start_negotiation(
  p_provider_id uuid, p_amount numeric, p_service_type text DEFAULT 'one-time',
  p_scheduled_date date DEFAULT NULL, p_scheduled_time time DEFAULT NULL,
  p_duration_hours numeric DEFAULT 2, p_notes text DEFAULT NULL, p_address text DEFAULT NULL
) RETURNS offers LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sp service_providers; b bookings; o offers; v_recent int; v_expiry timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'must be signed in'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'offer must be positive'; END IF;

  SELECT * INTO sp FROM service_providers WHERE id = p_provider_id;
  IF NOT FOUND OR sp.status <> 'approved' THEN RAISE EXCEPTION 'provider not available'; END IF;
  IF sp.pricing_mode <> 'negotiable' THEN RAISE EXCEPTION 'this provider has fixed pricing'; END IF;
  IF sp.user_id = auth.uid() THEN RAISE EXCEPTION 'cannot negotiate with yourself'; END IF;

  -- ANTI-PROBING: without this a customer binary-searches the floor across fresh bookings.
  SELECT count(*) INTO v_recent FROM bookings
   WHERE customer_id = auth.uid() AND provider_id = p_provider_id
     AND status IN ('negotiating','expired') AND created_at > now() - interval '24 hours';
  IF v_recent >= 3 THEN
    RAISE EXCEPTION 'too many offers to this provider today — try again tomorrow';
  END IF;

  INSERT INTO bookings (customer_id, provider_id, category_id, service_type, scheduled_date,
                        scheduled_time, duration_hours, hourly_rate, total_amount,
                        payment_method, notes, address, status)
  VALUES (auth.uid(), p_provider_id, sp.category_id, p_service_type, p_scheduled_date,
          p_scheduled_time, p_duration_hours, sp.hourly_rate,
          -- list_price is ALREADY a job total; only the hourly_rate fallback needs scaling.
          COALESCE(sp.list_price, sp.hourly_rate * COALESCE(p_duration_hours, 1)),
          'upi', p_notes, p_address, 'negotiating')
  RETURNING * INTO b;

  v_expiry := now() + interval '24 hours';
  INSERT INTO offers (booking_id, round, made_by, actor_role, amount, expires_at)
  VALUES (b.id, 1, auth.uid(), 'customer', p_amount, v_expiry) RETURNING * INTO o;

  INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
  VALUES (b.id, NULL, 'negotiating', auth.uid(), 'customer', jsonb_build_object('offer', p_amount));

  -- at or above the threshold → done, no round trip
  IF sp.auto_accept_threshold IS NOT NULL AND p_amount >= sp.auto_accept_threshold THEN
    PERFORM public.accept_offer_internal(o.id, 'auto');
    SELECT * INTO o FROM offers WHERE id = o.id;
    RETURN o;
  END IF;

  -- below the hidden floor → declined, and the negotiation ENDS. A probe costs a booking.
  IF sp.floor_price IS NOT NULL AND p_amount < sp.floor_price THEN
    UPDATE offers SET status='declined', responded_at=now() WHERE id = o.id;
    UPDATE bookings SET status='expired', updated_at=now() WHERE id = b.id;
    INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
    VALUES (b.id, 'negotiating', 'expired', NULL, 'system', '{"reason":"declined"}'::jsonb);
    INSERT INTO notifications (user_id, title, message, type, link) VALUES (
      auth.uid(), 'Offer not accepted',
      -- UNIFORM copy: never hint how far below the floor it was, or the floor is guessable.
      'Your offer wasn''t accepted. You can book at the listed price any time.',
      'info', '/providers/' || p_provider_id);
    SELECT * INTO o FROM offers WHERE id = o.id;
    RETURN o;
  END IF;

  INSERT INTO notifications (user_id, title, message, type, link) VALUES (
    sp.user_id, 'New offer',
    'A customer offered ₹' || trim_scale(p_amount) || '. Accept, counter or decline within 24 hours.',
    'info', '/bookings/' || b.id);
  RETURN o;
END; $$;
GRANT EXECUTE ON FUNCTION public.start_negotiation(uuid,numeric,text,date,time,numeric,text,text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- (b) Undo the Step-10 seed where it put a per-hour number in a job-total column.
--     Fixed-price providers only, and only rows still carrying the untouched seed value.
UPDATE service_providers
   SET list_price = NULL
 WHERE pricing_mode = 'fixed'
   AND list_price IS NOT NULL
   AND list_price = hourly_rate;

-- ─────────────────────────────────────────────────────────────────────────────
-- (c) Write the unit down.
COMMENT ON COLUMN service_providers.list_price IS
  'Provider''s asking price for one standard job (a JOB TOTAL, not per hour) — the same figure the '
  '"Book at ₹X" button shows. Same unit as floor_price, auto_accept_threshold and offers.amount.';
COMMENT ON COLUMN service_providers.floor_price IS
  'Private reservation price for one standard job (a JOB TOTAL). Never granted to any client and '
  'never returned by an RPC; an offer below it is declined in uniform language.';
COMMENT ON COLUMN service_providers.auto_accept_threshold IS
  'Offer at or above this is accepted instantly (a JOB TOTAL). Must be >= floor_price.';
