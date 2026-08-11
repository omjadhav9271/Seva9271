'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { BadgeCheck, Clock, CheckCircle, XCircle, ChevronRight } from 'lucide-react';
import { useAdminGuard, fetchProviderApplications, type ProviderApplicationRow } from '@/lib/admin';
import AdminNav from '@/components/admin-nav';
import TrustTierBadge from '@/components/trust-tier-badge';

function age(iso: string | null): string {
  if (!iso) return '—';
  const hrs = Math.floor((Date.now() - new Date(iso).getTime()) / 3600e3);
  if (hrs < 1) return '<1h';
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export default function AdminProvidersPage() {
  const guard = useAdminGuard();
  const [rows, setRows] = useState<ProviderApplicationRow[]>([]);
  const [tab, setTab] = useState<'pending' | 'decided'>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /* What the SERVER holds, versus what it sent. The queue is bounded now (200 pending / 100
     decided) because it used to select every application ever submitted and PostgREST silently
     truncated it at 1,000 — dropping the oldest, which is precisely the backlog. A bounded list
     that does not say it is bounded is the same lie in a smaller font, so the totals come back
     with the page and are shown whenever they exceed it. */
  const [counts, setCounts] = useState<{ pending: number; decided: number } | null>(null);

  useEffect(() => {
    if (guard !== 'ok') return;
    let active = true;
    (async () => {
      const result = await fetchProviderApplications();
      if (!active) return;
      if ('error' in result) setError(result.error);
      else {
        setRows(result.data.applications ?? []);
        setCounts(result.data.counts ?? null);
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [guard]);

  if (guard !== 'ok') {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Checking access…</div>;
  }

  const isPending = (r: ProviderApplicationRow) => r.status === 'pending';
  const visible = rows.filter((r) => (tab === 'pending' ? isPending(r) : !isPending(r)));
  const pendingCount = rows.filter(isPending).length;

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center gap-3 mb-2">
          <BadgeCheck className="w-7 h-7 text-[#FF9933]" />
          <h1 className="text-3xl font-black text-white">Provider Applications</h1>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Nobody is bookable until approved here. Check the ID against the details before you approve.
        </p>
        <AdminNav counts={{ providers: pendingCount }} />

        <div className="flex gap-2 mb-6">
          {(['pending', 'decided'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-xl text-sm font-medium capitalize transition-all ${
                tab === t ? 'bg-[#FF9933] text-white' : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/50'
              }`}
            >
              {t === 'pending' ? 'To review' : 'Decided'}
              {t === 'pending' && (counts?.pending ?? pendingCount) > 0
                ? ` (${counts?.pending ?? pendingCount})` : ''}
            </button>
          ))}
        </div>

        {/* Say it when the list is a page rather than the whole thing. An admin who cannot tell
            "3 decided applications" from "the 100 most recent of 1,082" will draw the wrong
            conclusion from an empty-looking screen — which is exactly what happened when the
            silent 1,000-row truncation hid the only pending application. */}
        {counts && (counts[tab] ?? 0) > visible.length && !loading && !error && (
          <p className="text-xs text-gray-500 mb-4">
            Showing {visible.length} of {counts[tab]} {tab === 'pending' ? 'waiting' : 'decided'}
            {tab === 'pending' ? ' — oldest first.' : ' — most recently decided first.'}
          </p>
        )}

        {error ? (
          <p className="text-sm text-red-400">{error}</p>
        ) : loading ? (
          <p className="text-gray-400 text-sm">Loading applications…</p>
        ) : visible.length === 0 ? (
          <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-10 text-center">
            <CheckCircle className="w-10 h-10 text-[#138808] mx-auto mb-3" />
            <p className="text-gray-400 text-sm">
              {tab === 'pending' ? 'Nothing waiting. Queue is clear.' : 'No decided applications yet.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((r) => (
              <Link
                key={r.id}
                href={`/admin/providers/${r.id}`}
                className="flex items-center gap-4 bg-[#161616] border border-[#2a2a2a] rounded-2xl p-4 hover:border-[#FF9933]/40 transition-all group"
              >
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                  r.status === 'approved' ? 'bg-[#138808]/10'
                    : r.status === 'pending' ? 'bg-[#FF9933]/10' : 'bg-red-900/20'
                }`}>
                  {r.status === 'approved' ? <CheckCircle className="w-5 h-5 text-[#138808]" />
                    : r.status === 'pending' ? <Clock className="w-5 h-5 text-[#FF9933]" />
                    : <XCircle className="w-5 h-5 text-red-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">
                    {r.business_name ?? 'Unnamed'}
                    <span className="text-gray-500 font-normal"> · {r.service_categories?.name ?? 'No category'}</span>
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {[r.city, r.state].filter(Boolean).join(', ') || 'No location'}
                    {r.hourly_rate > 0 && <> · ₹{Number(r.hourly_rate).toLocaleString('en-IN')}/hr</>}
                    {' · '}{r.documents_verified}/{r.documents_required} docs verified
                  </p>
                  {/* Approved rows only. trust_tier is NOT NULL DEFAULT 1 and tier 1 reads
                      "Identity verified", so on a pending applicant with nothing checked yet the
                      badge would assert something the DB has not established. Their progress is
                      already on the line above as docs-verified. */}
                  {r.status === 'approved' && <TrustTierBadge tier={r.trust_tier} className="mt-1.5" />}
                </div>
                <div className="text-right flex-shrink-0">
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium capitalize ${
                    r.status === 'approved' ? 'bg-[#138808]/10 text-[#138808]'
                      : r.status === 'pending' ? 'bg-[#FF9933]/10 text-[#FF9933]'
                      : 'bg-red-900/20 text-red-400'
                  }`}>
                    {r.status}
                  </span>
                  <p className="text-xs text-gray-500 mt-1">
                    {r.status === 'pending' ? `waiting ${age(r.applied_at)}` : age(r.reviewed_at) + ' ago'}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-[#FF9933] transition-colors flex-shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
