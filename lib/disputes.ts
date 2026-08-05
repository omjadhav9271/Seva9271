/* Shared dispute vocabulary + the settlement maths, for BOTH sides of the case: the parties on
   /bookings/[id] and the admin console. The labels used to live in two places (a curated list on
   the booking page, REASON_LABELS in lib/admin) and had already drifted; this is the one source
   of truth — lib/admin re-exports from here.

   Nothing in this file decides anything. resolve_dispute owns the money and compute_reputation
   owns the score; the settlement functions below only RESTATE, from rows both parties are allowed
   to read, what the server already did. */

import { supabase, type Dispute, type DisputeOutcome, type DisputeReason } from '@/lib/supabase';

export type PartyRole = 'customer' | 'provider';

// Short labels — queue rows, banners, headings.
export const REASON_LABELS: Record<DisputeReason, string> = {
  work_not_done: 'Work not done',
  poor_quality: 'Poor quality',
  overcharged: 'Overcharged',
  no_show: 'No-show',
  damage: 'Damage',
  payment_not_received: 'Payment not received',
  customer_behaviour: 'Customer behaviour',
  other: 'Other',
};

export const reasonLabel = (r: string): string =>
  REASON_LABELS[r as DisputeReason] ?? r.replace(/_/g, ' ');

// Role-appropriate reason lists for the "Report a problem" form. The DB CHECK accepts the union;
// this is UX curation — a customer is never offered "payment not received".
export const DISPUTE_REASONS: Record<PartyRole, { value: DisputeReason; label: string }[]> = {
  customer: [
    { value: 'work_not_done', label: 'Work was not done' },
    { value: 'poor_quality', label: 'Poor quality of work' },
    { value: 'overcharged', label: 'Overcharged / price issue' },
    { value: 'no_show', label: 'Provider did not show up' },
    { value: 'damage', label: 'Damage to property' },
    { value: 'other', label: 'Other' },
  ],
  provider: [
    { value: 'payment_not_received', label: 'Payment not received' },
    { value: 'customer_behaviour', label: 'Customer behaviour' },
    { value: 'no_show', label: 'Customer not available / no access' },
    { value: 'other', label: 'Other' },
  ],
};

// The label a PARTY sees for a reason — the long, plain-English form they picked from, chosen by
// the raiser's side ('no_show' means something different for each). Falls back to the short label.
export function partyReasonLabel(reason: string, raiserRole: PartyRole): string {
  return DISPUTE_REASONS[raiserRole]?.find((x) => x.value === reason)?.label ?? reasonLabel(reason);
}

// What the admin picks (drives money) …
export const OUTCOME_LABELS: Record<DisputeOutcome, string> = {
  favor_customer: 'Favour customer (full refund)',
  favor_provider: 'Favour provider (release escrow)',
  partial: 'Partial refund (split)',
  no_fault: 'No fault (release escrow)',
};

// … and what the parties read afterwards.
export const OUTCOME_TEXT: Record<DisputeOutcome, string> = {
  favor_customer: 'Resolved in the customer’s favour — refund issued.',
  favor_provider: 'Resolved in the provider’s favour.',
  partial: 'Resolved with a partial refund.',
  no_fault: 'Resolved — no fault found on either side.',
};

/* ── who is who ──────────────────────────────────────────────────────────────
   A dispute row carries raiser_role + raised_by (a uuid) and nothing else about the humans
   involved. Names come from public_profiles — the Step-1 hardening view that exposes only
   (id, full_name, avatar_url, city, state), so this adds no PII surface. */

export async function fetchNames(userIds: (string | null | undefined)[]): Promise<Record<string, string>> {
  const ids = Array.from(new Set(userIds.filter((x): x is string => Boolean(x))));
  if (ids.length === 0) return {};
  const { data } = await supabase.from('public_profiles').select('id, full_name').in('id', ids);
  return Object.fromEntries(
    ((data ?? []) as { id: string; full_name: string | null }[])
      .map((r) => [r.id, r.full_name?.trim() || '']),
  );
}

export const shortId = (id: string | null | undefined): string => (id ? `#${id.slice(0, 8)}` : '');

// "Raised by Ravi Kumar (customer)" — with a graceful fallback when a profile has no name.
export function partyLabel(name: string | null | undefined, role: PartyRole): string {
  const n = name?.trim();
  return n ? `${n} (${role})` : `the ${role}`;
}

/* ── the settlement ──────────────────────────────────────────────────────────
   Every number below is read back from rows the two parties can already SELECT — the payment
   ledger (select_own_payment_tx), the dispute row, and the booking's event log — never
   recomputed from a fee constant. Two facts do the work:

     payment_transactions.provider_amount  the escrow payout that actually reached the provider's
                                           wallet (set by the release trigger on confirm, or by
                                           resolve_dispute's held-branch release)
     a pre-dispute 'paid' event with meta.payout
                                           proves the escrow had ALREADY been paid out before the
                                           dispute — so a refund ordered now is a clawback out of
                                           the provider's wallet, not held money returned.

   Without that second fact you cannot tell "held → partial refund" from "already released →
   partial clawback" after the event: both end with payment_status='refunded' and a non-null
   provider_amount. */

export type PayTxRow = {
  amount: number;                   // paise, as the gateway captured it
  status: string;
  platform_fee: number | null;
  provider_amount: number | null;
};

export type EventRowLite = { to_status: string; meta: Record<string, unknown> | null; created_at: string };

export function wasPaidOutBefore(events: EventRowLite[], isoBefore: string): boolean {
  const cutoff = new Date(isoBefore).getTime();
  return events.some(
    (e) => e.to_status === 'paid'
      && e.meta != null && e.meta.payout != null
      && new Date(e.created_at).getTime() < cutoff,
  );
}

export type Settlement = {
  hasGatewayPayment: boolean;
  customerPaid: number;      // what left the customer's card
  platformFee: number;       // Seva's cut, as recorded on the ledger row
  providerCredited: number;  // escrow payout credited to the provider's wallet
  refundToCustomer: number;  // ordered by the resolution
  clawback: number;          // pulled back OUT of the provider's wallet (0 unless already paid out)
  providerNet: number;       // providerCredited − clawback
  customerNet: number;       // what the booking finally cost the customer
};

export function settlementFor(args: {
  dispute: Dispute;
  payTx: PayTxRow | null;
  amountFallback: number;
  paidOutBeforeDispute: boolean;
}): Settlement {
  const { dispute, payTx, amountFallback, paidOutBeforeDispute } = args;
  const customerPaid = payTx ? Number(payTx.amount) / 100 : Number(amountFallback ?? 0);
  const platformFee = Number(payTx?.platform_fee ?? 0);
  const providerCredited = Number(payTx?.provider_amount ?? 0);
  const refundToCustomer = Number(dispute.refund_amount ?? 0);
  const clawback = paidOutBeforeDispute && refundToCustomer > 0 ? refundToCustomer : 0;
  return {
    hasGatewayPayment: Boolean(payTx),
    customerPaid,
    platformFee,
    providerCredited,
    refundToCustomer,
    clawback,
    providerNet: providerCredited - clawback,
    customerNet: customerPaid - refundToCustomer,
  };
}

// Everything the settlement card needs, fetched from the party's own session (RLS does the rest).
export async function fetchSettlement(
  dispute: Dispute,
  amountFallback: number,
): Promise<Settlement> {
  const [{ data: tx }, { data: ev }] = await Promise.all([
    supabase.from('payment_transactions')
      .select('amount, status, platform_fee, provider_amount')
      .eq('booking_id', dispute.booking_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('booking_events')
      .select('to_status, meta, created_at')
      .eq('booking_id', dispute.booking_id)
      .eq('to_status', 'paid'),
  ]);
  return settlementFor({
    dispute,
    payTx: (tx as PayTxRow | null) ?? null,
    amountFallback,
    paidOutBeforeDispute: wasPaidOutBefore((ev ?? []) as EventRowLite[], dispute.created_at),
  });
}

// Rupees for display. Sub-₹1000 keeps its paise (fees land on .5 often enough to matter); larger
// amounts round. Negative values print with a real minus sign — the provider CAN end a resolved
// dispute below zero (clawback of the gross while the fee was already deducted).
export const inr = (n: number): string => {
  const v = Math.abs(n);
  const s = v < 1000 ? Number(v.toFixed(2)).toLocaleString('en-IN') : Math.round(v).toLocaleString('en-IN');
  return `${n < 0 ? '−' : ''}₹${s}`;
};
