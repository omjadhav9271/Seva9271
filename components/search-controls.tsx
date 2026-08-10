'use client';

import { Sparkles, MapPin, Star, type LucideIcon } from 'lucide-react';
import type { SortMode } from '@/lib/matching';

/* The two controls a normal person actually wants over a list of local providers: what order, and
   whether to hide the ones who aren't free right now.

   WHAT IS DELIBERATELY NOT HERE: a reputation-score or trust-tier threshold. It is tempting —
   the numbers exist, and a slider is easy — but asking a customer to pick a minimum trust score
   hands them our job. The ranking already weights reputation and verification; a customer who has
   to reason about a 0-5 manipulation-resistant composite in order to find an electrician is being
   asked to operate the reputation engine instead of benefiting from it. Controls stay in the
   language of the person using them.

   Both controls are QUERY parameters, not client-side transforms. Sorting or filtering the rows
   that came back re-orders a ranked cut, which answers a different question than the one the
   control appears to ask (see 20260822120000). */

/* The three a customer reaches for, as one-tap pills. */
const SORT_OPTIONS: { value: SortMode; label: string; icon: LucideIcon; needsLocation: boolean }[] = [
  { value: 'match', label: 'Best match', icon: Sparkles, needsLocation: true },
  { value: 'distance', label: 'Nearest', icon: MapPin, needsLocation: true },
  { value: 'rating', label: 'Top rated', icon: Star, needsLocation: false },
];

/* The long tail, one tap further in. Kept out of the pill row because six pills is a wall rather
   than a choice — but kept, because "cheapest first" is a real question people ask of a
   marketplace. Each of these is a p_sort value like the others: none of it is a client-side
   re-shuffle of the page. */
const MORE_SORTS: { value: SortMode; label: string }[] = [
  { value: 'reviews', label: 'Most reviewed' },
  { value: 'price_low', label: 'Lowest price' },
  { value: 'price_high', label: 'Highest price' },
];

export default function SearchControls({ sort, onSort, availableOnly, onAvailableOnly, ranked }: {
  sort: SortMode;
  onSort: (next: SortMode) => void;
  availableOnly: boolean;
  onAvailableOnly: (next: boolean) => void;
  /** Whether we know where the customer is. Without it there is no match score and no distance. */
  ranked: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div
        role="radiogroup"
        aria-label="Sort results"
        className="inline-flex bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-1"
      >
        {SORT_OPTIONS.map(({ value, label, icon: Icon, needsLocation }) => {
          const disabled = needsLocation && !ranked;
          const active = sort === value && !disabled;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              // Disabled needs a reason, or it reads as broken rather than as not-yet-applicable.
              title={disabled ? 'Set your location to sort by this' : undefined}
              onClick={() => onSort(value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                active
                  ? 'bg-[#FF9933] text-white shadow-sm'
                  : disabled
                    ? 'text-gray-600 cursor-not-allowed'
                    : 'text-gray-300 hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* One control, two tiers. The select shows the active choice when one of ITS options is
          selected and falls back to "More…" otherwise, so exactly one of the two widgets ever
          looks active — a customer is never left wondering which sort actually won. */}
      <select
        value={MORE_SORTS.some((o) => o.value === sort) ? sort : ''}
        onChange={(e) => { if (e.target.value) onSort(e.target.value as SortMode); }}
        aria-label="More ways to sort"
        className={`bg-[#1a1a1a] border rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-[#FF9933] transition-colors ${
          MORE_SORTS.some((o) => o.value === sort)
            ? 'border-[#FF9933] text-white'
            : 'border-[#2a2a2a] text-gray-300'
        }`}
      >
        <option value="">More…</option>
        {MORE_SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      <label className="flex items-center gap-2 cursor-pointer select-none group">
        <input
          type="checkbox"
          checked={availableOnly}
          onChange={(e) => onAvailableOnly(e.target.checked)}
          aria-label="Available now"
          className="w-4 h-4 rounded border-[#2a2a2a] bg-[#1a1a1a] text-[#FF9933] accent-[#FF9933] cursor-pointer"
        />
        <span className="text-xs font-medium text-gray-300 group-hover:text-white transition-colors">
          Available now
        </span>
      </label>
    </div>
  );
}
