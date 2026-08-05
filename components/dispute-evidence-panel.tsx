'use client';

/* Step 8.5 — the party-side evidence panel on /bookings/[id]. Shown to EITHER party once a
   dispute exists: attach images/video/audio/pdf while it's open, review your own uploads, remove
   a mis-upload. You only ever see YOUR OWN evidence here (RLS) — the admin sees both sides. */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Paperclip, Trash2, FileText, Film, Mic, Image as ImageIcon, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import type { Dispute, DisputeEvidence } from '@/lib/supabase';
import {
  listEvidence, uploadEvidence, deleteEvidence, evidenceSignedUrl,
  EVIDENCE_ACCEPT, MAX_FILES_PER_PARTY,
} from '@/lib/dispute-evidence';

const KindIcon = ({ kind }: { kind: DisputeEvidence['kind'] }) => {
  const cls = 'w-4 h-4 text-gray-400';
  if (kind === 'image') return <ImageIcon className={cls} />;
  if (kind === 'video') return <Film className={cls} />;
  if (kind === 'audio') return <Mic className={cls} />;
  return <FileText className={cls} />;
};

export default function DisputeEvidencePanel({ dispute, role }: { dispute: Dispute; role: 'customer' | 'provider' }) {
  const [items, setItems] = useState<DisputeEvidence[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = dispute.status !== 'resolved';

  const refresh = useCallback(async () => {
    const rows = await listEvidence(dispute.id);
    setItems(rows);
    const entries = await Promise.all(
      rows.map(async (r) => [r.file_path, (await evidenceSignedUrl(r.file_path)) ?? ''] as const),
    );
    setUrls(Object.fromEntries(entries));
  }, [dispute.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || uploading) return;
    const chosen = Array.from(files);
    if (items.length + chosen.length > MAX_FILES_PER_PARTY) {
      toast.error(`You can attach up to ${MAX_FILES_PER_PARTY} files.`);
      return;
    }
    setUploading(true);
    let ok = 0;
    for (const file of chosen) {
      const res = await uploadEvidence({ disputeId: dispute.id, bookingId: dispute.booking_id, uploaderRole: role, file });
      if ('error' in res) toast.error(res.error);
      else ok++;
    }
    if (ok > 0) toast.success(`${ok} file${ok > 1 ? 's' : ''} attached.`);
    if (inputRef.current) inputRef.current.value = '';
    setUploading(false);
    void refresh();
  };

  const onDelete = async (row: DisputeEvidence) => {
    const res = await deleteEvidence(row);
    if (res.error) { toast.error(res.error); return; }
    toast.success('Removed.');
    void refresh();
  };

  // Nothing to show a party once a dispute is resolved and they attached nothing.
  if (!open && items.length === 0) return null;

  return (
    <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <Paperclip className="w-4 h-4 text-orange-400" />
        <h2 className="text-sm font-bold text-white">Your evidence</h2>
      </div>
      <p className="text-xs text-gray-400 mb-2">
        {open
          ? 'Attach anything that supports your side of the complaint above — photos of the work, a receipt, a recording. Our team weighs both parties’ evidence before deciding.'
          : 'What you attached to this case.'}
      </p>
      <p className="text-xs text-gray-500 mb-4 flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5" />
        Only you and our review team can see these — never the other party. Photos, video, audio or PDF — up to {MAX_FILES_PER_PARTY} files, 50&nbsp;MB each.
      </p>

      {items.length > 0 && (
        <div className="space-y-2 mb-4">
          {items.map((row) => {
            const url = urls[row.file_path];
            return (
              <div key={row.id} className="flex items-center gap-3 bg-[#1e1e1e] rounded-xl p-2.5">
                <div className="flex-shrink-0">
                  {row.kind === 'image' && url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt="evidence" className="w-12 h-12 rounded-lg object-cover" />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-[#2a2a2a] flex items-center justify-center"><KindIcon kind={row.kind} /></div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-300 capitalize">{row.kind}{row.caption ? ` · ${row.caption}` : ''}</p>
                  {url && (
                    <a href={url} target="_blank" rel="noreferrer" className="text-xs text-[#5da9ff] hover:underline">View</a>
                  )}
                </div>
                {open && (
                  <button onClick={() => onDelete(row)} className="p-1.5 text-gray-500 hover:text-red-400 transition-colors" aria-label="Remove">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {open ? (
        <div>
          <input
            ref={inputRef}
            type="file"
            accept={EVIDENCE_ACCEPT}
            multiple
            disabled={uploading || items.length >= MAX_FILES_PER_PARTY}
            onChange={(e) => onFiles(e.target.files)}
            className="block w-full text-xs text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-orange-600 file:text-white hover:file:bg-orange-700 file:cursor-pointer disabled:opacity-50"
          />
          {uploading && <p className="text-xs text-gray-500 mt-2">Uploading…</p>}
          {items.length >= MAX_FILES_PER_PARTY && <p className="text-xs text-gray-500 mt-2">You&apos;ve reached the {MAX_FILES_PER_PARTY}-file limit.</p>}
        </div>
      ) : (
        <p className="text-xs text-gray-500">This dispute is resolved — evidence is now read-only.</p>
      )}
    </div>
  );
}
