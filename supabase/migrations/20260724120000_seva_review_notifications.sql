/* Seva — Step 6 follow-up: live review reveal + review notifications. Run AFTER 20260723120000.

   Two additions, both leaning on machinery that already exists:
   1) Add `reviews` to the supabase_realtime publication so the booking page can reveal the
      counterpart's review live (RLS still gates the stream — you only receive rows you may SELECT,
      i.e. your own or a revealed counterpart). Mirrors messages/notifications.
   2) A notify trigger on reviews INSERT that tells the OTHER party, with EXPLICIT recipients and
      WITHOUT leaking the rating/comment (the notification only links to the booking; the content
      lives behind RLS). Modeled on notify_on_message — submit_review stays untouched. */

-- 1) Live updates for the reveal (guarded so re-runs don't error).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'reviews'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE reviews;
  END IF;
END $$;

-- 2) Review notifications → the counterpart (and, on reveal, the reviewer too). No content leaks.
CREATE OR REPLACE FUNCTION public.notify_on_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_provider_user uuid; v_counterpart uuid; v_reveals boolean;
  v_link text := '/bookings/' || NEW.booking_id;
BEGIN
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = NEW.provider_id;

  -- The party who did NOT write this review (the recipient of the "you were reviewed" nudge).
  IF NEW.direction = 'customer_to_provider' THEN v_counterpart := v_provider_user;
  ELSE                                            v_counterpart := NEW.customer_id;
  END IF;

  -- Does the opposite-direction review already exist? Then this submission reveals BOTH.
  v_reveals := EXISTS (SELECT 1 FROM reviews r2
                       WHERE r2.booking_id = NEW.booking_id AND r2.direction <> NEW.direction);

  IF v_reveals THEN
    -- Reveal: the counterpart (who rated first, has been waiting) can now see this review, and the
    -- reviewer can now see the counterpart's. Two explicit, content-free notifications.
    IF v_counterpart IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, type, link)
      VALUES (v_counterpart, 'You received a review',
              'Both reviews are now visible on your booking.', 'success', v_link);
    END IF;
    IF NEW.reviewer_id IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, type, link)
      VALUES (NEW.reviewer_id, 'Reviews revealed',
              'Both reviews are now visible on your booking.', 'success', v_link);
    END IF;
  ELSE
    -- First review: it stays hidden until the counterpart reciprocates. Nudge them to rate.
    IF v_counterpart IS NOT NULL THEN
      INSERT INTO notifications (user_id, title, message, type, link)
      VALUES (v_counterpart, 'The other party left a review',
              'Rate them to reveal both reviews.', 'info', v_link);
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_review ON reviews;
CREATE TRIGGER trg_notify_review AFTER INSERT ON reviews
FOR EACH ROW EXECUTE FUNCTION public.notify_on_review();
