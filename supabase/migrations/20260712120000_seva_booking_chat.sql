/* Seva — Step 3: per-booking chat. Run AFTER the Step 2 migration. */

-- Reusable predicate: is the current user a party (customer or assigned provider) to a booking?
-- SECURITY DEFINER so it answers without tripping RLS recursion; returns only a boolean,
-- so it can never leak row data.
CREATE OR REPLACE FUNCTION public.is_booking_party(p_booking_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.id = p_booking_id
      AND (b.customer_id = auth.uid()
           OR auth.uid() IN (SELECT user_id FROM service_providers WHERE id = b.provider_id))
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_booking_party(uuid) TO authenticated;

-- Messages: one thread per booking, append-only (trustworthy evidence for disputes/reputation).
CREATE TABLE IF NOT EXISTS messages (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE NOT NULL,
  sender_id  UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_booking ON messages(booking_id, created_at);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_booking_messages" ON messages;
CREATE POLICY "select_booking_messages" ON messages FOR SELECT TO authenticated
USING (public.is_booking_party(booking_id));

DROP POLICY IF EXISTS "insert_booking_messages" ON messages;
CREATE POLICY "insert_booking_messages" ON messages FOR INSERT TO authenticated
WITH CHECK (sender_id = auth.uid() AND public.is_booking_party(booking_id));

-- Immutable: no edits/deletes, so the thread stays trustworthy as evidence.
REVOKE UPDATE, DELETE ON messages FROM authenticated, anon;

-- Live updates: add to the realtime publication (guarded so re-runs don't error).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  END IF;
END $$;
