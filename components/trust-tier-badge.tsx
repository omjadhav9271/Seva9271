'use client';

/* The Step-9.5 trust tier, made visible.

   The tier is server-computed by recompute_trust_tier(): 3 when a police verification is verified
   and unexpired, 2 when some other credential or a verified work history exists, 1 otherwise. It
   is CAPABILITY — what a provider may be trusted with — and deliberately separate from reputation,
   which is earned from behaviour (§7.3). Never render it as a score.

   It was unreadable by any client until 20260813120000 added the SELECT grant, which is why it
   appeared nowhere despite being computed correctly since Step 9.5. */

import { Shield, ShieldCheck, ShieldAlert } from 'lucide-react';

export const TIER_LABEL: Record<number, string> = {
  1: 'Identity verified',
  2: 'Credentials verified',
  3: 'Background verified',
};

export const TIER_MEANING: Record<number, string> = {
  1: 'Government ID checked against their profile.',
  2: 'A trade credential or a confirmed work history on top of their ID.',
  3: 'Police verification on file, current and unexpired.',
};

const STYLE: Record<number, { icon: typeof Shield; className: string }> = {
  1: { icon: ShieldAlert, className: 'bg-slate-700/40 text-slate-300 border-slate-600/40' },
  2: { icon: Shield, className: 'bg-[#5da9ff]/10 text-[#5da9ff] border-[#5da9ff]/30' },
  3: { icon: ShieldCheck, className: 'bg-[#138808]/10 text-[#22c55e] border-[#138808]/40' },
};

export default function TrustTierBadge({
  tier, showMeaning = false, className = '',
}: {
  tier: number | null | undefined;
  showMeaning?: boolean;
  className?: string;
}) {
  // A provider row always carries a tier (NOT NULL DEFAULT 1); treat anything unexpected as tier 1
  // rather than inventing a level nobody has earned.
  const t = tier != null && STYLE[tier] ? tier : 1;
  const { icon: Icon, className: tone } = STYLE[t];

  return (
    <span className={`inline-flex flex-col gap-0.5 ${className}`}>
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border w-fit ${tone}`}>
        <Icon className="w-3.5 h-3.5 flex-shrink-0" />
        Tier {t} · {TIER_LABEL[t]}
      </span>
      {showMeaning && <span className="text-[11px] text-gray-500">{TIER_MEANING[t]}</span>}
    </span>
  );
}
