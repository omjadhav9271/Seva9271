'use client';

/* /admin/categories — what the marketplace sells, and how Seva engages with each one's money.

   Reads stay public (the catalog needs them); writes are admin-only and go through
   admin_create_category / admin_update_category / admin_delete_category / admin_set_category_model,
   which all re-check is_admin() in the database. The button being hidden is not the boundary —
   the RPC is.

   THE BOARD. A category with no engagement_model is UNDECIDED and renders grey; one with a model
   renders in that model's colour with a badge. That is a working state, not a product state:
   grey is cosmetic and admin-only, and an undecided category stays fully bookable and fully
   searchable. Greying out a live category on the customer side would strand its providers and any
   in-flight booking — a control that looks disabled but works is the defect this log keeps
   catching, and so is its inverse.

   WHY THE MODEL IS PER CATEGORY. Escrow makes Seva the transacting party, which under CGST §9(5)
   means GST on the FULL SERVICE VALUE for notified categories (house-keeping, passenger transport)
   and under §24(x) means registration regardless of turnover. That is the right trade for some
   categories and a ruinous one for others, so it is decided category by category. Rationale for
   each: /docs/Seva-Decisions-Log.md. Nothing in the booking or payment path reads the model yet.

   Deletion is refused while anything still points at a category. That is not a UI nicety: the FKs
   disagree with each other. service_providers/bookings block a delete outright, while
   provider_services and category_kyc_requirements CASCADE — so a category nobody lists as their
   PRIMARY one could still be deleted out from under the providers who offer it. category_usage()
   gives the counts up front, so a delete that would be refused is disabled rather than attempted. */

import { useState, useEffect, useCallback } from 'react';
import { Tag, Trash2, Plus, Loader2, AlertTriangle, Pencil, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  supabase,
  ENGAGEMENT_MODELS,
  type ServiceCategory,
  type EngagementModel,
} from '@/lib/supabase';
import { useAdminGuard } from '@/lib/admin';
import AdminNav from '@/components/admin-nav';

type Usage = { category_id: string; providers: number; bookings: number; offered: number };

const MODEL_KEYS = Object.keys(ENGAGEMENT_MODELS) as EngagementModel[];

export default function AdminCategoriesPage() {
  const guard = useAdminGuard();
  const [rows, setRows] = useState<ServiceCategory[]>([]);
  const [usage, setUsage] = useState<Record<string, Usage>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');

  // The row currently being edited, and the draft it holds. One at a time — an edit is a
  // deliberate act on a specific category, not a spreadsheet.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', slug: '', description: '' });

  const load = useCallback(async () => {
    const [{ data: cats, error }, { data: use, error: useErr }] = await Promise.all([
      supabase.from('service_categories').select('*').order('name'),
      supabase.rpc('category_usage'),
    ]);
    if (error) toast.error('Could not load categories: ' + error.message);
    // Say so when the counts are missing. Swallowed, this reads as "nothing uses any category" —
    // every row would offer a delete button, and the refusal would only arrive after the click.
    if (useErr) toast.error('Could not load category usage: ' + useErr.message);
    setRows((cats ?? []) as ServiceCategory[]);
    setUsage(Object.fromEntries(((use ?? []) as Usage[]).map((u) => [u.category_id, u])));
    setLoading(false);
  }, []);

  useEffect(() => {
    if (guard !== 'ok') return;
    void load();
  }, [guard, load]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy('create');
    const { error } = await supabase.rpc('admin_create_category', {
      p_name: name.trim(),
      p_slug: slug.trim() || null,
      p_description: description.trim() || null,
      p_icon: null, p_color: null, p_bg_color: null,
    });
    setBusy(null);
    if (error) { toast.error(error.message); return; }
    // Born undecided — it lands at the top of the board, grey, waiting for a model.
    toast.success(`"${name.trim()}" added — undecided until it has a model.`);
    setName(''); setSlug(''); setDescription(''); setFormOpen(false);
    void load();
  };

  const save = async (c: ServiceCategory) => {
    if (!draft.name.trim() || busy) return;
    setBusy(`save:${c.id}`);
    // p_slug blank means KEEP the current slug — the RPC does not re-derive it from the name, so
    // renaming a category never silently 404s the links already pointing at /services/<slug>.
    const { error } = await supabase.rpc('admin_update_category', {
      p_id: c.id,
      p_name: draft.name.trim(),
      p_slug: draft.slug.trim() || null,
      p_description: draft.description.trim() || null,
    });
    setBusy(null);
    if (error) { toast.error(error.message); return; }
    toast.success(`"${draft.name.trim()}" updated.`);
    setEditing(null);
    void load();
  };

  const setModel = async (c: ServiceCategory, model: EngagementModel | null) => {
    if (busy) return;
    setBusy(`model:${c.id}`);
    const { error } = await supabase.rpc('admin_set_category_model', { p_id: c.id, p_model: model });
    setBusy(null);
    if (error) { toast.error(error.message); return; }
    toast.success(
      model
        ? `${c.name} → ${ENGAGEMENT_MODELS[model].label}.`
        : `${c.name} is undecided again.`,
    );
    void load();
  };

  const remove = async (c: ServiceCategory) => {
    if (busy) return;
    setBusy(`del:${c.id}`);
    const { error } = await supabase.rpc('admin_delete_category', { p_id: c.id });
    setBusy(null);
    if (error) { toast.error(error.message); return; }
    toast.success(`"${c.name}" removed.`);
    void load();
  };

  if (guard !== 'ok') {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Checking access…</div>;
  }

  const inUse = (id: string) => {
    const u = usage[id];
    return u ? u.providers + u.bookings + u.offered : 0;
  };

  // Undecided first — the board is a worklist, and the work is the grey rows. Name order within
  // each group, so a category does not move around under the cursor for any other reason.
  const ordered = [...rows].sort((a, b) => {
    const ua = a.engagement_model ? 1 : 0;
    const ub = b.engagement_model ? 1 : 0;
    return ua !== ub ? ua - ub : a.name.localeCompare(b.name);
  });
  const decided = rows.filter((c) => c.engagement_model).length;

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center gap-3 mb-2">
          <Tag className="w-7 h-7 text-[#FF9933]" />
          <h1 className="text-3xl font-black text-white">Service Categories</h1>
        </div>
        <p className="text-sm text-gray-400 mb-6">
          What the marketplace sells, and how Seva engages with each one&apos;s money. Anyone can read
          these; only an admin can add, edit, remove or set a model — enforced in the database, not
          here.
        </p>

        <AdminNav />

        {/* Progress. Grey rows are the ones still to decide; the customer-facing site is unaffected
            by any of it. */}
        {!loading && rows.length > 0 && (
          <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-4 mb-6">
            <div className="flex items-baseline justify-between mb-2">
              <p className="text-sm font-semibold text-white">
                Decided <span className="text-[#FF9933]">{decided}</span>
                <span className="text-gray-500"> / {rows.length}</span>
              </p>
              <p className="text-[11px] text-gray-500">
                Grey = no engagement model yet. Admin-only — customers see no change.
              </p>
            </div>
            <div className="h-1.5 rounded-full bg-[#2a2a2a] overflow-hidden">
              <div
                className="h-full bg-[#FF9933] transition-all duration-500"
                style={{ width: `${rows.length ? (decided / rows.length) * 100 : 0}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
              {MODEL_KEYS.map((k) => (
                <span key={k} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                  <span className={`w-2 h-2 rounded-full ${ENGAGEMENT_MODELS[k].rail}`} />
                  <span className={ENGAGEMENT_MODELS[k].text}>{ENGAGEMENT_MODELS[k].label}</span>
                  <span className="hidden sm:inline">— {ENGAGEMENT_MODELS[k].blurb}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {!formOpen ? (
          <button
            onClick={() => setFormOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-[#FF9933] text-white hover:bg-[#e8872e] transition-colors mb-6"
          >
            <Plus className="w-4 h-4" /> Add a category
          </button>
        ) : (
          <div className="bg-[#161616] border border-[#FF9933]/30 rounded-2xl p-5 mb-6 space-y-3">
            <p className="text-sm font-semibold text-white">New category</p>
            <input
              value={name} onChange={(e) => setName(e.target.value)} autoFocus
              placeholder="Name — e.g. Pest Control"
              className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#FF9933]"
            />
            <input
              value={slug} onChange={(e) => setSlug(e.target.value)}
              placeholder="Slug (optional) — derived from the name if left blank"
              className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#FF9933]"
            />
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              placeholder="Short description (optional)"
              className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#FF9933] resize-none"
            />
            <p className="text-[11px] text-gray-600">
              The slug is what /services and the category pages route on — it is lower-cased and
              hyphenated server-side, and must be unique. A new category starts <em>undecided</em>:
              give it an engagement model from its row once you have decided one.
            </p>
            <div className="flex gap-2">
              <button
                onClick={create} disabled={busy !== null || !name.trim()}
                className="px-4 py-2 rounded-xl text-sm font-semibold bg-[#FF9933] text-white hover:bg-[#e8872e] transition-colors disabled:opacity-50"
              >
                {busy === 'create' ? 'Adding…' : 'Add category'}
              </button>
              <button
                onClick={() => { setFormOpen(false); setName(''); setSlug(''); setDescription(''); }}
                disabled={busy !== null}
                className="px-4 py-2 rounded-xl text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-gray-400 text-sm">Loading categories…</p>
        ) : rows.length === 0 ? (
          <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-10 text-center">
            <p className="text-gray-400 text-sm">No categories yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {ordered.map((c) => {
              const used = inUse(c.id);
              const u = usage[c.id];
              const m = c.engagement_model ? ENGAGEMENT_MODELS[c.engagement_model] : null;
              const isEditing = editing === c.id;

              return (
                <div
                  key={c.id}
                  className={`relative overflow-hidden bg-[#161616] border rounded-2xl p-4 pl-5 transition-colors ${
                    m ? 'border-[#2a2a2a]' : 'border-[#232323]'
                  }`}
                >
                  {/* The rail carries the state at a glance: grey while undecided, the model's
                      colour once decided. */}
                  <span
                    aria-hidden
                    className={`absolute left-0 top-0 bottom-0 w-1 ${m ? m.rail : 'bg-[#333]'}`}
                  />

                  {isEditing ? (
                    <div className="space-y-2.5">
                      <input
                        value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus
                        placeholder="Name"
                        className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#FF9933]"
                      />
                      <input
                        value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                        placeholder={`Slug — leave blank to keep /${c.slug}`}
                        className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-[#FF9933]"
                      />
                      <textarea
                        value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2}
                        placeholder="Short description — empty clears it"
                        className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-[#FF9933] resize-none"
                      />
                      <p className="text-[11px] text-amber-500/80 flex items-start gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                        Changing the slug changes this category&apos;s URL — anything already linking
                        to <span className="font-mono">/services/{c.slug}</span> will stop resolving.
                        Leave it blank to keep it.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => save(c)} disabled={busy !== null || !draft.name.trim()}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#FF9933] text-white hover:bg-[#e8872e] transition-colors disabled:opacity-50"
                        >
                          {busy === `save:${c.id}`
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Check className="w-3.5 h-3.5" />}
                          Save
                        </button>
                        <button
                          onClick={() => setEditing(null)} disabled={busy !== null}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                        >
                          <X className="w-3.5 h-3.5" /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-semibold ${m ? 'text-white' : 'text-gray-400'}`}>
                          {c.name}
                          <span className="text-gray-600 font-mono font-normal text-xs"> /{c.slug}</span>
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5 truncate">
                          {u
                            ? `${u.providers} provider${u.providers === 1 ? '' : 's'} · ${u.bookings} booking${u.bookings === 1 ? '' : 's'} · ${u.offered} listing${u.offered === 1 ? '' : 's'}`
                            : 'usage unknown'}
                          {c.description ? ` — ${c.description}` : ''}
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          {m ? (
                            <span className={`text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-md ring-1 ${m.bg} ${m.text} ${m.ring}`}>
                              {m.label}
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-md ring-1 ring-[#333] bg-[#1e1e1e] text-gray-500">
                              Undecided
                            </span>
                          )}
                          {/* The picker, not a set of buttons: four models plus "undecided" is a
                              choice from a fixed list, and it must be walkable backwards. */}
                          <select
                            value={c.engagement_model ?? ''}
                            disabled={busy !== null}
                            onChange={(e) => setModel(c, (e.target.value || null) as EngagementModel | null)}
                            aria-label={`Engagement model for ${c.name}`}
                            className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg px-2 py-1 text-[11px] text-gray-300 focus:outline-none focus:border-[#FF9933] disabled:opacity-50"
                          >
                            <option value="">— undecided —</option>
                            {MODEL_KEYS.map((k) => (
                              <option key={k} value={k}>{ENGAGEMENT_MODELS[k].label}</option>
                            ))}
                          </select>
                          {busy === `model:${c.id}` && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => {
                            setEditing(c.id);
                            // Slug starts blank on purpose — the placeholder says it keeps the
                            // current one, so the safe path is also the do-nothing path.
                            setDraft({ name: c.name, slug: '', description: c.description ?? '' });
                          }}
                          disabled={busy !== null}
                          className="p-2 rounded-lg text-gray-500 hover:text-white hover:bg-[#1e1e1e] transition-colors disabled:opacity-50"
                          aria-label={`Edit ${c.name}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {used > 0 ? (
                          <span
                            className="flex items-center gap-1.5 text-[11px] text-gray-500 px-1.5"
                            title="In use — move its providers, bookings and listings before removing it"
                          >
                            <AlertTriangle className="w-3.5 h-3.5" /> in use
                          </span>
                        ) : (
                          <button
                            onClick={() => remove(c)}
                            disabled={busy !== null}
                            className="p-2 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-50"
                            aria-label={`Remove ${c.name}`}
                          >
                            {busy === `del:${c.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
