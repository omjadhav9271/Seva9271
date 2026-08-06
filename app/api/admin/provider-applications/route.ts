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
  'id, user_id, category_id, business_name, city, state, status, kyc_status, kyc_documents, ' +
  'hourly_rate, trust_tier, applied_at, reviewed_at, service_categories(name)';

// trust_tier is in BOTH lists on purpose: ProviderApplicationDetail.application extends
// ProviderApplicationRow, so TypeScript believes the field is there either way. Omitting it here
// would not fail the build — the badge would just render tier 1 for every applicant, which is a
// wrong answer rather than a missing one.
const DETAIL_COLUMNS =
  'id, user_id, category_id, business_name, bio, experience_years, hourly_rate, city, state, ' +
  'address, status, is_verified, kyc_status, kyc_documents, rejection_reason, applied_at, ' +
  'reviewed_by, reviewed_at, created_at, trust_tier, service_categories(name)';


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

    // Step 9.5: documents are typed rows now, each with its own verification status and expiry.
    // The requirement comes from the provider's CATEGORY, so the admin sees required vs supplied.
    const { data: docRows } = await admin
      .from('provider_documents')
      .select('id, doc_code, file_path, reference_number, verification_status, verified_source, expires_at, created_at, verified_at')
      .eq('provider_id', id);
    const { data: reqRows } = await admin
      .from('category_kyc_requirements')
      .select('doc_code, requirement, unlocks_tier, note, kyc_document_types(label, description, capture_method, carries_expiry)')
      .eq('category_id', app.category_id as string);

    type ReqRow = { doc_code: string; requirement: string; unlocks_tier: number | null; note: string | null;
                    kyc_document_types: { label: string; description: string | null; capture_method: string; carries_expiry: boolean } | null };
    const supplied = new Map((docRows ?? []).map((d) => [d.doc_code as string, d]));

    const documents = await Promise.all(
      ((reqRows ?? []) as unknown as ReqRow[])
        .filter((r) => r.requirement === 'required' || r.requirement === 'badge')
        .map(async (r) => {
          const row = supplied.get(r.doc_code);
          let url: string | null = null;
          if (row?.file_path) {
            const { data: signed } = await admin.storage.from('kyc-docs').createSignedUrl(row.file_path as string, DOC_URL_TTL);
            url = signed?.signedUrl ?? null;
          }
          return {
            doc_code: r.doc_code,
            label: r.kyc_document_types?.label ?? r.doc_code,
            description: r.kyc_document_types?.description ?? null,
            capture_method: r.kyc_document_types?.capture_method ?? 'upload',
            carries_expiry: r.kyc_document_types?.carries_expiry ?? false,
            requirement: r.requirement,
            note: r.note,
            document_id: row?.id ?? null,
            verification_status: row?.verification_status ?? null,
            verified_source: row?.verified_source ?? null,
            reference_number: row?.reference_number ?? null,
            expires_at: row?.expires_at ?? null,
            url,
          };
        }),
    );
    // required first, then badges
    documents.sort((a, b) => (a.requirement === 'required' ? 0 : 1) - (b.requirement === 'required' ? 0 : 1));

    const { data: experience } = await admin
      .from('provider_experience')
      .select('id, employer_name, role, from_date, to_date, source, verified, verified_at')
      .eq('provider_id', id)
      .order('from_date', { ascending: false });

    const blocking = documents
      .filter((d) => d.requirement === 'required' && d.verification_status !== 'verified')
      .map((d) => d.label);

    return NextResponse.json({
      application: { ...app, kyc_documents: undefined },
      documents,
      experience: experience ?? [],
      blocking,   // approval is refused by the RPC while this is non-empty
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

  const rows = (data ?? []) as unknown as ApplicationRow[];

  // Step 9.5: completeness comes from the typed documents vs what the CATEGORY requires, so the
  // queue can show "2 of 5 verified" instead of a meaningless file count.
  const ids = rows.map((r) => r.id);
  const [{ data: docs }, { data: reqs }] = await Promise.all([
    admin.from('provider_documents').select('provider_id, doc_code, verification_status').in('provider_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
    admin.from('category_kyc_requirements').select('category_id, doc_code, requirement').eq('requirement', 'required'),
  ]);
  const requiredByCat = new Map<string, number>();
  for (const r of reqs ?? []) {
    const key = r.category_id as string;
    requiredByCat.set(key, (requiredByCat.get(key) ?? 0) + 1);
  }
  const verifiedByProvider = new Map<string, number>();
  for (const d of docs ?? []) {
    if (d.verification_status !== 'verified') continue;
    const key = d.provider_id as string;
    verifiedByProvider.set(key, (verifiedByProvider.get(key) ?? 0) + 1);
  }

  const applications = rows.map((row) => ({
    ...row,
    documents_required: requiredByCat.get((row as unknown as { category_id: string }).category_id) ?? 0,
    documents_verified: verifiedByProvider.get(row.id) ?? 0,
    kyc_documents: undefined,
  }));

  return NextResponse.json({ applications });
}
