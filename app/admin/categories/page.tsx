'use client';

/* /admin/categories — what the marketplace sells.

   Reads stay public (the catalog needs them); writes are admin-only and go through
   admin_create_category / admin_delete_category, which re-check is_admin() in the database. The
   button being hidden is not the boundary — the RPC is.

   Deletion is refused while anything still points at a category. That is not a UI nicety: the FKs
   disagree with each other. service_providers/bookings block a delete outright, while
   provider_services and category_kyc_requirements CASCADE — so a category nobody lists as their
   PRIMARY one could still be deleted out from under the providers who offer it. category_usage()
   gives the counts up front, so a delete that would be refused is disabled rather than attempted. */

import { useState, useEffect, useCallback } from 'react';
import { Tag, Trash2, Plus, Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { supabase, type ServiceCategory } from '@/lib/supabase';
import { useAdminGuard } from '@/lib/admin';
import AdminNav from '@/components/admin-nav';

type Usage = { category_id: string; providers: number; bookings: number; offered: number };

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
    toast.success(`"${name.trim()}" added.`);
    setName(''); setSlug(''); setDescription(''); setFormOpen(false);
    void load();
  };

  const remove = async (c: ServiceCategory) => {
    if (busy) return;
    setBusy(c.id);
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

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center gap-3 mb-2">
          <Tag className="w-7 h-7 text-[#FF9933]" />
          <h1 className="text-3xl font-black text-white">Service Categories</h1>
        </div>
        <p className="text-sm text-gray-400 mb-6">
          What the marketplace sells. Anyone can read these; only an admin can add or remove one —
          enforced in the database, not here.
        </p>

        <AdminNav />

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
              hyphenated server-side, and must be unique.
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
            {rows.map((c) => {
              const used = inUse(c.id);
              const u = usage[c.id];
              return (
                <div key={c.id} className="flex items-center gap-4 bg-[#161616] border border-[#2a2a2a] rounded-2xl p-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white">
                      {c.name}
                      <span className="text-gray-600 font-mono font-normal text-xs"> /{c.slug}</span>
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {u
                        ? `${u.providers} provider${u.providers === 1 ? '' : 's'} · ${u.bookings} booking${u.bookings === 1 ? '' : 's'} · ${u.offered} listing${u.offered === 1 ? '' : 's'}`
                        : 'usage unknown'}
                      {c.description ? ` — ${c.description}` : ''}
                    </p>
                  </div>
                  {used > 0 ? (
                    <span
                      className="flex items-center gap-1.5 text-[11px] text-gray-500 flex-shrink-0"
                      title="In use — move its providers, bookings and listings before removing it"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" /> in use
                    </span>
                  ) : (
                    <button
                      onClick={() => remove(c)}
                      disabled={busy !== null}
                      className="p-2 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-50 flex-shrink-0"
                      aria-label={`Remove ${c.name}`}
                    >
                      {busy === c.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
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
