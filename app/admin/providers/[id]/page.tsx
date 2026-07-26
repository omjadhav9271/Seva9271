'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, CheckCircle, XCircle, FileText, ExternalLink, Clock, ShieldCheck, Loader2,
} from 'lucide-react';
import {
  useAdminGuard, fetchProviderApplication, reviewProviderApplication,
  type ProviderApplicationDetail,
} from '@/lib/admin';
import { toast } from 'sonner';

export default function AdminProviderApplicationPage({ params }: { params: { id: string } }) {
  const guard = useAdminGuard();
  const router = useRouter();
  const [detail, setDetail] = useState<ProviderApplicationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  const load = useCallback(async () => {
    const result = await fetchProviderApplication(params.id);
    if ('error' in result) setError(result.error);
    else { setDetail(result.data); setError(null); }
    setLoading(false);
  }, [params.id]);

  useEffect(() => {
    if (guard !== 'ok') return;
    load();
  }, [guard, load]);

  const decide = async (decision: 'approve' | 'reject') => {
    if (decision === 'reject' && !reason.trim()) {
      toast.error('Give a reason — the provider sees it and resubmits against it.');
      return;
    }
    setBusy(decision);
    const result = await reviewProviderApplication(params.id, decision, reason);
    if ('error' in result) { setBusy(null); toast.error(result.error); return; }
    toast.success(decision === 'approve' ? 'Approved — the provider is live.' : 'Rejected — the provider has been told why.');
    await load();
    setBusy(null);
    setReason('');
  };

  if (guard !== 'ok') {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Checking access…</div>;
  }
  if (loading) {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Loading application…</div>;
  }
  if (error || !detail) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20 flex flex-col items-center justify-center gap-4">
        <p className="text-gray-400">{error ?? 'Application not found'}</p>
        <Link href="/admin/providers" className="text-[#FF9933] text-sm">← Back to applications</Link>
      </div>
    );
  }

  const { application: app, documents, owner } = detail;
  const decided = app.status !== 'pending';

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/admin/providers" className="inline-flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors group">
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
          Back to applications
        </Link>

        {/* Header + current state */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-black text-white">{app.business_name ?? 'Unnamed'}</h1>
            <p className="text-sm text-[#FF9933] mt-0.5">{app.service_categories?.name ?? 'No category'}</p>
          </div>
          <span className={`text-xs px-3 py-1.5 rounded-full font-medium capitalize flex-shrink-0 ${
            app.status === 'approved' ? 'bg-[#138808]/10 text-[#138808]'
              : app.status === 'pending' ? 'bg-[#FF9933]/10 text-[#FF9933]'
              : 'bg-red-900/20 text-red-400'
          }`}>
            {app.status}{app.is_verified ? ' · verified' : ''}
          </span>
        </div>

        {/* Application details */}
        <Card title="Application">
          <Row label="Applicant" value={owner.name} />
          <Row label="Email" value={owner.email} />
          <Row label="Phone" value={owner.phone} />
          <Row label="Service area" value={[app.address, app.city, app.state].filter(Boolean).join(', ') || null} />
          <Row label="Rate" value={app.hourly_rate > 0 ? `₹${Number(app.hourly_rate).toLocaleString('en-IN')}/hr` : null} />
          <Row label="Experience" value={app.experience_years ? `${app.experience_years} years` : null} />
          <Row label="Account created" value={owner.member_since ? new Date(owner.member_since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null} />
          <Row label="Submitted" value={app.applied_at ? new Date(app.applied_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null} />
          {app.bio && (
            <div className="pt-3 mt-1 border-t border-[#222]">
              <p className="text-xs text-gray-500 mb-1">Bio</p>
              <p className="text-sm text-gray-200 leading-relaxed">{app.bio}</p>
            </div>
          )}
        </Card>

        {/* KYC documents — signed URLs, expire in 10 minutes */}
        <Card title="Identity documents">
          {documents.length === 0 ? (
            <p className="text-sm text-gray-500">No documents attached. That alone is grounds to reject.</p>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <a
                  key={doc.path}
                  href={doc.url ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex items-center gap-3 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 transition-all ${
                    doc.url ? 'hover:border-[#FF9933]/40' : 'opacity-50 pointer-events-none'
                  }`}
                >
                  <FileText className="w-4 h-4 text-[#FF9933] flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{doc.label}</p>
                    <p className="text-xs text-gray-500 truncate">{doc.name ?? doc.path}</p>
                  </div>
                  <ExternalLink className="w-4 h-4 text-gray-500 flex-shrink-0" />
                </a>
              ))}
              <p className="text-xs text-gray-600 pt-1">Links are private and expire in 10 minutes.</p>
            </div>
          )}
        </Card>

        {/* Decision */}
        {decided ? (
          <Card title="Decision">
            <div className="flex items-center gap-2 mb-2">
              {app.status === 'approved'
                ? <ShieldCheck className="w-4 h-4 text-[#138808]" />
                : <XCircle className="w-4 h-4 text-red-400" />}
              <p className="text-sm text-white capitalize">
                {app.status}
                {app.reviewed_at && (
                  <span className="text-gray-500 font-normal">
                    {' '}on {new Date(app.reviewed_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                  </span>
                )}
              </p>
            </div>
            {app.rejection_reason && (
              <p className="text-sm text-gray-300 bg-[#1e1e1e] rounded-xl px-4 py-3 mt-2">
                <span className="text-gray-500">Reason shown to the provider: </span>{app.rejection_reason}
              </p>
            )}
            {app.status === 'rejected' && (
              <p className="text-xs text-gray-500 mt-3">
                They can fix it and resubmit — this page will show the new submission.
              </p>
            )}
            {app.status === 'approved' && (
              <Link href={`/providers/${app.id}`} className="inline-flex items-center gap-1.5 text-xs text-[#FF9933] hover:underline mt-3">
                View public profile <ExternalLink className="w-3 h-3" />
              </Link>
            )}
          </Card>
        ) : (
          <Card title="Decision">
            <p className="text-sm text-gray-400 mb-4">
              Approving makes this provider bookable and verified. Rejecting sends the reason below to them.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Reason (required to reject) — e.g. ID photo is unreadable, please re-upload"
              className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933] resize-none mb-4"
            />
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => decide('approve')}
                disabled={busy !== null}
                className="flex-1 flex items-center justify-center gap-2 bg-[#138808] hover:bg-[#0f6b06] text-white rounded-xl py-3 font-semibold text-sm transition-colors disabled:opacity-60"
              >
                {busy === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                Approve
              </button>
              <button
                onClick={() => decide('reject')}
                disabled={busy !== null}
                className="flex-1 flex items-center justify-center gap-2 bg-[#1e1e1e] border border-red-500/30 text-red-400 hover:bg-red-900/20 rounded-xl py-3 font-semibold text-sm transition-colors disabled:opacity-60"
              >
                {busy === 'reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                Reject
              </button>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-gray-600 mt-3">
              <Clock className="w-3 h-3" /> Applications should be decided within 24–48 hours.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 mb-4">
      <h2 className="font-bold text-white mb-4">{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-4 text-sm py-1">
      <span className="text-gray-500 flex-shrink-0">{label}</span>
      <span className="text-gray-200 text-right break-words">{value}</span>
    </div>
  );
}
