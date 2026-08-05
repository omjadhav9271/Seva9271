'use client';

/* The settlement summary a party lands on from the "Dispute resolved" notification.

   A resolution used to be one sentence — "Resolved in the provider's favour" — and the money was
   left to be inferred from a wallet balance. Both sides need to see the arithmetic: what was
   charged, what the platform kept, what the provider got, and what the resolution then moved.
   Every line is read back from the server's own rows (lib/disputes.fetchSettlement); nothing here
   recomputes a fee or predicts an outcome. */

import { useEffect, useState } from 'react';
import { Receipt, ArrowRight } from 'lucide-react';
import type { Dispute } from '@/lib/supabase';
import { fetchSettlement, inr, type PartyRole, type Settlement } from '@/lib/disputes';

function Line({ label, value, tone = 'plain', hint }: {
  label: string;
  value: string;
  tone?: 'plain' | 'muted' | 'credit' | 'debit' | 'total';
  hint?: string;
}) {
  const valueClass =
    tone === 'credit' ? 'text-[#22c55e] font-semibold'
      : tone === 'debit' ? 'text-orange-400 font-semibold'
        : tone === 'total' ? 'text-white font-bold'
          : tone === 'muted' ? 'text-gray-500'
            : 'text-gray-200';
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={`text-xs ${tone === 'total' ? 'text-gray-300 font-medium' : 'text-gray-400'}`}>
        {label}
        {hint && <span className="block text-[11px] text-gray-600">{hint}</span>}
      </span>
      <span className={`text-sm tabular-nums flex-shrink-0 ${valueClass}`}>{value}</span>
    </div>
  );
}

export default function DisputeSettlement({
  dispute, amountFallback, viewerRole,
}: {
  dispute: Dispute;
  amountFallback: number;
  viewerRole: PartyRole | null;
}) {
  const [s, setS] = useState<Settlement | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const res = await fetchSettlement(dispute, amountFallback);
      if (active) setS(res);
    })();
    return () => { active = false; };
  }, [dispute, amountFallback]);

  if (!s) {
    return <p className="text-xs text-gray-500 mt-4">Loading the settlement…</p>;
  }

  const isCustomer = viewerRole === 'customer';
  const isProvider = viewerRole === 'provider';

  return (
    <div className="mt-4 rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
      <div className="flex items-center gap-2 mb-1">
        <Receipt className="w-4 h-4 text-[#5da9ff]" />
        <h3 className="text-sm font-bold text-white">Settlement summary</h3>
      </div>
      <p className="text-[11px] text-gray-500 mb-3">
        Exactly where the money for this booking ended up after the resolution.
      </p>

      {!s.hasGatewayPayment ? (
        <p className="text-xs text-gray-400">
          No online payment was captured on this booking, so the resolution moved no money through
          Seva. The booking was worth {inr(s.customerPaid)}.
        </p>
      ) : (
        <>
          <p className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">Before the resolution</p>
          <Line label={isCustomer ? 'You paid' : 'The customer paid'} value={inr(s.customerPaid)} />
          <Line label="Platform fee" value={inr(s.platformFee)} tone="muted" hint="Seva's share of the job" />
          <Line
            label={isProvider ? 'Paid into your wallet' : 'The provider received'}
            value={inr(s.providerCredited)}
            tone={s.providerCredited > 0 ? 'credit' : 'muted'}
            hint={s.providerCredited > 0 ? 'escrow payout' : 'escrow was never released'}
          />

          <div className="border-t border-[#222] mt-2 pt-2">
            <p className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">What the resolution moved</p>
            <Line
              label={isCustomer ? 'Refunded to you' : 'Refunded to the customer'}
              value={s.refundToCustomer > 0 ? inr(s.refundToCustomer) : '—'}
              tone={s.refundToCustomer > 0 ? 'credit' : 'muted'}
              hint={s.refundToCustomer > 0 ? 'back to the original payment method' : 'no refund was ordered'}
            />
            {s.clawback > 0 && (
              <Line
                label={isProvider ? 'Clawed back from your wallet' : "Recovered from the provider's wallet"}
                value={inr(-s.clawback)}
                tone="debit"
                hint="the escrow had already been paid out, so the refund was recovered"
              />
            )}
          </div>

          <div className="border-t border-[#222] mt-2 pt-2">
            <p className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">Where it ended up</p>
            <Line
              label={isCustomer ? 'This booking finally cost you' : 'The customer finally paid'}
              value={inr(s.customerNet)}
              tone="total"
            />
            <Line
              label={isProvider ? 'You keep' : 'The provider keeps'}
              value={inr(s.providerNet)}
              tone="total"
            />
          </div>

          {s.providerNet < 0 && (
            <p className="text-[11px] text-amber-400/80 mt-2">
              {isProvider ? 'Your' : 'The provider’s'} wallet was debited more than the payout it
              had received, because the platform fee had already been deducted. Our team will
              settle the difference.
            </p>
          )}
        </>
      )}

      <p className="text-[11px] text-gray-600 mt-3 flex items-center gap-1">
        <ArrowRight className="w-3 h-3 flex-shrink-0" />
        Refunds reach the original payment method within 5–7 working days.
      </p>
    </div>
  );
}
