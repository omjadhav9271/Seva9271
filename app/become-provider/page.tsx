'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  CheckCircle, Clock, AlertTriangle, ShieldCheck, Upload, X, FileText, Loader2, Ban,
  Download, Briefcase, Plus, BadgeCheck, Handshake, Camera, IdCard, MapPin, Search,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import {
  fetchMyApplication, submitApplication, uploadKycDoc, removeKycDoc,
  fetchCategoryRequirements, fetchDocumentChecklist, recordDocument, requestDigiLocker,
  fetchExperience, addExperience, removeExperience, requestEpfoHistory, verifiedYears,
  KYC_ACCEPT, ID_OPTIONS_FOR, idTypeLabel, type MyApplication,
} from '@/lib/provider-application';
import { fetchMyPricing, saveMyPricing } from '@/lib/bargaining';
import { geocodeAddress, setServiceBase, type GeocodeHit } from '@/lib/matching';
import TrustTierBadge from '@/components/trust-tier-badge';
import LiveSelfieCapture from '@/components/live-selfie-capture';
import type {
  KycDocument, CategoryKycRequirement, DocumentChecklistItem, ProviderExperience,
  ProviderPricing, CaptureMethod,
} from '@/lib/supabase';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';

type CategoryRow = { id: string; name: string; slug: string };

/** Step 11 — a provider's static service base. Coordinates are the provider's OWN data here; they
 *  are never sent to a customer, who only ever receives a distance. */
type BasePoint = { lat: number; lng: number; label: string };

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
  // Bucket C: what each pending file IS (id_type / live-vs-fallback capture). Parked alongside
  // the file until the provider row exists, then written onto the document row.
  const [pendingMeta, setPendingMeta] = useState<Record<string, Record<string, unknown>>>({});
  // Which government ID the applicant says they're supplying, per slot.
  const [idTypes, setIdTypes] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<DocumentChecklistItem[]>([]);
  const [experience, setExperience] = useState<ProviderExperience[]>([]);
  const [expForm, setExpForm] = useState({ employer: '', role: '', from: '', to: '' });
  const [submitting, setSubmitting] = useState(false);
  /* Step 11 — the STATIC service base. A typed address geocoded to a point, NOT the device's live
     position: a provider isn't always standing at their base, and the base is what ranking needs
     (live position is Step-15 tracking). Held here until the provider row exists, then written by
     set_provider_service_base. */
  const [basePoint, setBasePoint] = useState<BasePoint | null>(null);

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
    setBasePoint(
      row.latitude != null && row.longitude != null
        ? { lat: Number(row.latitude), lng: Number(row.longitude), label: [row.address, row.city].filter(Boolean).join(', ') || 'Saved location' }
        : null,
    );
  }, []);

  // Used by the status screens, where the row already exists: write the base immediately instead
  // of pushing the provider back through submit (which would re-stamp applied_at for a move).
  const persistServiceBase = useCallback(async (point: BasePoint) => {
    const res = await setServiceBase({ lat: point.lat, lng: point.lng });
    if (res.error) return { error: res.error };
    toast.success('Service base saved — customers nearby can find you now.');
    return {};
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
  const handleFile = async (
    docCode: string,
    label: string,
    file: File | undefined,
    meta: Record<string, unknown> = {},
  ) => {
    if (!file) return;
    setUploading(docCode);
    const result = await uploadKycDoc(file, label);
    if ('error' in result) { setUploading(null); toast.error(result.error); return; }

    if (application) {
      const rec = await recordDocument({ docCode, filePath: result.data.path, meta });
      setUploading(null);
      if ('error' in rec) { toast.error(rec.error); return; }
      await refreshProviderState(application.id);
      toast.success(`${label} saved — our team will check it.`);
    } else {
      const replaced = pendingFiles[docCode];
      setPendingFiles((prev) => ({ ...prev, [docCode]: result.data }));
      setPendingMeta((prev) => ({ ...prev, [docCode]: meta }));
      setUploading(null);
      if (replaced) await removeKycDoc(replaced.path);
    }
  };

  const clearPending = async (docCode: string) => {
    const doc = pendingFiles[docCode];
    setPendingFiles((prev) => { const next = { ...prev }; delete next[docCode]; return next; });
    setPendingMeta((prev) => { const next = { ...prev }; delete next[docCode]; return next; });
    if (doc) await removeKycDoc(doc.path);
  };

  const tryDigiLocker = async (docCode: string) => {
    const res = await requestDigiLocker(docCode);
    toast.info(res.message);
  };

  // ── submit ─────────────────────────────────────────────────────────────────
  const requiredDocs = requirements.filter((r) => r.requirement === 'required');
  const badgeDocs = requirements.filter((r) => r.requirement === 'badge');
  // Bucket C (10): named, bounded extras — a second ID, not an unlimited pile of files.
  const optionalDocs = requirements.filter((r) => r.requirement === 'optional');

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

    // now that the row exists, record each parked file as a typed document — with the label the
    // reviewer needs (which ID it is / whether the selfie was live).
    for (const [docCode, doc] of Object.entries(pendingFiles)) {
      const rec = await recordDocument({ docCode, filePath: doc.path, meta: pendingMeta[docCode] ?? {} });
      if ('error' in rec) toast.error(`${docCode}: ${rec.error}`);
    }
    setPendingFiles({});
    setPendingMeta({});

    // The service base needs the row to exist, so it's written after the application, not with it.
    // A failure here is not fatal to the application — say so rather than rolling anything back.
    let saved: MyApplication = result.data;
    if (basePoint) {
      const baseRes = await setServiceBase({
        lat: basePoint.lat, lng: basePoint.lng,
        address: form.area.trim() || null, city: form.city.trim() || null,
      });
      if (baseRes.error) {
        toast.error(`Saved, but your location didn't stick: ${baseRes.error}`);
      } else {
        saved = (await fetchMyApplication()) ?? result.data;
      }
    }

    setApplication(saved);
    prefill(saved);
    await refreshProviderState(saved.id);
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
          {/* What customers see about what you have been checked FOR. Verifying another document
              or a work history raises it automatically; letting one expire lowers it again. */}
          <div className="flex justify-center mb-6">
            <TrustTierBadge tier={application.trust_tier} showMeaning />
          </div>
          <div className="flex flex-col sm:flex-row gap-3 justify-center mb-8">
            <Link href={`/providers/${application.id}`} className="saffron-btn px-6 py-3 rounded-xl font-semibold text-sm">
              View my public profile
            </Link>
            <Link href="/bookings" className="px-6 py-3 rounded-xl border border-[#2a2a2a] text-sm text-gray-300 hover:text-white transition-colors">
              Go to my bookings
            </Link>
          </div>
          {/* Step 11: a live provider with no service base is invisible to nearby search, which is
              the worst version of this — approved, bookable, and findable by nobody. Saves through
              its own RPC, so moving your base never sends you back through the application gate. */}
          <ServiceBaseSection value={basePoint} onChange={setBasePoint} onPersist={persistServiceBase}
            defaultQuery={[application.address, application.city].filter(Boolean).join(', ')} />
          {/* Step 10: only an approved provider can be booked, so only they can be haggled with —
              start_negotiation refuses anyone else. */}
          <PricingSection providerId={application.id} />
          <DocumentSection checklist={checklist} uploading={uploading} idTypes={idTypes}
            onIdType={(code, v) => setIdTypes((prev) => ({ ...prev, [code]: v }))}
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
          <DocumentSection checklist={checklist} uploading={uploading} idTypes={idTypes}
            onIdType={(code, v) => setIdTypes((prev) => ({ ...prev, [code]: v }))}
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

    // applied_at is stamped by submit_provider_application, and the admin queue selects on it
    // (`.not('applied_at','is',null)`). So a row without it is saved but NOT in front of a
    // reviewer — telling that applicant "Submitted, reviewed within 24–48 hours" is a promise
    // nobody is going to keep. Say what is actually true and point at the control that fixes it.
    const submitted = Boolean(application.applied_at);

    return (
      <StatusShell icon={<Clock className="w-12 h-12 text-[#FF9933]" />} tone="#FF9933"
        title={submitted ? 'Submitted — reviewed within 24–48 hours' : 'Not sent for review yet'}
        body={!submitted
          ? 'Your details are saved, but the application hasn\'t gone to our team. Open “Edit my details” and resubmit to put it in the review queue.'
          : missingCount > 0
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
          {submitted ? 'Edit my details' : 'Edit my details and resubmit'}
        </button>
        <ServiceBaseSection value={basePoint} onChange={setBasePoint} onPersist={persistServiceBase}
          defaultQuery={[application.address, application.city].filter(Boolean).join(', ')} />
        <DocumentSection checklist={checklist} uploading={uploading} idTypes={idTypes}
          onIdType={(code, v) => setIdTypes((prev) => ({ ...prev, [code]: v }))}
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

          <ServiceBaseSection
            value={basePoint}
            onChange={setBasePoint}
            defaultQuery={[form.area, form.city].filter(Boolean).join(', ')}
          />

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

          {/* Documents — driven by the chosen category. Bucket C: each slot is NAMED, so the
              reviewer always knows what they're looking at, and the selfie is captured live. */}
          {form.categoryId && (
            <>
              <Field label="Proof of identity" required>
                <div className="space-y-2">
                  {requiredDocs.map((req) => (
                    <PendingSlot key={req.doc_code} req={req}
                      doc={pendingFiles[req.doc_code]} meta={pendingMeta[req.doc_code]}
                      supplied={checklist.find((c) => c.doc_code === req.doc_code)}
                      idType={idTypes[req.doc_code]}
                      onIdType={(v) => setIdTypes((prev) => ({ ...prev, [req.doc_code]: v }))}
                      uploading={uploading === req.doc_code}
                      onFile={handleFile} onClear={clearPending} onDigiLocker={tryDigiLocker} />
                  ))}
                </div>
                <p className="text-xs text-gray-600 mt-2">
                  Photo or PDF, up to 10 MB. Stored privately — only you and our verification team can open it, never customers.
                </p>
              </Field>

              {/* (10) One extra, named slot — not an open-ended upload pile. A second document
                  makes an identity easier to confirm; it never blocks approval. */}
              {optionalDocs.length > 0 && (
                <Field label="Add a second ID (optional)">
                  <div className="space-y-2">
                    {optionalDocs.map((req) => (
                      <PendingSlot key={req.doc_code} req={req}
                        doc={pendingFiles[req.doc_code]} meta={pendingMeta[req.doc_code]}
                        supplied={checklist.find((c) => c.doc_code === req.doc_code)}
                        idType={idTypes[req.doc_code]}
                        onIdType={(v) => setIdTypes((prev) => ({ ...prev, [req.doc_code]: v }))}
                        uploading={uploading === req.doc_code}
                        onFile={handleFile} onClear={clearPending} onDigiLocker={tryDigiLocker} />
                    ))}
                  </div>
                </Field>
              )}
            </>
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

/* Step 11 — the provider's STATIC service base.
   Type an address, we geocode it, they confirm the match. Deliberately NOT the device's live
   position: a provider is often not at their base when filling this in, and the base is what
   ranking needs (live position belongs to Step-15 tracking). `onPersist` is supplied on the status
   screens, where the row exists and the base can be saved on the spot; in the application form it
   is omitted and the point is written straight after the row is created. */
function ServiceBaseSection({ value, onChange, onPersist, defaultQuery }: {
  value: BasePoint | null;
  onChange: (point: BasePoint | null) => void;
  onPersist?: (point: BasePoint) => Promise<{ error?: string }>;
  defaultQuery?: string;
}) {
  const [query, setQuery] = useState(defaultQuery ?? '');
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const find = async () => {
    const q = query.trim();
    if (q.length < 3) { setError('Type at least 3 characters of your address.'); return; }
    setSearching(true); setError(null); setHits([]);
    const res = await geocodeAddress(q);
    setSearching(false);
    if ('error' in res) { setError(res.error); return; }
    if (!res.results.length) {
      setError('No match for that. Try adding the area and city — e.g. “Andheri East, Mumbai”.');
      return;
    }
    setHits(res.results);
  };

  const choose = async (hit: GeocodeHit) => {
    const point: BasePoint = { lat: hit.lat, lng: hit.lng, label: hit.label };
    setHits([]); setError(null);
    if (onPersist) {
      setSaving(true);
      const res = await onPersist(point);
      setSaving(false);
      if (res.error) { setError(res.error); return; }
    }
    onChange(point);
  };

  return (
    <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 sm:p-6 text-left mb-8">
      <h3 className="font-semibold text-white flex items-center gap-2 mb-1">
        <MapPin className="w-4 h-4 text-[#FF9933]" />
        Where you work from
      </h3>
      <p className="text-xs text-gray-400 mb-4 leading-relaxed">
        We use this to show you to customers nearby. They only ever see <span className="text-gray-300">how far away you are</span> —
        never your address or the point on a map.
      </p>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } }}
          className={inputClass}
          placeholder="Shop No 4, Andheri East, Mumbai"
        />
        <button type="button" onClick={find} disabled={searching || saving}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-[#2a2a2a] text-sm text-gray-300 hover:text-white hover:border-[#FF9933]/50 transition-all disabled:opacity-60 whitespace-nowrap">
          {searching ? <><Loader2 className="w-4 h-4 animate-spin" />Looking…</> : <><Search className="w-4 h-4" />Find this location</>}
        </button>
      </div>

      {hits.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {hits.map((hit, i) => (
            <li key={`${hit.lat},${hit.lng},${i}`}>
              <button type="button" onClick={() => choose(hit)} disabled={saving}
                className="w-full text-left text-xs text-gray-300 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 hover:border-[#FF9933]/50 hover:text-white transition-all disabled:opacity-60">
                {hit.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {saving && (
        <p className="mt-3 text-xs text-gray-400 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />Saving your location…
        </p>
      )}

      {error && (
        <p className="mt-3 text-xs text-orange-300 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />{error}
        </p>
      )}

      {value ? (
        <div className="mt-4 flex items-start gap-2 bg-[#138808]/10 border border-[#138808]/30 rounded-xl px-3 py-2.5">
          <CheckCircle className="w-4 h-4 text-[#138808] flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[#4ade80]">Service base set</p>
            <p className="text-xs text-gray-400 break-words">{value.label}</p>
          </div>
        </div>
      ) : (
        /* Honest, not alarming: this is a thing they haven't done yet, not an error. */
        <div className="mt-4 flex items-start gap-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 text-gray-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-gray-400">
            No location set yet — you <span className="text-gray-300">won&apos;t appear</span> when customers search for
            providers near them. Everything else about your profile still works.
          </p>
        </div>
      )}
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

/* Bucket C — the ONE place a document is captured, shared by the pre-submit form and the
   post-submit checklist. Which control appears is driven by the document type's capture_method
   (data), never by a hardcoded doc_code: 'live_capture' opens the camera, everything else offers
   an upload (plus DigiLocker where the type supports it). */
function DocCapture({ docCode, label, captureMethod, uploading, idType, onIdType, onFile, onDigiLocker }: {
  docCode: string;
  label: string;
  captureMethod: CaptureMethod | null;
  uploading: boolean;
  idType: string | undefined;
  onIdType: (value: string) => void;
  onFile: (docCode: string, label: string, file: File | undefined, meta?: Record<string, unknown>) => void;
  onDigiLocker: (docCode: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const options = ID_OPTIONS_FOR[docCode];
  const chosen = idType ?? options?.[0]?.value;

  // (14) The selfie is taken here and now. The component owns its own failure story — it never
  // leaves an applicant stuck with a camera that won't start.
  if (captureMethod === 'live_capture') {
    return (
      <LiveSelfieCapture busy={uploading} accept={KYC_ACCEPT}
        onPhoto={(file, source) => onFile(docCode, label, file, { capture: source })} />
    );
  }

  return (
    <div className="space-y-2">
      {/* (16) Which ID is this? Recorded on the document so the reviewer isn't guessing from a
          filename. Aadhaar leads because it's the one nearly everyone has; passport is last. */}
      {options && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <button key={o.value} type="button" onClick={() => onIdType(o.value)} title={o.hint}
              className={`px-2.5 py-1 rounded-lg border text-xs transition-all ${
                chosen === o.value
                  ? 'border-[#FF9933]/60 bg-[#FF9933]/10 text-white'
                  : 'border-[#2a2a2a] bg-[#161616] text-gray-400 hover:border-[#FF9933]/40'
              }`}>
              {o.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        {/* Item 22 — labelled for what it is. It reads "Coming soon" rather than "Fetch from
            DigiLocker", which promised a capability that does not exist and made the upload look
            like a fallback for something that had failed. Still clickable on purpose: the click
            explains and points at upload, where a disabled chip would just be a mystery. */}
        {captureMethod === 'digilocker' && (
          <button type="button" onClick={() => onDigiLocker(docCode)}
            title="DigiLocker is coming soon — upload the document and our team verifies it"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-[#2a2a2a] bg-[#161616] text-gray-400 hover:text-gray-200 transition-all">
            <Download className="w-3.5 h-3.5" /> DigiLocker
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[#2a2a2a] text-gray-500">
              Coming soon
            </span>
          </button>
        )}
        <input ref={inputRef} type="file" accept={KYC_ACCEPT} className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';   // so re-picking the SAME file still fires a change
            onFile(docCode, label, file, chosen ? { id_type: chosen } : {});
          }} />
        <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-[#2a2a2a] text-gray-400 hover:text-white transition-all disabled:opacity-60">
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {/* Upload is the ACTIVE path, so it stops being phrased as the alternative ("or upload")
              to a control that cannot do anything yet. */}
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </div>
  );
}

// One document slot on the application form. Two very different states share it:
//   • no provider row yet — the file is PARKED in storage and recorded the moment the row exists
//   • resubmitting — the row exists, so the file is recorded immediately, and `supplied` (the
//     server's own checklist, refreshed right after) is what says so.
// Without that second case the slot kept offering "Upload" / "Use this photo" after a successful
// save, with only a transient toast to say otherwise — so the applicant had no way to tell
// whether their document had gone in, and could re-submit the same one on top of itself.
function PendingSlot({ req, doc, meta, supplied, idType, onIdType, uploading, onFile, onClear, onDigiLocker }: {
  req: CategoryKycRequirement;
  doc: KycDocument | undefined;
  meta: Record<string, unknown> | undefined;
  supplied: DocumentChecklistItem | undefined;
  idType: string | undefined;
  onIdType: (value: string) => void;
  uploading: boolean;
  onFile: (docCode: string, label: string, file: File | undefined, meta?: Record<string, unknown>) => void;
  onClear: (docCode: string) => void;
  onDigiLocker: (docCode: string) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  // A successful replace lands as a NEW file_path on the checklist row. When it does, drop back to
  // the saved view — otherwise the capture UI stays open behind a document that is already in.
  useEffect(() => { setReplacing(false); }, [supplied?.file_path]);
  const t = req.kyc_document_types;
  const label = t?.label ?? req.doc_code;
  const what = idTypeLabel(meta?.id_type as string | undefined)
    ?? (meta?.capture === 'live' ? 'captured live' : meta?.capture === 'upload_fallback' ? 'uploaded — camera unavailable' : null);

  if (doc) {
    return (
      <div className="flex items-center gap-3 bg-[#1e1e1e] border border-[#138808]/30 rounded-xl px-4 py-3">
        <FileText className="w-4 h-4 text-[#138808] flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white truncate">{label}{what ? ` · ${what}` : ''}</p>
          <p className="text-xs text-gray-500 truncate">{doc.name ?? 'ready to submit'} · ready to submit</p>
        </div>
        <button type="button" onClick={() => onClear(req.doc_code)}
          className="text-gray-500 hover:text-red-400 transition-colors" aria-label={`Remove ${label}`}>
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // Already on the record. A verified document is frozen (record_provider_document refuses to
  // replace one), so only an unverified document offers "Replace".
  const status = supplied?.verification_status;
  const onRecord = Boolean(supplied?.document_id) && status !== 'rejected' && status !== 'expired';
  if (onRecord && !replacing) {
    const chip = status ? STATUS_CHIP[status] : null;
    return (
      <div className="flex items-center gap-3 bg-[#1e1e1e] border border-[#138808]/30 rounded-xl px-4 py-3">
        <FileText className={`w-4 h-4 flex-shrink-0 ${status === 'verified' ? 'text-[#138808]' : 'text-gray-400'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white truncate">{label}</p>
          <p className="text-xs text-gray-500 truncate">Saved — we have this on file.</p>
        </div>
        {chip && <span className={`text-xs px-2.5 py-1 rounded-full font-medium flex-shrink-0 ${chip.cls}`}>{chip.label}</span>}
        {status !== 'verified' && (
          <button type="button" onClick={() => setReplacing(true)}
            className="text-xs text-gray-500 hover:text-white transition-colors flex-shrink-0">
            Replace
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="bg-[#1e1e1e] border border-dashed border-[#2a2a2a] rounded-xl px-4 py-3">
      <p className="text-sm text-gray-300 flex items-center gap-1.5">
        {t?.capture_method === 'live_capture'
          ? <Camera className="w-3.5 h-3.5 text-[#FF9933]" />
          : <IdCard className="w-3.5 h-3.5 text-gray-500" />}
        {label}
      </p>
      {t?.description && <p className="text-xs text-gray-600 mb-2 mt-0.5">{t.description}</p>}
      <div className="mt-2">
        <DocCapture docCode={req.doc_code} label={label}
          captureMethod={(t?.capture_method as CaptureMethod | undefined) ?? null}
          uploading={uploading} idType={idType} onIdType={onIdType}
          onFile={onFile} onDigiLocker={onDigiLocker} />
      </div>
    </div>
  );
}

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  verified: { label: 'Verified', cls: 'bg-[#138808]/10 text-[#138808]' },
  pending:  { label: 'In review', cls: 'bg-[#FF9933]/10 text-[#FF9933]' },
  rejected: { label: 'Rejected', cls: 'bg-red-900/20 text-red-400' },
  expired:  { label: 'Expired', cls: 'bg-red-900/20 text-red-400' },
};

function DocumentSection({ checklist, uploading, idTypes, onIdType, onFile, onDigiLocker }: {
  checklist: DocumentChecklistItem[];
  uploading: string | null;
  idTypes: Record<string, string>;
  onIdType: (docCode: string, value: string) => void;
  onFile: (docCode: string, label: string, file: File | undefined, meta?: Record<string, unknown>) => void;
  onDigiLocker: (docCode: string) => void;
}) {
  if (checklist.length === 0) return null;
  const required = checklist.filter((c) => c.requirement === 'required');
  const badges = checklist.filter((c) => c.requirement === 'badge');
  const optional = checklist.filter((c) => c.requirement === 'optional');

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
          <div className="mt-3">
            <DocCapture docCode={item.doc_code} label={item.label}
              captureMethod={item.capture_method} uploading={uploading === item.doc_code}
              idType={idTypes[item.doc_code]} onIdType={(v) => onIdType(item.doc_code, v)}
              onFile={onFile} onDigiLocker={onDigiLocker} />
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
      {/* (10) The second-ID slot stays available after submitting, too — a provider who skipped
          it can add it while their application is being reviewed. */}
      {optional.length > 0 && (
        <>
          <h4 className="font-semibold text-gray-300 text-sm mt-6 mb-2 flex items-center gap-2">
            <IdCard className="w-4 h-4 text-gray-400" /> Optional — a second ID speeds up review
          </h4>
          <div className="space-y-2">{optional.map((i) => renderRow(i, true))}</div>
        </>
      )}
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
