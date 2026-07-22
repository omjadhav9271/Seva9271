'use client';

/* Step 6 — bidirectional, gated review UI for the booking detail page.

   Shown only when the booking is settled (paid/released) and only to the two parties. The
   customer rates the provider (overall/quality/punctuality/price-fairness/communication); the
   provider rates the customer (overall/communication/punctuality). Writes go through the
   submit_review RPC — never a direct insert (reviews are RPC-only + immutable). Reciprocity is
   enforced by RLS: you always see your own, but the counterpart's review is hidden until you
   submit yours (or 14 days pass), so we simply render whatever the reviews query returns. */

import { useState, useEffect, useCallback } from 'react';
import { Star, Shield, Clock, CheckCircle } from 'lucide-react';
import { supabase, type Review, type ReviewDirection } from '@/lib/supabase';
import type { Role } from '@/lib/bookings';
import { toast } from 'sonner';

type Props = {
  bookingId: string;
  role: Role;
  userId: string;
  settled: boolean;
  counterpartyName: string;
};

/* What each stored review column MEANS depends on the review's direction — the columns are
   generic slots we label per side (no schema rename). Provider→customer reuses rating_quality as
   "Respect" and never uses rating_price_fairness:

     column                 customer_to_provider     provider_to_customer
     rating_quality         Quality of work          Respect
     rating_punctuality     Punctuality              Availability / punctuality
     rating_communication   Professionalism          Communication
     rating_price_fairness  Value for money          (unused → null)

   Overall (rating) is always required; each axis is optional (0 → sent as null). */
const DIMENSIONS: Record<Role, { key: DimKey; label: string }[]> = {
  customer: [
    { key: 'quality', label: 'Quality of work' },
    { key: 'punctuality', label: 'Punctuality' },
    { key: 'communication', label: 'Professionalism' },
    { key: 'price_fairness', label: 'Value for money' },
  ],
  provider: [
    { key: 'communication', label: 'Communication' },
    { key: 'punctuality', label: 'Availability / punctuality' },
    { key: 'quality', label: 'Respect' },
  ],
};

type DimKey = 'quality' | 'punctuality' | 'communication' | 'price_fairness';

const REVIEW_SELECT =
  'id, booking_id, reviewer_id, direction, rating, comment, rating_quality, rating_punctuality, rating_communication, rating_price_fairness, created_at';

function StarInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          onClick={() => onChange(i)}
          className="p-0.5"
          aria-label={`${i} star${i > 1 ? 's' : ''}`}
        >
          <Star className={`w-6 h-6 transition-colors ${i <= value ? 'fill-[#FF9933] text-[#FF9933]' : 'fill-gray-700 text-gray-700 hover:text-gray-500'}`} />
        </button>
      ))}
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`w-3.5 h-3.5 ${i <= Math.round(rating) ? 'fill-[#FF9933] text-[#FF9933]' : 'fill-gray-700 text-gray-700'}`} />
      ))}
    </div>
  );
}

// The dimension axes present on a review row, labelled by DIRECTION (skips null axes).
function dimensionsOf(r: Review): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  const add = (label: string, value: number | null) => { if (value != null) out.push({ label, value }); };
  if (r.direction === 'customer_to_provider') {
    add('Quality of work', r.rating_quality);
    add('Punctuality', r.rating_punctuality);
    add('Professionalism', r.rating_communication);
    add('Value for money', r.rating_price_fairness);
  } else {
    add('Communication', r.rating_communication);
    add('Availability / punctuality', r.rating_punctuality);
    add('Respect', r.rating_quality);
  }
  return out;
}

function ReviewCard({ title, review }: { title: string; review: Review }) {
  const dims = dimensionsOf(review);
  // Overall shown = the average of the axes (matches how it was captured). Fall back to the
  // stored rating for any legacy row that has no per-axis values.
  const overall = dims.length ? dims.reduce((s, d) => s + d.value, 0) / dims.length : review.rating;
  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#1e1e1e] p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-white">{title}</span>
        <span className="text-xs text-gray-500">
          {new Date(review.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Stars rating={overall} />
        <span className="text-sm font-bold text-white">{overall.toFixed(1)}</span>
      </div>
      {dims.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
          {dims.map((d) => (
            <span key={d.label} className="inline-flex items-center gap-1 text-xs text-gray-400">
              {d.label}
              <span className="font-medium text-gray-200">{d.value}/5</span>
            </span>
          ))}
        </div>
      )}
      {review.comment && <p className="text-sm text-gray-300 leading-relaxed">{review.comment}</p>}
    </div>
  );
}

export default function BookingReview({ bookingId, role, userId, settled, counterpartyName }: Props) {
  const myDirection: ReviewDirection = role === 'customer' ? 'customer_to_provider' : 'provider_to_customer';
  const [loading, setLoading] = useState(true);
  const [myReview, setMyReview] = useState<Review | null>(null);
  const [counterpartReview, setCounterpartReview] = useState<Review | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Form state (0 = unset). Overall is DERIVED as the average of this direction's axes, not
  // entered separately — every axis must be rated before submit is enabled.
  const [dims, setDims] = useState<Record<DimKey, number>>({ quality: 0, punctuality: 0, communication: 0, price_fairness: 0 });
  const [comment, setComment] = useState('');

  // Overall = mean of THIS direction's axes (see DIMENSIONS). Rounded to a whole star for the INT
  // `rating` column that feeds the provider aggregate; the UI shows the precise average.
  const axisKeys = DIMENSIONS[role].map((d) => d.key);
  const allAxesSet = axisKeys.every((k) => dims[k] > 0);
  const overallMean = allAxesSet ? axisKeys.reduce((s, k) => s + dims[k], 0) / axisKeys.length : 0;

  const load = useCallback(async () => {
    // RLS returns my own row always, and the counterpart's only once it's revealed.
    const { data } = await supabase.from('reviews').select(REVIEW_SELECT).eq('booking_id', bookingId);
    const rows = (data ?? []) as unknown as Review[];
    setMyReview(rows.find((r) => r.reviewer_id === userId) ?? null);
    setCounterpartReview(rows.find((r) => r.direction !== myDirection) ?? null);
    setLoading(false);
  }, [bookingId, userId, myDirection]);

  useEffect(() => {
    if (!settled) { setLoading(false); return; }
    setLoading(true);
    void load();

    // Live reveal: when the counterpart submits, RLS lets their row into our stream (our own
    // review now exists, so review_reciprocated() is true), so we re-fetch and the "waiting"
    // state flips to the revealed card with no refresh. Our own submit also echoes here —
    // load() is idempotent. Same pattern as BookingChat.
    const channel = supabase
      .channel(`reviews:${bookingId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'reviews', filter: `booking_id=eq.${bookingId}` },
        () => { void load(); },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [settled, bookingId, load]);

  const nz = (n: number) => (n > 0 ? n : null);

  const handleSubmit = async () => {
    if (submitting || !allAxesSet) return;
    setSubmitting(true);
    const { error } = await supabase.rpc('submit_review', {
      p_booking_id: bookingId,
      p_rating: Math.round(overallMean),   // overall is the (rounded) average of the axes
      p_comment: comment.trim() || null,
      // rating_quality is filled by BOTH sides (customer=Quality of work, provider=Respect).
      // Only rating_price_fairness is customer-only (Value for money); the provider leaves it null.
      p_quality: nz(dims.quality),
      p_punctuality: nz(dims.punctuality),
      p_communication: nz(dims.communication),
      p_price_fairness: role === 'customer' ? nz(dims.price_fairness) : null,
    });
    if (error) {
      setSubmitting(false);
      toast.error(error.message);
      return;
    }
    toast.success('Review submitted.');
    await load();
    setSubmitting(false);
  };

  if (!settled || loading) return null;

  const counterpartTitle = role === 'customer'
    ? `${counterpartyName}'s review of you`
    : 'Their review of you';
  const myTitle = 'Your review';

  return (
    <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Star className="w-4 h-4 text-[#FF9933]" />
        <h2 className="font-bold text-white">Reviews</h2>
      </div>

      {/* Not yet reviewed → the form for my direction. */}
      {!myReview ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            {role === 'customer'
              ? `Rate ${counterpartyName} on each point — your overall score is their average.`
              : 'Rate this customer on each point — your overall score is their average.'}
          </p>

          <div className="grid sm:grid-cols-2 gap-4">
            {DIMENSIONS[role].map((d) => (
              <div key={d.key}>
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-1.5">{d.label}</label>
                <StarInput value={dims[d.key]} onChange={(n) => setDims((s) => ({ ...s, [d.key]: n }))} />
              </div>
            ))}
          </div>

          {/* Overall is derived from the axes above — not entered separately. */}
          <div className="flex items-center justify-between rounded-xl border border-[#2a2a2a] bg-[#1e1e1e] px-4 py-3">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Overall (average)</span>
            {allAxesSet ? (
              <span className="flex items-center gap-2">
                <Stars rating={overallMean} />
                <span className="text-sm font-bold text-white">{overallMean.toFixed(1)}</span>
              </span>
            ) : (
              <span className="text-xs text-gray-500">Rate every point to set your overall</span>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-gray-400 uppercase tracking-wide block mb-1.5">Comment (optional)</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Share the details of your experience…"
              className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#FF9933]/40 resize-none"
            />
          </div>

          <button
            onClick={handleSubmit}
            disabled={submitting || !allAxesSet}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold bg-[#FF9933] text-white hover:bg-[#e8872e] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Star className="w-4 h-4" />
            {submitting ? 'Submitting…' : 'Submit review'}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <ReviewCard title={myTitle} review={myReview} />

          {counterpartReview ? (
            <ReviewCard title={counterpartTitle} review={counterpartReview} />
          ) : (
            <div className="flex items-start gap-3 rounded-xl border border-sky-700/30 bg-sky-900/20 p-4">
              <Clock className="w-5 h-5 text-sky-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-white">Waiting for the other party</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  Their review appears once they rate you (or in 14 days). Yours stays hidden from them until then — that keeps reviews honest.
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 text-xs text-gray-500">
            {counterpartReview ? <CheckCircle className="w-3.5 h-3.5 text-[#138808]" /> : <Shield className="w-3.5 h-3.5 text-gray-500" />}
            <span>Reviews are final and can&apos;t be edited.</span>
          </div>
        </div>
      )}
    </div>
  );
}
