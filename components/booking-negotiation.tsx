'use client';

/* The negotiation panel on a booking under offer. Structured buttons only — accept, counter,
   decline — because free-text price talk is the channel where deals leak off-platform (§7.3),
   and because a button trail is what makes the agreed price auditable.

   The provider's floor never appears here. A declined offer says only that it wasn't accepted. */

import { useState, useEffect, useCallback } from 'react';
import { Handshake, ArrowRight, Clock, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { fetchOffers, respondToOffer, whoseTurn, hoursLeft } from '@/lib/bargaining';
import type { Offer } from '@/lib/supabase';
import { toast } from 'sonner';

export default function BookingNegotiation({
  bookingId, role, onSettled,
}: {
  bookingId: string;
  role: 'customer' | 'provider';
  onSettled: () => void;
}) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [counter, setCounter] = useState('');
  const [showCounter, setShowCounter] = useState(false);

  const load = useCallback(async () => {
    setOffers(await fetchOffers(bookingId));
    setLoading(false);
  }, [bookingId]);

  useEffect(() => { load(); }, [load]);

  const open = offers.find((o) => o.status === 'pending');
  const turn = whoseTurn(offers);
  const myTurn = turn === role;
  const maxRound = offers.reduce((m, o) => Math.max(m, o.round), 0);

  const act = async (action: 'accept' | 'counter' | 'decline', amount?: number) => {
    setBusy(action);
    const res = await respondToOffer(bookingId, action, amount);
    setBusy(null);
    if ('error' in res) { toast.error(res.error); return; }
    setShowCounter(false);
    setCounter('');
    await load();
    if (action === 'accept') toast.success('Price agreed. The booking is confirmed at that amount.');
    if (action === 'decline') toast.info('Offer declined.');
    if (action === 'counter') toast.success('Counter sent.');
    onSettled();
  };

  if (loading) {
    return <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 text-sm text-gray-400">Loading offers…</div>;
  }

  return (
    <div className="bg-[#161616] border border-[#FF9933]/30 rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <Handshake className="w-5 h-5 text-[#FF9933]" />
        <h3 className="font-bold text-white">Price under negotiation</h3>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        {turn === null
          ? 'This negotiation is closed.'
          : myTurn
            ? 'Your move — accept, counter or decline.'
            : `Waiting on the ${turn}.`}
        {open && ` · expires in ${hoursLeft(open.expires_at)}h`}
      </p>

      {/* round history */}
      <div className="space-y-2 mb-4">
        {offers.map((o) => (
          <div key={o.id}
            className={`flex items-center gap-3 rounded-xl px-4 py-2.5 border ${
              o.status === 'accepted' ? 'bg-[#138808]/10 border-[#138808]/30'
                : o.status === 'pending' ? 'bg-[#1e1e1e] border-[#FF9933]/30'
                : 'bg-[#1e1e1e] border-[#2a2a2a]'
            }`}>
            <span className="text-xs text-gray-500 w-14 flex-shrink-0">Round {o.round}</span>
            <span className="text-sm text-gray-300 flex-1">
              {o.actor_role === role ? 'You' : `The ${o.actor_role}`} offered{' '}
              <span className="font-bold text-white">₹{Number(o.amount).toLocaleString('en-IN')}</span>
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full capitalize flex-shrink-0 ${
              o.status === 'accepted' ? 'bg-[#138808]/15 text-[#138808]'
                : o.status === 'pending' ? 'bg-[#FF9933]/15 text-[#FF9933]'
                : 'bg-gray-800 text-gray-500'
            }`}>{o.status}</span>
          </div>
        ))}
      </div>

      {open && myTurn && (
        <>
          {!showCounter ? (
            <div className="flex flex-col sm:flex-row gap-2">
              <button onClick={() => act('accept')} disabled={busy !== null}
                className="flex-1 flex items-center justify-center gap-2 bg-[#138808] hover:bg-[#0f6b06] text-white rounded-xl py-3 font-semibold text-sm transition-colors disabled:opacity-60">
                {busy === 'accept' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                Accept ₹{Number(open.amount).toLocaleString('en-IN')}
              </button>
              <button onClick={() => setShowCounter(true)} disabled={busy !== null}
                className="flex-1 flex items-center justify-center gap-2 border border-[#2a2a2a] text-gray-300 hover:text-white rounded-xl py-3 font-semibold text-sm transition-colors disabled:opacity-60">
                <ArrowRight className="w-4 h-4" /> Counter
              </button>
              <button onClick={() => act('decline')} disabled={busy !== null}
                className="sm:w-28 flex items-center justify-center gap-2 border border-red-500/30 text-red-400 hover:bg-red-900/20 rounded-xl py-3 font-semibold text-sm transition-colors disabled:opacity-60">
                {busy === 'decline' ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                Decline
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <input type="number" inputMode="numeric" value={counter} autoFocus
                onChange={(e) => setCounter(e.target.value)}
                placeholder="Your counter (₹)"
                className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933]" />
              <div className="flex gap-2">
                <button onClick={() => act('counter', Number(counter))}
                  disabled={busy !== null || !Number(counter)}
                  className="saffron-btn flex-1 rounded-xl py-3 font-semibold text-sm disabled:opacity-40">
                  {busy === 'counter' ? 'Sending…' : 'Send counter'}
                </button>
                <button onClick={() => { setShowCounter(false); setCounter(''); }}
                  className="px-4 py-3 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
              </div>
              <p className="text-xs text-gray-600">
                Round {maxRound + 1}. Counters are limited — after that you can still accept or decline.
              </p>
            </div>
          )}
        </>
      )}

      {open && !myTurn && (
        <p className="flex items-center gap-2 text-xs text-gray-500">
          <Clock className="w-3.5 h-3.5" /> They have {hoursLeft(open.expires_at)}h to respond.
        </p>
      )}
    </div>
  );
}
