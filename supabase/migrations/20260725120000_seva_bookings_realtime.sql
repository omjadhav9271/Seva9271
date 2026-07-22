/* Seva — Step 6 follow-up: live booking updates. Run AFTER 20260724120000.

   Until now `bookings` was intentionally left out of the realtime publication, so the booking
   detail page only refreshed the party who triggered a transition. That left the OTHER party
   stale: when the customer confirms → the booking settles (status='paid'), the provider's open
   page never learned it, so the review section (gated on `settled`) didn't appear until a manual
   refresh. Add `bookings` to the publication so the detail page can reflect status/payment
   changes — and reveal the review form — live for both sides. RLS still gates the stream: only
   the two booking parties receive a given row (select_own_bookings). */

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bookings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE bookings;
  END IF;
END $$;
