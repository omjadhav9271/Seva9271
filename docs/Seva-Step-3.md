# Seva — Playbook Step 3: Per-Booking Chat (Realtime)

> Step 3 of `/docs/Seva-Claude-Code-Playbook.md` (architecture §4, Message entity). Read `CLAUDE.md` first. Do this **after** Step 2 is committed. This is a lighter step — but it starts your **on-platform evidence trail** (the chat thread is what disputes in Step 8 and reputation later lean on).

---

## Where you are (grounded in the current repo)

- **No `messages` table** exists. Chat is greenfield.
- **No booking detail route** — `app/bookings/` contains only `page.tsx` (the list with an expandable panel). Chat has nowhere to live yet.
- The Supabase client (`lib/supabase.ts`) is a plain `createClient`; **Realtime is available but unused** (the only `subscribe` in the app is the auth-state listener).
- `booking_events` (Step 2) already established the pattern: only the two booking parties can read a booking's sub-rows. Chat uses the same rule.

## What this step adds (3 things)

1. A **`messages`** table (one thread per booking), append-only, readable/writable only by the two booking parties.
2. **Realtime** delivery so a message appears on the other side with no reload.
3. A **`/bookings/[id]` detail page** hosting the booking summary + the chat thread (this becomes the home for disputes and tracking later too).

---

## The migration (source of truth)

`supabase/migrations/20260712120000_seva_booking_chat.sql` — run after the Step 2 migration:

```sql
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
```

Because the SELECT policy uses `is_booking_party`, Realtime only pushes a message to the two parties — RLS gates the live stream, not just the initial fetch.

---

## App wiring (what Claude Code changes in code)

**New page `app/bookings/[id]/page.tsx`** — fetch the one booking by id (RLS returns it only to a party; if null, render "Booking not found"). Show a summary (status badge, the other party's name, schedule, agreed/charged price) and render `<BookingChat bookingId={id} />`. The per-booking action buttons can move here later, but for Step 3 the list keeps them; this page just adds chat.

**New component `components/booking-chat.tsx`** (client):
- On mount, fetch existing messages: `select('*').eq('booking_id', id).order('created_at')`.
- Subscribe to live inserts, and clean up on unmount:
  ```ts
  const channel = supabase
    .channel(`messages:${bookingId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `booking_id=eq.${bookingId}` },
      (payload) => setMessages((m) => (m.some(x => x.id === payload.new.id) ? m : [...m, payload.new]))
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
  ```
- Composer: an input + Send that inserts `{ booking_id, sender_id: user.id, body }`. Don't hand-append on send — let the realtime echo add it (the dedupe guard above prevents doubles). Align own messages right, the other party's left.

**Link the list to it** (`app/bookings/page.tsx`): each booking row (or a "View / Chat" button) links to `/bookings/[id]`.

**Types** (`lib/supabase.ts`): add a `Message` type.

---

## Gotchas / decisions baked in

- **`is_booking_party` is SECURITY DEFINER on purpose.** A plain policy that reads `bookings` from inside a `bookings`-adjacent policy risks RLS recursion/permission issues; a definer helper sidesteps that and only ever returns a boolean about the current user, so there's no leak. (You can later reuse it to simplify the Step-2 `booking_events` policy — optional.)
- **Messages are immutable.** No update/delete path — deliberately, so the thread is trustworthy evidence in a dispute. Don't add an edit feature.
- **Realtime needs the table in the `supabase_realtime` publication** — the migration adds it. Realtime is enabled by default on Supabase projects; no dashboard toggle needed.
- **Keep it text-only.** No attachments/images this step (that's a later addition), and **no contact-exchange detection** — that's a Step-13 fraud signal, not now.
- Messaging is allowed as long as the booking exists; not gating by status keeps it simple and preserves the evidence trail.

---

## Definition of done

- The two parties on a booking exchange messages, and a new message appears on the **other** side **without a reload** (Realtime).
- A third user cannot read the thread and cannot post to it (RLS: the detail page shows "not found"; a direct select returns 0 rows; a direct insert is denied).
- Messages cannot be edited or deleted from the client.
- `npm run typecheck` and `npm run build` pass.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read /docs/Seva-Architecture.md (§4, Message entity) and CLAUDE.md first.
We are on Playbook Step 3: Per-booking chat (Realtime). Step 2 is committed.

Read these files first, then propose a short plan and WAIT for my OK before editing:
- CLAUDE.md and /docs/Seva-Step-3.md (this spec — the source of truth)
- supabase/migrations/20260711120000_seva_booking_state_machine.sql (party-check pattern used
  by booking_events RLS; mirror it for messages)
- app/bookings/page.tsx (the list — you'll link rows to the new detail page)
- lib/supabase.ts (client + types) and lib/auth-context.tsx (current user)

Build:
1. Add migration supabase/migrations/20260712120000_seva_booking_chat.sql exactly as in
   /docs/Seva-Step-3.md: the is_booking_party(uuid) SECURITY DEFINER helper; the messages
   table; SELECT + INSERT RLS via is_booking_party; REVOKE UPDATE/DELETE; and the guarded
   ALTER PUBLICATION supabase_realtime ADD TABLE messages.
2. Add components/booking-chat.tsx: fetch existing messages, subscribe to realtime INSERTs
   filtered by booking_id (clean up the channel on unmount, dedupe by id), and a composer that
   inserts { booking_id, sender_id: user.id, body }. Own messages right-aligned.
3. Add app/bookings/[id]/page.tsx: fetch the booking by id (render "not found" if RLS returns
   null), show a summary + <BookingChat/>. Link each booking in app/bookings/page.tsx to it.
4. Add a Message type to lib/supabase.ts.

Do NOT touch (later steps):
- The transition RPC / booking state machine (Step 2 — leave it as is)
- Attachments/images, or contact-exchange detection (Step 13)
- Notifications delivery (Step 4), payments (Step 5), reviews/reputation (Steps 6/7)

Done when:
- Two parties exchange messages and a new message shows on the other side with NO reload.
- A third user can't read or post (detail page "not found"; direct select 0 rows; insert denied).
- Messages can't be edited or deleted from the client.
- npm run typecheck and npm run build pass.

I'll apply the migration myself via supabase db push. After I confirm it's applied, add
scripts/verify-step3.mjs: as customer and provider, post messages both ways and assert each
reads the other's; assert a non-party gets 0 rows on select and is denied on insert; assert
update and delete are denied.

Finish by reporting exactly what you changed (files + migration) and how you verified each
"Done when" item.
```
