'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  CheckCircle, Clock, AlertTriangle, ShieldCheck, Upload, X, FileText, Loader2, Ban,
  Download, Briefcase, Plus, BadgeCheck, Handshake,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import {
  fetchMyApplication, submitApplication, uploadKycDoc, removeKycDoc,
  fetchCategoryRequirements, fetchDocumentChecklist, recordDocument, requestDigiLocker,
  fetchExperience, addExperience, removeExperience, requestEpfoHistory, verifiedYears,
  KYC_ACCEPT, type MyApplication,
} from '@/lib/provider-application';
import { fetchMyPricing, saveMyPricing } from '@/lib/bargaining';
import type {
  KycDocument, CategoryKycRequirement, DocumentChecklistItem, ProviderExperience,
  ProviderPricing,
} from '@/lib/supabase';
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
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(emptyForm);

  // Step 9.5: which documents this category asks for, driven by data
  const [requirements, setRequirements] = useState<CategoryKycRequirement[]>([]);
  const [pendingFiles, setPendingFiles] = useState<Record<string, KycDocument>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<DocumentChecklistItem[]>([]);
  const [experience, setExperience] = useState<ProviderExperience[]>([]);
  const [expForm, setExpForm] = useState({ employer: '', role: '', from: '', to: '' });
  const [submitting, setSubmitting] = useState(false);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase.from('service_categories').select('id, name, slug').order('name');
      if (active) setCategories((data ?? []) as CategoryRow[]);
    })();
    return () => { active = false; };
  }, []);

  // The document slots follow the chosen category — a plumber sees two, a driver sees five.
  useEffect(() => {
    if (!form.categoryId) { setRequirements([]); return; }
    let active = true;
    (async () => {
      const reqs = await fetchCategoryRequirements(form.categoryId);
      if (active) setRequirements(reqs);
    })();
    return () => { active = false; };
  }, [form.categoryId]);

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
  }, []);

  const refreshProviderState = useCallback(async (providerId: string) => {
    const [list, exp] = await Promise.all([fetchDocumentChecklist(providerId), fetchExperience(providerId)]);
    setChecklist(list);
    setExperience(exp);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setLoading(false); return; }
    let active = true;
    (async () => {
      const row = await fetchMyApplication();
      if (!active) return;
      setApplication(row);
      if (row) { prefill(row); await refreshProviderState(row.id); }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [user, authLoading, prefill, refreshProviderState]);

  // ── uploads ────────────────────────────────────────────────────────────────
  // Before the row exists we park files in storage and record them right after submit; once it
  // exists we record immediately.
  const handleFile = async (docCode: string, label: string, file: File | undefined) => {
    if (!file) return;
    setUploading(docCode);
    const result = await uploadKycDoc(file, label);
    if ('error' in result) { setUploading(null); toast.error(result.error); return; }

    if (application) {
      const rec = await recordDocument({ docCode, filePath: result.data.path });
      setUploading(null);
      if ('error' in rec) { toast.error(rec.error); return; }
      await refreshProviderState(application.id);
      toast.success(`${label} uploaded — our team will check it.`);
    } else {
      const replaced = pendingFiles[docCode];
      setPendingFiles((prev) => ({ ...prev, [docCode]: result.data }));
      setUploading(null);
      if (replaced) await removeKycDoc(replaced.path);
    }
  };

  const clearPending = async (docCode: string) => {
    const doc = pendingFiles[docCode];
    setPendingFiles((prev) => { const next = { ...prev }; delete next[docCode]; return next; });
    if (fileInputs.current[docCode]) fileInputs.current[docCode]!.value = '';
    if (doc) await removeKycDoc(doc.path);
  };

  const tryDigiLocker = async (docCode: string) => {
    const res = await requestDigiLocker(docCode);
    toast.info(res.message);
  };

  // ── submit ─────────────────────────────────────────────────────────────────
  const requiredDocs = requirements.filter((r) => r.requirement === 'required');
  const badgeDocs = requirements.filter((r) => r.requirement === 'badge');

  const handleSubmit = async () => {
    if (!user) { router.push('/auth/signin'); return; }
    if (!form.categoryId) { toast.error('Pick the service you offer'); return; }
    if (!form.businessName.trim()) { toast.error('Add the name customers will see'); return; }
    if (!form.city.trim()) { toast.error('Add the city you work in'); return; }
    const missing = requiredDocs.filter((r) => !pendingFiles[r.doc_code] && !application);
    if (missing.length) {
      toast.error(`Still needed: ${missing.map((m) => m.kyc_document_types?.label ?? m.doc_code).join(', ')}`);
      return;
    }

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
      documents: Object.values(pendingFiles),
    });
    if ('error' in result) { setSubmitting(false); toast.error(result.error); return; }

    // now that the row exists, record each parked file as a typed document
    for (const [docCode, doc] of Object.entries(pendingFiles)) {
      const rec = await recordDocument({ docCode, filePath: doc.path });
      if ('error' in rec) toast.error(`${docCode}: ${rec.error}`);
    }
    setPendingFiles({});
    setApplication(result.data);
    prefill(result.data);
    await refreshProviderState(result.data.id);
    setSubmitting(false);
    setEditing(false);
    toast.success('Application submitted — we\'ll review it within 24–48 hours.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleAddExperience = async () => {
    if (!expForm.employer.trim()) { toast.error('Add the employer name'); return; }
    const res = await addExperience({
      employerName: expForm.employer.trim(), role: expForm.role.trim() || undefined,
      fromDate: expForm.from || null, toDate: expForm.to || null,
    });
    if ('error' in res) { toast.error(res.error); return; }
    setExpForm({ employer: '', role: '', from: '', to: '' });
    if (application) await refreshProviderState(application.id);
    toast.success('Added — our team will verify it.');
  };

  if (authLoading || loading) {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Loading…</div>;
  }

  // ──────────────────────────────────────────────────────── status screens
  if (application && !editing) {
    const { status, kyc_status } = application;

    if (status === 'approved') {
      return (
        <StatusShell icon={<CheckCircle className="w-12 h-12 text-[#138808]" />} tone="#138808"
          title="You're live." body="Your profile is verified and customers can book you now.">
          <div className="flex flex-col sm:flex-row gap-3 justify-center mb-8">
            <Link href={`/providers/${application.id}`} className="saffron-btn px-6 py-3 rounded-xl font-semibold text-sm">
              View my public profile
            </Link>
            <Link href="/bookings" className="px-6 py-3 rounded-xl border border-[#2a2a2a] text-sm text-gray-300 hover:text-white transition-colors">
              Go to my bookings
            </Link>
          </div>
          {/* Step 10: only an approved provider can be booked, so only they can be haggled with —
              start_negotiation refuses anyone else. */}
          <PricingSection providerId={application.id} />
          <DocumentSection checklist={checklist} uploading={uploading} fileInputs={fileInputs}
            onFile={handleFile} onDigiLocker={tryDigiLocker} />
          <ExperienceSection rows={experience} form={expForm} setForm={setExpForm}
            onAdd={handleAddExperience}
            onRemove={async (id) => { await removeExperience(id); if (application) refreshProviderState(application.id); }} />
        </StatusShell>
      );
    }

    if (status === 'rejected' || kyc_status === 'rejected') {
      return (
        <StatusShell icon={<AlertTriangle className="w-12 h-12 text-orange-400" />} tone="#fb923c"
          title="Your application needs changes"
          body="Fix the point below and resubmit — everything you entered is saved.">
          <div className="bg-[#161616] border border-orange-500/25 rounded-xl p-4 text-left mb-6">
            <p className="text-xs uppercase tracking-wide text-orange-400/80 mb-1.5">Reason</p>
            <p className="text-sm text-gray-200">
              {application.rejection_reason?.trim() || 'No reason was recorded. Please review your details and documents, then resubmit.'}
            </p>
          </div>
          <button onClick={() => setEditing(true)} className="saffron-btn px-6 py-3 rounded-xl font-semibold text-sm mb-8">
            Fix and resubmit
          </button>
          <DocumentSection checklist={checklist} uploading={uploading} fileInputs={fileInputs}
            onFile={handleFile} onDigiLocker={tryDigiLocker} />
        </StatusShell>
      );
    }

    if (status === 'suspended') {
      return (
        <StatusShell icon={<Ban className="w-12 h-12 text-red-400" />} tone="#f87171"
          title="Your profile is suspended"
          body="You can't take bookings right now. Reply to the email we sent, or contact support to sort it out." />
      );
    }

    const missingCount = checklist.filter(
      (c) => c.requirement === 'required' && c.verification_status !== 'verified').length;

    return (
      <StatusShell icon={<Clock className="w-12 h-12 text-[#FF9933]" />} tone="#FF9933"
        title="Submitted — reviewed within 24–48 hours"
        body={missingCount > 0
          ? 'We still need a few documents before we can review your application.'
          : 'A person checks every application and your ID before a profile goes live. We\'ll notify you the moment it\'s decided.'}>
        <div className="bg-[#161616] border border-[#2a2a2a] rounded-xl p-4 text-left mb-6 space-y-2">
          <Row label="Name" value={application.business_name} />
          <Row label="Service area" value={[application.address, application.city].filter(Boolean).join(', ') || null} />
          <Row label="Rate" value={application.hourly_rate ? `₹${application.hourly_rate}/hr` : null} />
          <Row label="Submitted" value={application.applied_at
            ? new Date(application.applied_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
            : null} />
        </div>
        <button onClick={() => setEditing(true)}
          className="px-6 py-3 rounded-xl border border-[#2a2a2a] text-sm text-gray-300 hover:text-white transition-colors mb-8">
          Edit my details
        </button>
        <DocumentSection checklist={checklist} uploading={uploading} fileInputs={fileInputs}
          onFile={handleFile} onDigiLocker={tryDigiLocker} />
        <ExperienceSection rows={experience} form={expForm} setForm={setExpForm}
          onAdd={handleAddExperience}
          onRemove={async (id) => { await removeExperience(id); if (application) refreshProviderState(application.id); }} />
      </StatusShell>
    );
  }

  // ──────────────────────────────────────────────────────── the application form
  const bioLeft = BIO_MAX - form.bio.length;

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
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

      {/* The hero above stays max-w-2xl on purpose — it is centred marketing copy
          and reads better narrow. The form does not: at max-w-2xl the 24-item
          category grid was crammed into 3 columns with ~380px of dead space
          either side on a desktop screen. */}
      <section className="pb-20 max-w-4xl mx-auto px-4 sm:px-6">
        {editing && (
          <button onClick={() => { if (application) prefill(application); setEditing(false); }}
            className="text-sm text-gray-400 hover:text-white mb-4 transition-colors">
            ← Back to status
          </button>
        )}

        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6 sm:p-8 space-y-6">
          <Field label="What do you do?" required>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {categories.map((cat) => (
                <button key={cat.id} type="button"
                  onClick={() => setForm({ ...form, categoryId: cat.id })}
                  className={`px-3 py-2.5 rounded-xl border text-xs font-medium text-left transition-all ${
                    form.categoryId === cat.id
                      ? 'border-[#FF9933]/60 bg-[#FF9933]/10 text-white'
                      : 'border-[#2a2a2a] bg-[#1e1e1e] text-gray-400 hover:border-[#FF9933]/40'
                  }`}>
                  {cat.name}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Name customers will see" required>
            <input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })}
              className={inputClass} placeholder="e.g. Ramesh Electricals" />
          </Field>

          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="City" required>
              <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })}
                className={inputClass} placeholder="Mumbai" />
            </Field>
            <Field label="Area you cover">
              <input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })}
                className={inputClass} placeholder="Andheri, Bandra" />
            </Field>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Your hourly rate (₹)">
              <input type="number" inputMode="numeric" value={form.hourlyRate}
                onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
                className={inputClass} placeholder="300" />
            </Field>
            <Field label="Years of experience">
              <input type="number" inputMode="numeric" value={form.experience}
                onChange={(e) => setForm({ ...form, experience: e.target.value })}
                className={inputClass} placeholder="5" />
            </Field>
          </div>

          <Field label="A line about your work">
            <textarea value={form.bio}
              onChange={(e) => setForm({ ...form, bio: e.target.value.slice(0, BIO_MAX) })}
              rows={3} className={`${inputClass} resize-none`}
              placeholder="What you do, and what you're good at." />
            <p className="text-xs text-gray-600 mt-1.5 text-right">{bioLeft} characters left</p>
          </Field>

          {/* Documents — driven by the chosen category */}
          {form.categoryId && (
            <Field label="Proof of identity" required>
              <div className="space-y-2">
                {requiredDocs.map((req) => {
                  const t = req.kyc_document_types;
                  const label = t?.label ?? req.doc_code;
                  const doc = pendingFiles[req.doc_code];
                  return (
                    <div key={req.doc_code}>
                      <input ref={(el) => { fileInputs.current[req.doc_code] = el; }} type="file"
                        accept={KYC_ACCEPT} className="hidden"
                        onChange={(e) => handleFile(req.doc_code, label, e.target.files?.[0])} />
                      {doc ? (
                        <div className="flex items-center gap-3 bg-[#1e1e1e] border border-[#138808]/30 rounded-xl px-4 py-3">
                          <FileText className="w-4 h-4 text-[#138808] flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white truncate">{doc.name ?? label}</p>
                            <p className="text-xs text-gray-500">{label} · ready to submit</p>
                          </div>
                          <button type="button" onClick={() => clearPending(req.doc_code)}
                            className="text-gray-500 hover:text-red-400 transition-colors" aria-label={`Remove ${label}`}>
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="bg-[#1e1e1e] border border-dashed border-[#2a2a2a] rounded-xl px-4 py-3">
                          <p className="text-sm text-gray-300">{label}</p>
                          {t?.description && <p className="text-xs text-gray-600 mb-2">{t.description}</p>}
                          <div className="flex gap-2 mt-2">
                            {t?.capture_method === 'digilocker' && (
                              <button type="button" onClick={() => tryDigiLocker(req.doc_code)}
                                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-[#FF9933]/10 border border-[#FF9933]/30 text-[#FF9933] hover:bg-[#FF9933]/20 transition-all">
                                <Download className="w-3.5 h-3.5" /> Fetch from DigiLocker
                              </button>
                            )}
                            <button type="button" onClick={() => fileInputs.current[req.doc_code]?.click()}
                              disabled={uploading === req.doc_code}
                              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-[#2a2a2a] text-gray-400 hover:text-white transition-all disabled:opacity-60">
                              {uploading === req.doc_code
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <Upload className="w-3.5 h-3.5" />}
                              {t?.capture_method === 'digilocker' ? 'or upload' : 'Upload'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-gray-600 mt-2">
                Photo or PDF, up to 10 MB. Stored privately — only you and our verification team can open it, never customers.
              </p>
            </Field>
          )}

          {/* Optional badges for this category */}
          {badgeDocs.length > 0 && (
            <div className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl p-4">
              <p className="text-sm font-medium text-gray-200 mb-1 flex items-center gap-2">
                <BadgeCheck className="w-4 h-4 text-[#138808]" /> Optional — unlocks more work
              </p>
              {badgeDocs.map((b) => (
                <p key={b.doc_code} className="text-xs text-gray-500 mt-1">
                  <span className="text-gray-300">{b.kyc_document_types?.label}</span>
                  {b.note ? ` — ${b.note}` : ''}
                </p>
              ))}
              <p className="text-xs text-gray-600 mt-2">You can add these later, from your status page.</p>
            </div>
          )}

          <button onClick={handleSubmit} disabled={submitting || uploading !== null}
            className="saffron-btn w-full rounded-xl py-3.5 font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
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

/* ────────────────────────────────────────────────── presentational bits */

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

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  verified: { label: 'Verified', cls: 'bg-[#138808]/10 text-[#138808]' },
  pending:  { label: 'In review', cls: 'bg-[#FF9933]/10 text-[#FF9933]' },
  rejected: { label: 'Rejected', cls: 'bg-red-900/20 text-red-400' },
  expired:  { label: 'Expired', cls: 'bg-red-900/20 text-red-400' },
};

function DocumentSection({ checklist, uploading, fileInputs, onFile, onDigiLocker }: {
  checklist: DocumentChecklistItem[];
  uploading: string | null;
  fileInputs: React.MutableRefObject<Record<string, HTMLInputElement | null>>;
  onFile: (docCode: string, label: string, file: File | undefined) => void;
  onDigiLocker: (docCode: string) => void;
}) {
  if (checklist.length === 0) return null;
  const required = checklist.filter((c) => c.requirement === 'required');
  const badges = checklist.filter((c) => c.requirement === 'badge');

  const renderRow = (item: DocumentChecklistItem, optional: boolean) => {
    const chip = item.verification_status ? STATUS_CHIP[item.verification_status] : null;
    const needsAction = !item.verification_status
      || item.verification_status === 'rejected' || item.verification_status === 'expired';
    return (
      <div key={item.doc_code} className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 text-left">
        <div className="flex items-center gap-3">
          <FileText className={`w-4 h-4 flex-shrink-0 ${item.verification_status === 'verified' ? 'text-[#138808]' : 'text-gray-500'}`} />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white">{item.label}</p>
            {item.note && <p className="text-xs text-gray-500 mt-0.5">{item.note}</p>}
            {!item.note && item.description && <p className="text-xs text-gray-600 mt-0.5">{item.description}</p>}
            {item.expires_at && (
              <p className="text-xs text-gray-600 mt-0.5">Valid to {new Date(item.expires_at).toLocaleDateString('en-IN')}</p>
            )}
          </div>
          {chip
            ? <span className={`text-xs px-2.5 py-1 rounded-full font-medium flex-shrink-0 ${chip.cls}`}>{chip.label}</span>
            : <span className="text-xs px-2.5 py-1 rounded-full font-medium bg-gray-800 text-gray-400 flex-shrink-0">{optional ? 'Not added' : 'Needed'}</span>}
        </div>
        {needsAction && (
          <div className="flex gap-2 mt-3">
            <input ref={(el) => { fileInputs.current[item.doc_code] = el; }} type="file"
              accept={KYC_ACCEPT} className="hidden"
              onChange={(e) => onFile(item.doc_code, item.label, e.target.files?.[0])} />
            {item.capture_method === 'digilocker' && (
              <button type="button" onClick={() => onDigiLocker(item.doc_code)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-[#FF9933]/10 border border-[#FF9933]/30 text-[#FF9933] hover:bg-[#FF9933]/20 transition-all">
                <Download className="w-3.5 h-3.5" /> DigiLocker
              </button>
            )}
            <button type="button" onClick={() => fileInputs.current[item.doc_code]?.click()}
              disabled={uploading === item.doc_code}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-[#2a2a2a] text-gray-400 hover:text-white transition-all disabled:opacity-60">
              {uploading === item.doc_code ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              Upload
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="text-left mt-8">
      <h3 className="font-bold text-white mb-3 flex items-center gap-2">
        <FileText className="w-4 h-4 text-[#FF9933]" /> Your documents
      </h3>
      <div className="space-y-2">{required.map((i) => renderRow(i, false))}</div>
      {badges.length > 0 && (
        <>
          <h4 className="font-semibold text-gray-300 text-sm mt-6 mb-2 flex items-center gap-2">
            <BadgeCheck className="w-4 h-4 text-[#138808]" /> Optional — unlocks more work
          </h4>
          <div className="space-y-2">{badges.map((i) => renderRow(i, true))}</div>
        </>
      )}
    </div>
  );
}

function ExperienceSection({ rows, form, setForm, onAdd, onRemove }: {
  rows: ProviderExperience[];
  form: { employer: string; role: string; from: string; to: string };
  setForm: (f: { employer: string; role: string; from: string; to: string }) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const [uan, setUan] = useState('');
  const years = verifiedYears(rows);
  return (
    <div className="text-left mt-8">
      <h3 className="font-bold text-white mb-1 flex items-center gap-2">
        <Briefcase className="w-4 h-4 text-[#FF9933]" /> Your work history
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Shown on your profile so customers know your background. It doesn&apos;t affect your rating —
        that&apos;s earned from jobs you complete here.
      </p>

      {years > 0 && (
        <p className="text-sm text-[#138808] font-medium mb-3">{years} yrs verified experience</p>
      )}

      <div className="space-y-2 mb-4">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-3 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white truncate">
                {r.employer_name}{r.role ? ` · ${r.role}` : ''}
              </p>
              <p className="text-xs text-gray-500">
                {r.from_date ? new Date(r.from_date).getFullYear() : '—'} – {r.to_date ? new Date(r.to_date).getFullYear() : 'present'}
                {r.verified ? ` · verified (${r.source})` : ' · self-declared'}
              </p>
            </div>
            {r.verified
              ? <CheckCircle className="w-4 h-4 text-[#138808] flex-shrink-0" />
              : <button onClick={() => onRemove(r.id)} className="text-gray-500 hover:text-red-400 flex-shrink-0"><X className="w-4 h-4" /></button>}
          </div>
        ))}
      </div>

      <div className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl p-4 space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <input value={form.employer} onChange={(e) => setForm({ ...form, employer: e.target.value })}
            className={inputClass} placeholder="Employer / company" />
          <input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
            className={inputClass} placeholder="Role (optional)" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} className={inputClass} />
          <input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} className={inputClass} />
        </div>
        <button onClick={onAdd}
          className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-[#2a2a2a] text-gray-300 hover:text-white transition-all">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
        <div className="pt-3 border-t border-[#2a2a2a]">
          <p className="text-xs text-gray-500 mb-2">
            Worked somewhere that paid PF? Verify it instantly from your EPFO record.
          </p>
          <div className="flex gap-2">
            <input value={uan} onChange={(e) => setUan(e.target.value)}
              className={`${inputClass} flex-1`} placeholder="UAN number" />
            <button
              onClick={async () => { const r = await requestEpfoHistory(uan); toast.info(r.message); }}
              className="text-xs px-3 py-2 rounded-lg bg-[#FF9933]/10 border border-[#FF9933]/30 text-[#FF9933] whitespace-nowrap">
              Verify with EPFO
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Step 10: the provider's own pricing. The FLOOR is the sensitive one — it has no select grant
   on service_providers and is readable only here, through my_provider_profile (filtered to
   auth.uid()). Customers never see it, and no RPC returns it. */
function PricingSection({ providerId }: { providerId: string }) {
  const [pricing, setPricing] = useState<ProviderPricing | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => { const p = await fetchMyPricing(); if (active) setPricing(p); })();
    return () => { active = false; };
  }, []);

  if (!pricing) return null;
  const negotiable = pricing.pricing_mode === 'negotiable';
  const set = (patch: Partial<ProviderPricing>) => setPricing({ ...pricing, ...patch });
  const num = (v: string) => (v === '' ? null : Number(v));

  const save = async () => {
    if (pricing.floor_price != null && pricing.list_price != null && pricing.floor_price > pricing.list_price) {
      toast.error('Your minimum can’t be above your listed price.'); return;
    }
    if (pricing.auto_accept_threshold != null && pricing.floor_price != null
        && pricing.auto_accept_threshold < pricing.floor_price) {
      toast.error('Instant-accept can’t be below your minimum.'); return;
    }
    setSaving(true);
    const res = await saveMyPricing(providerId, pricing);
    setSaving(false);
    if ('error' in res) { toast.error(res.error); return; }
    toast.success('Pricing saved.');
  };

  return (
    <div className="text-left mt-8">
      <h3 className="font-bold text-white mb-1 flex items-center gap-2">
        <Handshake className="w-4 h-4 text-[#FF9933]" /> Your pricing
      </h3>
      <p className="text-xs text-gray-500 mb-3">
        Let customers offer a price, or keep it fixed. You stay in control — nothing is agreed
        without you accepting it.
      </p>

      <div className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl p-4 space-y-3">
        <div className="flex gap-2">
          {(['fixed', 'negotiable'] as const).map((m) => (
            <button key={m} type="button" onClick={() => set({ pricing_mode: m })}
              className={`flex-1 py-2.5 rounded-xl text-xs font-medium capitalize transition-all ${
                pricing.pricing_mode === m
                  ? 'bg-[#FF9933] text-white'
                  : 'bg-[#161616] border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/40'
              }`}>
              {m === 'fixed' ? 'Fixed price' : 'Open to offers'}
            </button>
          ))}
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1">Your listed price (₹/hr)</label>
          <input type="number" inputMode="numeric" value={pricing.list_price ?? ''}
            onChange={(e) => set({ list_price: num(e.target.value) })}
            className={inputClass} placeholder="600" />
        </div>

        {negotiable && (
          <>
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Accept instantly at or above (₹)
              </label>
              <input type="number" inputMode="numeric" value={pricing.auto_accept_threshold ?? ''}
                onChange={(e) => set({ auto_accept_threshold: num(e.target.value) })}
                className={inputClass} placeholder="550" />
              <p className="text-xs text-gray-600 mt-1">Offers this high are accepted for you, straight away.</p>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Your minimum — never shown to anyone (₹)
              </label>
              <input type="number" inputMode="numeric" value={pricing.floor_price ?? ''}
                onChange={(e) => set({ floor_price: num(e.target.value) })}
                className={inputClass} placeholder="400" />
              <p className="text-xs text-gray-600 mt-1">
                Anything below this is declined automatically. Customers are never told what it is,
                or how close they were.
              </p>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Counter rounds allowed</label>
              <input type="number" inputMode="numeric" value={pricing.max_counter_rounds}
                onChange={(e) => set({ max_counter_rounds: Number(e.target.value) || 3 })}
                className={inputClass} placeholder="3" />
            </div>
          </>
        )}

        <button onClick={save} disabled={saving}
          className="saffron-btn w-full rounded-xl py-2.5 font-semibold text-sm disabled:opacity-60">
          {saving ? 'Saving…' : 'Save pricing'}
        </button>
      </div>
    </div>
  );
}

function StatusShell({ icon, tone, title, body, children }: {
  icon: React.ReactNode; tone: string; title: string; body: string; children?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-start justify-center px-4">
      {/* Widened from max-w-lg: `children` here is the document checklist,
          experience and pricing sections, which were squeezed into the same
          512px column as the one-line status text. text-center is kept on the
          wrapper — the status buttons below are inline and rely on inheriting
          it — and the body copy is capped so the prose line stays readable. */}
      <div className="text-center max-w-3xl w-full py-16">
        <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 border-2"
          style={{ backgroundColor: `${tone}1a`, borderColor: `${tone}4d` }}>
          {icon}
        </div>
        <h2 className="text-2xl sm:text-3xl font-black text-white mb-3">{title}</h2>
        <p className="text-gray-400 mb-8 max-w-lg mx-auto">{body}</p>
        {children}
      </div>
    </div>
  );
}
