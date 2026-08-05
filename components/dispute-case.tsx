'use client';

/* The dispute card on /bookings/[id], for whichever party is looking at it.

   It used to say "Raised by the customer" and nothing else — which left the accused party with no
   idea WHO was complaining, about WHICH of their bookings, or WHAT the complaint actually said.
   You cannot attach the right evidence to a case you can't identify. So this card answers, in
   order: who raised it, against whom, about which booking, and in their own words what went
   wrong. The same card carries the outcome and the settlement once it's resolved. */

import { AlertTriangle, Scale, Calendar, Wrench, IndianRupee, Tag } from 'lucide-react';
import type { Dispute } from '@/lib/supabase';
import { OUTCOME_TEXT, partyLabel, partyReasonLabel, shortId, type PartyRole } from '@/lib/disputes';
import DisputeSettlement from '@/components/dispute-settlement';

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function Fact({ icon: Icon, label, value }: {
  icon: typeof Calendar; label: string; value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-3.5 h-3.5 text-gray-500 flex-shrink-0 mt-0.5" />
      <div className="min-w-0">
        <span className="text-[11px] text-gray-500">{label}</span>
        <p className="text-xs text-gray-200 break-words">{value}</p>
      </div>
    </div>
  );
}

export default function DisputeCase({
  dispute, viewerRole, viewerId, customerName, providerName,
  categoryName, bookingId, scheduledLabel, workSummary, amount, priceLabel,
}: {
  dispute: Dispute;
  viewerRole: PartyRole | null;
  viewerId: string | null;
  customerName: string | null;
  providerName: string | null;
  categoryName: string;
  bookingId: string;
  scheduledLabel: string;
  workSummary: string | null;
  amount: number;
  priceLabel: string;
}) {
  const resolved = dispute.status === 'resolved';
  const raiserRole: PartyRole = dispute.raiser_role;
  const otherRole: PartyRole = raiserRole === 'customer' ? 'provider' : 'customer';
  const nameOf = (r: PartyRole) => (r === 'customer' ? customerName : providerName);

  const iRaisedIt = viewerId != null && dispute.raised_by === viewerId;
  const raisedBy = iRaisedIt ? `you (${raiserRole})` : partyLabel(nameOf(raiserRole), raiserRole);
  const against = viewerRole === otherRole ? `you (${otherRole})` : partyLabel(nameOf(otherRole), otherRole);

  return (
    <div className={`rounded-2xl border p-4 mb-6 ${
      resolved ? 'border-[#2a2a2a] bg-[#161616]' : 'border-orange-700/40 bg-orange-900/15'
    }`}>
      <div className="flex items-start gap-3">
        {resolved
          ? <Scale className="w-5 h-5 text-[#5da9ff] flex-shrink-0 mt-0.5" />
          : <AlertTriangle className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5" />}
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${resolved ? 'text-white' : 'text-orange-300'}`}>
            {resolved
              ? `Dispute resolved${dispute.outcome ? ` — ${OUTCOME_TEXT[dispute.outcome]}` : '.'}`
              : `Dispute ${dispute.status === 'open' ? 'open' : 'under review'} — ${partyReasonLabel(dispute.reason, raiserRole)}`}
          </p>

          {/* WHO raised it, and against WHOM — the two facts the old banner never gave. */}
          <p className="text-xs text-gray-400 mt-1">
            Raised by {raisedBy} <span className="text-gray-600 font-mono">{shortId(dispute.raised_by)}</span>
            {' · '}against {against}
            {' · '}{fmtDate(dispute.created_at)}
            {resolved && <> · about {partyReasonLabel(dispute.reason, raiserRole)}</>}
          </p>

          {/* WHICH booking — so evidence goes to the right case. */}
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-2 mt-3 rounded-xl bg-black/25 p-3">
            <Fact icon={Tag} label="Service" value={`${categoryName} · booking ${shortId(bookingId)}`} />
            <Fact icon={Calendar} label="Scheduled" value={scheduledLabel || 'Not scheduled'} />
            <Fact icon={IndianRupee} label={priceLabel} value={`₹${Number(amount).toLocaleString('en-IN')}`} />
            <Fact icon={Wrench} label="Work booked" value={workSummary?.trim() || 'No work note was added to this booking.'} />
          </div>

          {/* WHAT was reported, in the raiser's own words. */}
          <div className="mt-3">
            <p className="text-[11px] text-gray-500 mb-1">
              {iRaisedIt ? 'What you reported' : `What the ${raiserRole} reported`}
            </p>
            {dispute.description?.trim() ? (
              <p className="text-xs text-gray-200 bg-black/25 rounded-xl p-3 whitespace-pre-wrap">
                &ldquo;{dispute.description.trim()}&rdquo;
              </p>
            ) : (
              <p className="text-xs text-gray-500 italic">
                No description was added — the reason above is all that was filed.
              </p>
            )}
          </div>

          {resolved ? (
            <>
              {dispute.fault_party && dispute.fault_party !== 'none' && (
                <p className="text-xs text-gray-400 mt-3">
                  Our team found {dispute.fault_party === viewerRole ? 'you' : `the ${dispute.fault_party}`} at
                  fault. Only the party at fault carries this on their trust score.
                </p>
              )}
              {dispute.resolution_notes && (
                <div className="mt-3">
                  <p className="text-[11px] text-gray-500 mb-1">Our team&apos;s decision</p>
                  <p className="text-xs text-gray-300 bg-black/25 rounded-xl p-3 whitespace-pre-wrap">
                    {dispute.resolution_notes}
                  </p>
                </div>
              )}
              <DisputeSettlement dispute={dispute} amountFallback={amount} viewerRole={viewerRole} />
            </>
          ) : (
            <p className="text-xs text-gray-400 mt-3">
              Our team is reviewing the reason and message above, the evidence each side attaches,
              this booking&apos;s timeline, your chat and the payments on it. Funds stay protected
              until it&apos;s resolved — nothing is paid out or refunded before then.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
