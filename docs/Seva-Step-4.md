# Seva — Playbook Step 4: Notifications Wiring

> Step 4 of `/docs/Seva-Claude-Code-Playbook.md` (architecture §2, Notifications module). Read `CLAUDE.md` first. Do this **after** Step 3 is committed. This closes **Phase 1**: after it, a real booking flows request → chat → status changes → completion, with both sides notified throughout.

---

## Where you are (grounded in the current repo)

- **`notifications` table already exists**: `id, user_id, title, message, type ('info'|'success'|'warning'|'error'), is_read, created_at`. So no new table — just wiring.
- The **navbar already has a bell + dropdown** (`components/navbar.tsx`) — but it renders a hardcoded `mockNotifications` array. It needs to read the real table.
- Steps 2–3 already write to **`booking_events`** (every transition) and **`messages`** (every chat message). Those are the events worth notifying on — so Step 4 hangs **triggers** off them rather than editing the verified `transition_booking` RPC.
- Current notifications RLS lets a client `insert_own_notification`. We'll drop that — notifications should be **system-generated only**, so the bell can be trusted.

## What this step adds (4 things)

1. Three DB triggers that create notification rows: **new booking → provider**, **status transition → the other party**, **new message → the recipient**.
2. Rewire the navbar bell to the **real** notifications table, with **realtime** so new ones appear without reload, plus mark-as-read.
3. Lock notifications to **system-generated** (drop client insert).
4. A thin **`notify()` interface** (`lib/notify.ts`) as the seam for SMS/WhatsApp/push later — a no-op/console adapter for now.

---

## The migration (source of truth)

`supabase/migrations/20260713120000_seva_notifications.sql` — run after the Step 3 migration. It's **purely additive** — it does not touch `transition_booking` or the chat tables.

```sql
/* Seva — Step 4: notifications wiring. Run AFTER the Step 3 migration. */

-- Notifications are system-generated only → drop client insert so the bell can be trusted.
-- (select/update/delete on OWN notifications remain: read, mark-read, dismiss.)
DROP POLICY IF EXISTS "insert_own_notification" ON notifications;

-- 1) New booking request → notify the provider.
CREATE OR REPLACE FUNCTION public.notify_on_new_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider_user uuid;
BEGIN
  SELECT sp.user_id INTO v_provider_user FROM service_providers sp WHERE sp.id = NEW.provider_id;
  IF v_provider_user IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (v_provider_user, 'New booking request',
            'You have a new booking request. Open Bookings to accept.', 'info');
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_notify_new_booking ON bookings;
CREATE TRIGGER trg_notify_new_booking AFTER INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION public.notify_on_new_booking();

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
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (v_recipient, v_title, 'Booking status is now "' || NEW.to_status || '".', v_type);
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_notify_booking_event ON booking_events;
CREATE TRIGGER trg_notify_booking_event AFTER INSERT ON booking_events
FOR EACH ROW EXECUTE FUNCTION public.notify_on_booking_event();

-- 3) New message → notify the recipient (the party who isn't the sender).
CREATE OR REPLACE FUNCTION public.notify_on_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_customer uuid; v_provider_user uuid; v_recipient uuid;
BEGIN
  SELECT b.customer_id, sp.user_id INTO v_customer, v_provider_user
  FROM bookings b JOIN service_providers sp ON sp.id = b.provider_id
  WHERE b.id = NEW.booking_id;
  v_recipient := CASE WHEN NEW.sender_id = v_customer THEN v_provider_user ELSE v_customer END;
  IF v_recipient IS NOT NULL AND v_recipient <> NEW.sender_id THEN
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (v_recipient, 'New message', 'You have a new message about a booking.', 'info');
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_notify_message ON messages;
CREATE TRIGGER trg_notify_message AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION public.notify_on_message();

-- 4) Realtime for the bell (guarded so re-runs don't error).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
  END IF;
END $$;
```

Triggers are SECURITY DEFINER so they can insert a notification **for the other user** (which the RLS policies don't allow a normal client to do) — that's exactly why notifications stay trustworthy: only the server writes them.

---

## App wiring (what Claude Code changes in code)

**`components/navbar.tsx`** — replace `mockNotifications`:
- Fetch the signed-in user's notifications: `select('*').eq('user_id', me).order('created_at', { descending }).limit(20)`.
- Badge = count of `is_read = false`.
- **Realtime**: subscribe to inserts for this user and prepend live —
  ```ts
  const ch = supabase.channel(`notifications:${user.id}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
      (p) => setNotifications((n) => [p.new, ...n]))
    .subscribe();
  return () => { supabase.removeChannel(ch); };
  ```
- Opening the dropdown (or a "Mark all read" button) sets `is_read = true` for the user's unread rows and clears the badge.
- Colour each item by `type` (info/success/warning/error).

**`lib/supabase.ts`** — add a `Notification` type.

**`lib/notify.ts`** (new, thin) — the outbound seam:
```ts
// Outbound delivery channels (SMS/WhatsApp/push). No-op for now; real adapters land in Phase 4.
export type OutboundMessage = { userId: string; title: string; body: string };
export interface NotificationChannel { send(m: OutboundMessage): Promise<void>; }
export const consoleChannel: NotificationChannel = {
  async send(m) { console.log('[notify:noop]', m.userId, m.title); },
};
export async function notify(m: OutboundMessage) { await consoleChannel.send(m); }
```
This isn't wired to the DB triggers yet — in-app notifications are the DB rows; `notify()` is the placeholder for phone/push. Phase 4 connects them (a Supabase Edge Function on notification insert, or a DB webhook).

Optional: a `/notifications` full-list page behind the dropdown's "View All" link — nice-to-have, not required this step.

---

## Gotchas / decisions baked in

- **Triggers, not an RPC edit.** The Step-2 `transition_booking` is verified green — Step 4 leaves it untouched and reacts to the `booking_events` row it already writes. Lower risk, same result.
- **Notifications are system-generated.** Dropping `insert_own_notification` means a client can't fabricate a notification (for itself or anyone). The bell only shows things the server created.
- **Realtime is RLS-gated** (like Step 3): the bell subscription filters by `user_id`, and the SELECT policy ensures a user only ever receives their own notifications.
- **No real SMS/WhatsApp yet** — that's Phase 4. `notify()` exists only so that wiring has a defined seam and the rest of the app never calls a provider SDK directly.
- Keep messages notifications simple (one per message). Batching/muting is a later refinement, not now.

---

## Definition of done

- Creating a booking inserts a "New booking request" notification for the **provider**.
- Each status transition inserts a notification for the **other** party; each new chat message inserts one for the **recipient**.
- The navbar bell shows the signed-in user's **real** unread count + list, updates **live** (a new notification appears with no reload), and marking read clears the badge.
- A direct client insert into `notifications` (for self or another user) is **denied**.
- `npm run typecheck` and `npm run build` pass.

---

## Copy-paste prompt for Claude Code

```
Context: Seva. Read /docs/Seva-Architecture.md (§2) and CLAUDE.md first.
We are on Playbook Step 4: Notifications wiring. Step 3 is committed.

Read these files first, then propose a short plan and WAIT for my OK before editing:
- CLAUDE.md and /docs/Seva-Step-4.md (this spec — the source of truth)
- supabase/migrations/20260622131542_seva_initial_schema.sql (notifications table + its RLS)
- supabase/migrations/20260711120000_seva_booking_state_machine.sql (booking_events shape)
- components/navbar.tsx (the bell + mockNotifications to replace)
- lib/supabase.ts (client + types) and lib/auth-context.tsx (current user)

Build:
1. Add migration supabase/migrations/20260713120000_seva_notifications.sql exactly as in
   /docs/Seva-Step-4.md: drop insert_own_notification; the three SECURITY DEFINER trigger
   functions + triggers (new booking → provider; booking_events → other party; message →
   recipient); and the guarded ALTER PUBLICATION supabase_realtime ADD TABLE notifications.
   Do NOT modify transition_booking or the messages/chat tables.
2. Rewire components/navbar.tsx to read the real notifications table for the signed-in user:
   unread badge, list coloured by type, realtime subscription (filter user_id=eq.me, cleanup
   on unmount), and mark-all-read on open.
3. Add a Notification type to lib/supabase.ts and a thin lib/notify.ts outbound seam
   (console no-op adapter) exactly as in the spec.

Do NOT touch (later steps):
- transition_booking / the state machine (Step 2), or the chat tables (Step 3)
- Real SMS/WhatsApp/push integration — notify() stays a no-op stub (Phase 4)
- Payments (Step 5), reviews/reputation (Steps 6/7)

Done when:
- Creating a booking notifies the provider; each transition notifies the other party; each
  message notifies the recipient.
- The bell shows the user's real unread count + list, updates live with no reload, and
  mark-read clears the badge.
- A direct client insert into notifications is denied.
- npm run typecheck and npm run build pass.

I'll apply the migration myself via supabase db push. After I confirm it's applied, add
scripts/verify-step4.mjs: as customer + provider, create a booking and assert the provider
got a notification; transition it and assert the other party got one; send a message and
assert the recipient got one; assert a direct client insert into notifications is denied.

Finish by reporting exactly what you changed (files + migration) and how you verified each
"Done when" item.
```
