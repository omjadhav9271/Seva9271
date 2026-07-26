'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  CheckCircle, Clock, AlertTriangle, ShieldCheck, Upload, X, FileText, Loader2, Ban,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import {
  fetchMyApplication, submitApplication, uploadKycDoc, removeKycDoc,
  KYC_ACCEPT, KYC_SLOTS, type MyApplication,
} from '@/lib/provider-application';
import type { KycDocument } from '@/lib/supabase';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';

type CategoryRow = { id: string; name: string; slug: string };

const BIO_MAX = 300;

const emptyForm = {
  categoryId: '', businessName: '', city: '', area: '', hourlyRate: '', experience: '', bio: '',
};

export default function BecomeProviderPage() {
  const { user, profile, loading: authLoading } = useAuth();
  const router = useRouter();

  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [application, setApplication] = useState<MyApplication | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);   // show the form even though a row exists
  const [form, setForm] = useState(emptyForm);
  const [docs, setDocs] = useState<(KycDocument | null)[]>([null, null]);
  const [uploadingSlot, setUploadingSlot] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputs = useRef<(HTMLInputElement | null)[]>([]);

  // Categories drive category_id — the RPC needs the real uuid, not a slug.
  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase.from('service_categories').select('id, name, slug').order('name');
      if (active) setCategories((data ?? []) as CategoryRow[]);
    })();
    return () => { active = false; };
  }, []);

  const prefill = useCallback((row: MyApplication) => {
    setForm({
      categoryId: row.category_id ?? '',
      businessName: row.business_name ?? '',
      city: row.city ?? '',
      area: row.address ?? '',
      hourlyRate: row.hourly_rate ? String(row.hourly_rate) : '',
      experience: row.experience_years ? String(row.experience_years) : '',
      bio: row.bio ?? '',
    });
    const existing = row.kyc_documents ?? [];
    setDocs([existing[0] ?? null, existing[1] ?? null]);
  }, []);

  // Load the caller's own application (if any) — this is what makes the status screen honest.
  useEffect(() => {
    if (authLoading) return;
    if (!user) { setLoading(false); return; }
    let active = true;
    (async () => {
      const row = await fetchMyApplication();
      if (!active) return;
      setApplication(row);
      if (row) prefill(row);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [user, authLoading, prefill]);

  const handleFile = async (slot: number, file: File | undefined) => {
    if (!file) return;
    setUploadingSlot(slot);
    const result = await uploadKycDoc(file, KYC_SLOTS[slot].key);
    setUploadingSlot(null);
    if ('error' in result) { toast.error(result.error); return; }
    const replaced = docs[slot];
    setDocs((prev) => prev.map((d, i) => (i === slot ? result.data : d)));
    if (replaced) await removeKycDoc(replaced.path);   // don't leave the old file behind
  };

  const clearDoc = async (slot: number) => {
    const doc = docs[slot];
    setDocs((prev) => prev.map((d, i) => (i === slot ? null : d)));
    if (fileInputs.current[slot]) fileInputs.current[slot]!.value = '';
    if (doc) await removeKycDoc(doc.path);
  };

  const handleSubmit = async () => {
    if (!user) { router.push('/auth/signin'); return; }
    if (!form.categoryId) { toast.error('Pick the service you offer'); return; }
    if (!form.businessName.trim()) { toast.error('Add the name customers will see'); return; }
    if (!form.city.trim()) { toast.error('Add the city you work in'); return; }
    if (!docs[0]) { toast.error('Upload a photo ID — it\'s how we verify you'); return; }

    setSubmitting(true);
    const result = await submitApplication({
      categoryId: form.categoryId,
      businessName: form.businessName.trim(),
      bio: form.bio.trim(),
      experienceYears: Number(form.experience) || 0,
      hourlyRate: Number(form.hourlyRate) || 0,
      city: form.city.trim(),
      state: profile?.state ?? 'Maharashtra',
      area: form.area.trim(),
      documents: docs.filter((d): d is KycDocument => d != null),
    });
    setSubmitting(false);

    if ('error' in result) { toast.error(result.error); return; }
    setApplication(result.data);
    prefill(result.data);
    setEditing(false);
    toast.success('Application submitted — we\'ll review it within 24–48 hours.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (authLoading || loading) {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Loading…</div>;
  }

  // ---------------------------------------------------------------- status screens
  // Driven entirely by the row the server wrote. No optimistic "submitted!" state.
  if (application && !editing) {
    const { status, kyc_status } = application;

    if (status === 'approved') {
      return (
        <StatusShell
          icon={<CheckCircle className="w-12 h-12 text-[#138808]" />}
          tone="#138808"
          title="You're live."
          body="Your profile is verified and customers can book you now."
        >
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href={`/providers/${application.id}`} className="saffron-btn px-6 py-3 rounded-xl font-semibold text-sm">
              View my public profile
            </Link>
            <Link href="/bookings" className="px-6 py-3 rounded-xl border border-[#2a2a2a] text-sm text-gray-300 hover:text-white transition-colors">
              Go to my bookings
            </Link>
          </div>
        </StatusShell>
      );
    }

    if (status === 'rejected' || kyc_status === 'rejected') {
      return (
        <StatusShell
          icon={<AlertTriangle className="w-12 h-12 text-orange-400" />}
          tone="#fb923c"
          title="Your application needs changes"
          body="Fix the point below and resubmit — everything you entered is saved."
        >
          <div className="bg-[#161616] border border-orange-500/25 rounded-xl p-4 text-left mb-6">
            <p className="text-xs uppercase tracking-wide text-orange-400/80 mb-1.5">Reason</p>
            <p className="text-sm text-gray-200">
              {application.rejection_reason?.trim() || 'No reason was recorded. Please review your details and documents, then resubmit.'}
            </p>
          </div>
          <button onClick={() => setEditing(true)} className="saffron-btn px-6 py-3 rounded-xl font-semibold text-sm">
            Fix and resubmit
          </button>
        </StatusShell>
      );
    }

    if (status === 'suspended') {
      return (
        <StatusShell
          icon={<Ban className="w-12 h-12 text-red-400" />}
          tone="#f87171"
          title="Your profile is suspended"
          body="You can't take bookings right now. Reply to the email we sent, or contact support to sort it out."
        />
      );
    }

    // pending — the honest default
    return (
      <StatusShell
        icon={<Clock className="w-12 h-12 text-[#FF9933]" />}
        tone="#FF9933"
        title="Submitted — reviewed within 24–48 hours"
        body="A person checks every application and your ID before a profile goes live. We'll notify you the moment it's decided."
      >
        <div className="bg-[#161616] border border-[#2a2a2a] rounded-xl p-4 text-left mb-6 space-y-2">
          <Row label="Name" value={application.business_name} />
          <Row label="Service area" value={[application.address, application.city].filter(Boolean).join(', ') || null} />
          <Row label="Rate" value={application.hourly_rate ? `₹${application.hourly_rate}/hr` : null} />
          <Row label="Documents" value={`${(application.kyc_documents ?? []).length} uploaded`} />
          <Row
            label="Submitted"
            value={application.applied_at ? new Date(application.applied_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null}
          />
        </div>
        <button onClick={() => setEditing(true)} className="px-6 py-3 rounded-xl border border-[#2a2a2a] text-sm text-gray-300 hover:text-white transition-colors">
          Edit my application
        </button>
      </StatusShell>
    );
  }

  // ---------------------------------------------------------------- the application form
  const bioLeft = BIO_MAX - form.bio.length;

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-16">
      <section className="relative py-14 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-0 w-96 h-96 bg-[#FF9933]/8 rounded-full blur-[100px]" />
          <div className="absolute bottom-0 right-0 w-96 h-96 bg-[#138808]/8 rounded-full blur-[100px]" />
        </div>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 text-center relative">
          <h1 className="text-3xl sm:text-4xl font-black text-white mb-4">
            Work for yourself,<br /><span className="text-[#FF9933]">on your own reputation</span>
          </h1>
          <p className="text-gray-400 mb-6">
            One short application. We verify your ID, then your profile goes live and the reviews you earn stay yours.
          </p>
          <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
            <ShieldCheck className="w-4 h-4 text-[#138808]" />
            Takes about 3 minutes · No joining fee
          </div>
        </div>
      </section>

      <section className="pb-20 max-w-2xl mx-auto px-4 sm:px-6">
        {editing && (
          <button
            onClick={() => { if (application) prefill(application); setEditing(false); }}
            className="text-sm text-gray-400 hover:text-white mb-4 transition-colors"
          >
            ← Back to status
          </button>
        )}

        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6 sm:p-8 space-y-6">
          {/* Category */}
          <Field label="What do you do?" required>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setForm({ ...form, categoryId: cat.id })}
                  className={`px-3 py-2.5 rounded-xl border text-xs font-medium text-left transition-all ${
                    form.categoryId === cat.id
                      ? 'border-[#FF9933]/60 bg-[#FF9933]/10 text-white'
                      : 'border-[#2a2a2a] bg-[#1e1e1e] text-gray-400 hover:border-[#FF9933]/40'
                  }`}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </Field>

          {/* Name */}
          <Field label="Name customers will see" required>
            <input
              value={form.businessName}
              onChange={(e) => setForm({ ...form, businessName: e.target.value })}
              className={inputClass}
              placeholder="e.g. Ramesh Electricals"
            />
          </Field>

          {/* Where */}
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="City" required>
              <input
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                className={inputClass}
                placeholder="Mumbai"
              />
            </Field>
            <Field label="Area you cover">
              <input
                value={form.area}
                onChange={(e) => setForm({ ...form, area: e.target.value })}
                className={inputClass}
                placeholder="Andheri, Bandra"
              />
            </Field>
          </div>

          {/* Money + experience */}
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Your hourly rate (₹)">
              <input
                type="number"
                inputMode="numeric"
                value={form.hourlyRate}
                onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
                className={inputClass}
                placeholder="300"
              />
            </Field>
            <Field label="Years of experience">
              <input
                type="number"
                inputMode="numeric"
                value={form.experience}
                onChange={(e) => setForm({ ...form, experience: e.target.value })}
                className={inputClass}
                placeholder="5"
              />
            </Field>
          </div>

          {/* Bio */}
          <Field label="A line about your work">
            <textarea
              value={form.bio}
              onChange={(e) => setForm({ ...form, bio: e.target.value.slice(0, BIO_MAX) })}
              rows={3}
              className={`${inputClass} resize-none`}
              placeholder="What you do, and what you're good at."
            />
            <p className="text-xs text-gray-600 mt-1.5 text-right">{bioLeft} characters left</p>
          </Field>

          {/* Documents */}
          <Field label="Proof of identity" required>
            <div className="space-y-2">
              {KYC_SLOTS.map((slot, i) => {
                const doc = docs[i];
                return (
                  <div key={slot.key}>
                    <input
                      ref={(el) => { fileInputs.current[i] = el; }}
                      type="file"
                      accept={KYC_ACCEPT}
                      className="hidden"
                      onChange={(e) => handleFile(i, e.target.files?.[0])}
                    />
                    {doc ? (
                      <div className="flex items-center gap-3 bg-[#1e1e1e] border border-[#138808]/30 rounded-xl px-4 py-3">
                        <FileText className="w-4 h-4 text-[#138808] flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate">{doc.name ?? slot.key}</p>
                          <p className="text-xs text-gray-500">{slot.key} · uploaded</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => clearDoc(i)}
                          className="text-gray-500 hover:text-red-400 transition-colors flex-shrink-0"
                          aria-label={`Remove ${slot.key}`}
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputs.current[i]?.click()}
                        disabled={uploadingSlot === i}
                        className="w-full flex items-center gap-3 bg-[#1e1e1e] border border-dashed border-[#2a2a2a] hover:border-[#FF9933]/40 rounded-xl px-4 py-3 text-left transition-all disabled:opacity-60"
                      >
                        {uploadingSlot === i
                          ? <Loader2 className="w-4 h-4 text-[#FF9933] animate-spin flex-shrink-0" />
                          : <Upload className="w-4 h-4 text-gray-500 flex-shrink-0" />}
                        <div className="min-w-0">
                          <p className="text-sm text-gray-300">
                            {slot.key}{slot.required ? '' : ' (optional)'}
                          </p>
                          <p className="text-xs text-gray-600">{slot.hint}</p>
                        </div>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-gray-600 mt-2">
              Photo or PDF, up to 10 MB. Stored privately — only you and our verification team can open it, never customers.
            </p>
          </Field>

          <button
            onClick={handleSubmit}
            disabled={submitting || uploadingSlot !== null}
            className="saffron-btn w-full rounded-xl py-3.5 font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {submitting
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>
              : user ? (application ? 'Resubmit application' : 'Submit application') : 'Sign in to apply'}
          </button>
          <p className="text-xs text-gray-600 text-center -mt-2">
            A person reviews every application, usually within 24–48 hours.
          </p>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ small presentational bits */

const inputClass =
  'w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-[#FF9933]';

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-gray-300 mb-2 font-medium">
        {label}{required && <span className="text-[#FF9933]"> *</span>}
      </label>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-200 text-right">{value}</span>
    </div>
  );
}

function StatusShell({
  icon, tone, title, body, children,
}: {
  icon: React.ReactNode; tone: string; title: string; body: string; children?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center px-4">
      <div className="text-center max-w-lg w-full py-16">
        <div
          className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 border-2"
          style={{ backgroundColor: `${tone}1a`, borderColor: `${tone}4d` }}
        >
          {icon}
        </div>
        <h2 className="text-2xl sm:text-3xl font-black text-white mb-3">{title}</h2>
        <p className="text-gray-400 mb-8">{body}</p>
        {children}
      </div>
    </div>
  );
}
