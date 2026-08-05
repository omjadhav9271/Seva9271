'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Scale, AlertTriangle, CheckCircle, ChevronRight, BadgeCheck } from 'lucide-react';
import { supabase, type Dispute } from '@/lib/supabase';
import { useAdminGuard, REASON_LABELS } from '@/lib/admin';
import { fetchNames, partyLabel } from '@/lib/disputes';

// Queue row = dispute + enough booking context to triage (admin RLS opens these reads).
type QueueRow = Dispute & {
  bookings: {
    id: string;
    customer_id: string;
    status: string;
    payment_status: string;
    price_charged: number | null;
    price_agreed: number | null;
    total_amount: number;
    service_categories: { name: string } | null;
    service_providers: {
      business_name: string | null;
      service_categories: { name: string } | null;
    } | null;
  } | null;
};

function age(iso: string): string {
  const hrs = Math.floor((Date.now() - new Date(iso).getTime()) / 3600e3);
  if (hrs < 1) return '<1h';
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export default function AdminDisputesPage() {
  const guard = useAdminGuard();
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (guard !== 'ok') return;
    let active = true;
    (async () => {
      const { data, error } = await supabase
        .from('disputes')
        .select('*, bookings(id, customer_id, status, payment_status, price_charged, price_agreed, total_amount, service_categories(name), service_providers(business_name, service_categories(name)))')
        .order('created_at', { ascending: false });
      if (!active) return;
      if (error) console.error('Failed to load disputes:', error.message);
      const list = (data ?? []) as unknown as QueueRow[];
      setRows(list);
      // Put a NAME on every case. Triage is a human job: "raised by the customer" tells you
      // nothing when six rows say it, and admins field calls from people, not roles.
      const ids = list.flatMap((d) => [d.raised_by, d.bookings?.customer_id]);
      const map = await fetchNames(ids);
      if (active) setNames(map);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [guard]);

  if (guard !== 'ok') {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Checking access…</div>;
  }

  const visible = rows.filter((r) => (tab === 'open' ? r.status !== 'resolved' : r.status === 'resolved'));
  const openCount = rows.filter((r) => r.status !== 'resolved').length;

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center gap-3 mb-2">
          <Scale className="w-7 h-7 text-[#FF9933]" />
          <h1 className="text-3xl font-black text-white">Dispute Queue</h1>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Every dispute carries its full evidence bundle — the reason and message filed, the files
          each party attached, the booking timeline, the chat and the payments.
        </p>
        <Link href="/admin/providers" className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-[#FF9933] transition-colors mb-6">
          <BadgeCheck className="w-3.5 h-3.5" /> Provider applications
        </Link>

        <div className="flex gap-2 mb-6">
          {(['open', 'resolved'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-xl text-sm font-medium capitalize transition-all ${
                tab === t ? 'bg-[#FF9933] text-white' : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/50'
              }`}
            >
              {t}{t === 'open' && openCount > 0 ? ` (${openCount})` : ''}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm">Loading disputes…</p>
        ) : visible.length === 0 ? (
          <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-10 text-center">
            <CheckCircle className="w-10 h-10 text-[#138808] mx-auto mb-3" />
            <p className="text-gray-400 text-sm">{tab === 'open' ? 'No open disputes. All clear.' : 'No resolved disputes yet.'}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((d) => {
              const amount = d.bookings ? (d.bookings.price_charged ?? d.bookings.price_agreed ?? d.bookings.total_amount) : null;
              const business = d.bookings?.service_providers?.business_name ?? null;
              const customer = d.bookings?.customer_id ? names[d.bookings.customer_id] : null;
              // A provider raiser is best identified by their business; a customer by their name.
              const raiser = d.raiser_role === 'provider'
                ? partyLabel(business ?? names[d.raised_by], 'provider')
                : partyLabel(customer ?? names[d.raised_by], 'customer');
              const other = d.raiser_role === 'provider'
                ? partyLabel(customer, 'customer')
                : partyLabel(business, 'provider');
              const category = d.bookings?.service_categories?.name
                ?? d.bookings?.service_providers?.service_categories?.name ?? null;
              return (
                <Link
                  key={d.id}
                  href={`/admin/disputes/${d.id}`}
                  className="flex items-center gap-4 bg-[#161616] border border-[#2a2a2a] rounded-2xl p-4 hover:border-[#FF9933]/40 transition-all group"
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${d.status === 'resolved' ? 'bg-[#138808]/10' : 'bg-orange-900/20'}`}>
                    {d.status === 'resolved'
                      ? <CheckCircle className="w-5 h-5 text-[#138808]" />
                      : <AlertTriangle className="w-5 h-5 text-orange-400" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white">
                      {REASON_LABELS[d.reason]}
                      <span className="text-gray-500 font-normal"> · raised by {raiser}</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                      against {other}
                      {category && <> · {category}</>}
                      {' · '}booking #{d.booking_id.slice(0, 8)}
                      {amount != null && <> · ₹{Number(amount).toLocaleString('en-IN')}</>}
                      {d.bookings && <> · money: {d.bookings.payment_status}</>}
                    </p>
                    {d.description?.trim() && (
                      <p className="text-xs text-gray-500 mt-1 truncate italic">&ldquo;{d.description.trim()}&rdquo;</p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium capitalize ${
                      d.status === 'resolved'
                        ? 'bg-[#138808]/10 text-[#138808]'
                        : 'bg-orange-900/20 text-orange-400'
                    }`}>
                      {d.status === 'under_review' ? 'under review' : d.status}
                    </span>
                    <p className="text-xs text-gray-500 mt-1">{age(d.created_at)} old</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-[#FF9933] transition-colors flex-shrink-0" />
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
