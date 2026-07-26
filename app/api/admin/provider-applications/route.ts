/* GET /api/admin/provider-applications          — the review queue
 * GET /api/admin/provider-applications?id=<uuid> — one application + signed document URLs
 * ADMIN ONLY.
 *
 * This lives in a server route (not the client) because Step 9 deliberately gives the kyc_*
 * columns NO select grant to `authenticated`: kyc_documents and rejection_reason are application
 * PII, and the ID documents themselves sit in a private bucket. Only the service role can
 * assemble the queue and mint signed URLs for the documents. The decision itself is NOT taken
 * here — that stays in review_provider_application, which re-checks is_admin() inside the DB. */

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getUserIdFromRequest } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DOC_URL_TTL = 600; // 10 minutes — long enough to review, short enough not to leak

const LIST_COLUMNS =
  'id, user_id, business_name, city, state, status, kyc_status, kyc_documents, hourly_rate, ' +
  'applied_at, reviewed_at, service_categories(name)';

const DETAIL_COLUMNS =
  'id, user_id, category_id, business_name, bio, experience_years, hourly_rate, city, state, ' +
  'address, status, is_verified, kyc_status, kyc_documents, rejection_reason, applied_at, ' +
  'reviewed_by, reviewed_at, created_at, service_categories(name)';

type KycDoc = { path?: string; label?: string; name?: string; mime?: string };

// The select strings are built by concatenation, so supabase-js can't infer a row shape from
// them — these are the shapes we actually read back.
type ApplicationRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  kyc_documents: unknown;
};

export async function GET(req: Request) {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const admin = getSupabaseAdmin();
  const { data: prof } = await admin.from('profiles').select('role').eq('id', userId).maybeSingle();
  if (prof?.role !== 'admin') return NextResponse.json({ error: 'admin only' }, { status: 403 });

  const id = new URL(req.url).searchParams.get('id');

  // ---------------------------------------------------------------- one application + documents
  if (id) {
    const { data, error } = await admin
      .from('service_providers').select(DETAIL_COLUMNS).eq('id', id).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'application not found' }, { status: 404 });
    const app = data as unknown as ApplicationRow;

    // Owner identity — the person behind the business name. Emails live in auth.users, which
    // only the service role can read.
    const { data: owner } = await admin
      .from('profiles').select('full_name, phone, city, state, created_at')
      .eq('id', app.user_id).maybeSingle();
    const { data: authUser } = await admin.auth.admin.getUserById(app.user_id);

    const docs = Array.isArray(app.kyc_documents) ? (app.kyc_documents as KycDoc[]) : [];
    const documents = await Promise.all(
      docs.map(async (doc) => {
        const path = typeof doc?.path === 'string' ? doc.path : null;
        if (!path) return { ...doc, url: null as string | null };
        const { data: signed } = await admin.storage.from('kyc-docs').createSignedUrl(path, DOC_URL_TTL);
        return {
          path,
          label: doc.label ?? 'Document',
          name: doc.name ?? null,
          mime: doc.mime ?? null,
          url: signed?.signedUrl ?? null,
        };
      }),
    );

    return NextResponse.json({
      application: { ...app, kyc_documents: undefined },
      documents,
      owner: {
        name: owner?.full_name ?? null,
        phone: owner?.phone ?? null,
        email: authUser?.user?.email ?? null,
        location: [owner?.city, owner?.state].filter(Boolean).join(', ') || null,
        member_since: owner?.created_at ?? null,
      },
    });
  }

  // ---------------------------------------------------------------- the queue
  // Everything that has ever been submitted, newest first. The page splits it into
  // "to review" vs "decided" — one query keeps the console honest about its own backlog.
  const { data, error } = await admin
    .from('service_providers')
    .select(LIST_COLUMNS)
    .not('applied_at', 'is', null)
    .order('applied_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const applications = ((data ?? []) as unknown as ApplicationRow[]).map((row) => ({
    ...row,
    document_count: Array.isArray(row.kyc_documents) ? row.kyc_documents.length : 0,
    kyc_documents: undefined,
  }));

  return NextResponse.json({ applications });
}
