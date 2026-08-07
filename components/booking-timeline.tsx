'use client';

/* Bucket C (20) — what actually happened to this booking, in order.
   Every transition already writes a booking_events row (the state machine's audit trail, written
   only by transition_booking and the settlement triggers); until now nothing showed it to the two
   people it concerns. RLS scopes the table to the customer and the provider, so this is a plain
   read — DISPLAY ONLY. It computes nothing, and it is deliberately not the source of the status
   badge: the booking row is. */

import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { statusConfig, type BookingStatus } from '@/lib/bookings';

type EventRow = {
  id: string;
  from_status: string | null;
  to_status: string;
  actor_role: 'customer' | 'provider' | 'system' | 'admin' | null;
  meta: Record<string, unknown> | null;
  created_at: string;
};

const WHO: Record<string, string> = {
  customer: 'by the customer',
  provider: 'by the provider',
  system:   'automatically',
  admin:    'by Seva support',
};

// A settlement event carries the split it performed; showing it here is what turns "Paid" from an
// assertion into something the provider can check.
function detail(e: EventRow): string | null {
  const m = e.meta ?? {};
  if (typeof m.payout === 'number' || typeof m.payout === 'string') {
    const fee = m.fee != null ? ` · ₹${Number(m.fee).toLocaleString('en-IN')} platform fee` : '';
    return `₹${Number(m.payout).toLocaleString('en-IN')} released to the provider${fee}`;
  }
  if (m.cash === true) return 'Settled in cash';
  if (typeof m.offer === 'number') return `Offer of ₹${Number(m.offer).toLocaleString('en-IN')}`;
  if (typeof m.reason === 'string') return m.reason;
  return null;
}

// `refreshKey` is bumped by the page whenever the booking itself is refetched — on a transition,
// on settlement, and on the realtime UPDATE that fires when the OTHER party moves the job.
// booking_events is not in the realtime publication, so without this the timeline was a snapshot
// taken at mount: confirming a job settled it, credited the wallet and wrote two events that
// only appeared after a manual reload.
export default function BookingTimeline({ bookingId, refreshKey = 0 }: {
  bookingId: string;
  refreshKey?: number;
}) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase
        .from('booking_events')
        .select('id, from_status, to_status, actor_role, meta, created_at')
        .eq('booking_id', bookingId)
        .order('created_at', { ascending: true });
      if (!active) return;
      if (error) console.error('Failed to load booking timeline:', error.message);
      setEvents((data ?? []) as EventRow[]);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [bookingId, refreshKey]);

  if (loading || events.length === 0) return null;

  return (
    <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 mb-6">
      <h2 className="font-bold text-white mb-4 flex items-center gap-2">
        <History className="w-4 h-4 text-[#FF9933]" /> Timeline
      </h2>
      <ol className="space-y-0">
        {events.map((e, i) => {
          const cfg = statusConfig[e.to_status as BookingStatus];
          const Icon = cfg?.icon;
          const note = detail(e);
          const last = i === events.length - 1;
          return (
            <li key={e.id} className="flex gap-3">
              {/* rail */}
              <div className="flex flex-col items-center flex-shrink-0">
                <span className={`w-7 h-7 rounded-full border flex items-center justify-center ${cfg?.bg ?? 'bg-gray-800/40 border-gray-700/40'}`}>
                  {Icon ? <Icon className={`w-3.5 h-3.5 ${cfg.color}`} /> : <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />}
                </span>
                {!last && <span className="w-px flex-1 bg-[#2a2a2a] my-1" />}
              </div>
              <div className={last ? 'pb-0' : 'pb-4'}>
                <p className="text-sm text-white">
                  {cfg?.label ?? e.to_status}
                  {e.actor_role && <span className="text-gray-500 font-normal"> {WHO[e.actor_role] ?? ''}</span>}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {new Date(e.created_at).toLocaleString('en-IN', {
                    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
                  })}
                </p>
                {note && <p className="text-xs text-gray-400 mt-1">{note}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
