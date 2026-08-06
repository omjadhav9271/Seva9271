'use client';

/* /admin — the hub. It did not exist, so typing /admin 404'd and the only way into the admin area
   was a single navbar link pointing at the dispute queue. Three cards, each answering "is there
   anything waiting for me here?" before the admin clicks. */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Scale, BadgeCheck, Tag, ChevronRight, ShieldCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAdminGuard, fetchProviderApplications } from '@/lib/admin';
import AdminNav from '@/components/admin-nav';

type Counts = { disputes: number | null; providers: number | null; categories: number | null };

export default function AdminHomePage() {
  const guard = useAdminGuard();
  const [counts, setCounts] = useState<Counts>({ disputes: null, providers: null, categories: null });

  useEffect(() => {
    if (guard !== 'ok') return;
    let active = true;
    (async () => {
      // In parallel, not in sequence: these three are independent, so awaiting them one after
      // another costs the SUM of three round trips instead of the slowest.
      //
      // Measured honestly, this is a small win locally — median time-to-counts went 1787ms
      // sequential → 1652ms parallel, which is inside the noise on a fast connection. It is kept
      // because the saving scales with latency, and Seva's users are on Indian mobile networks
      // where three serial Supabase round trips cost real time.
      //
      // It is NOT the cause of the ~8s blank dashboard seen in dev. That was `next dev`
      // compiling /api/admin/provider-applications on first request (the same measurement showed
      // 12s on cold runs and 1.5s thereafter, with or without this change) and does not happen in
      // a production build. Do not "fix" that by restructuring this further.
      const [disputes, apps, categories] = await Promise.all([
        // Open disputes: admin_read_disputes opens this read; resolved ones are not "waiting".
        supabase.from('disputes').select('id', { head: true, count: 'exact' }).neq('status', 'resolved'),
        // Applications come from the service-role route — the kyc_* columns carry no client grant.
        fetchProviderApplications(),
        supabase.from('service_categories').select('id', { head: true, count: 'exact' }),
      ]);
      if (!active) return;
      // A failed count stays null so the card keeps showing "—". `?? 0` would render a confident
      // "0 open" for a read that never came back — telling an admin their queue is clear when it
      // may not be is worse than admitting we do not know.
      setCounts({
        disputes: disputes.error ? null : disputes.count ?? 0,
        providers: 'data' in apps ? (apps.data.applications ?? []).filter((a) => a.status === 'pending').length : null,
        categories: categories.error ? null : categories.count ?? 0,
      });
    })();
    return () => { active = false; };
  }, [guard]);

  if (guard !== 'ok') {
    return <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">Checking access…</div>;
  }

  const cards = [
    {
      href: '/admin/disputes', icon: Scale, title: 'Disputes',
      blurb: 'Cases waiting on a decision, with the full evidence bundle behind each.',
      count: counts.disputes, unit: 'open',
    },
    {
      href: '/admin/providers', icon: BadgeCheck, title: 'Provider applications',
      blurb: 'Nobody is bookable until approved here. Check the ID against the details.',
      count: counts.providers, unit: 'to review',
    },
    {
      href: '/admin/categories', icon: Tag, title: 'Service categories',
      blurb: 'What the marketplace sells. Only admins can add or remove one.',
      count: counts.categories, unit: 'live',
    },
  ];

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center gap-3 mb-2">
          <ShieldCheck className="w-7 h-7 text-[#FF9933]" />
          <h1 className="text-3xl font-black text-white">Admin</h1>
        </div>
        <p className="text-sm text-gray-400 mb-6">
          Everything here is gated on <span className="text-gray-300">role=&apos;admin&apos;</span>, which is
          server-controlled — the DB re-checks it on every read and write.
        </p>

        <AdminNav counts={{ disputes: counts.disputes ?? undefined, providers: counts.providers ?? undefined }} />

        <div className="space-y-3">
          {cards.map(({ href, icon: Icon, title, blurb, count, unit }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-4 bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 hover:border-[#FF9933]/40 transition-all group"
            >
              <div className="w-11 h-11 rounded-xl bg-[#FF9933]/10 flex items-center justify-center flex-shrink-0">
                <Icon className="w-5 h-5 text-[#FF9933]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">{title}</p>
                <p className="text-xs text-gray-400 mt-0.5">{blurb}</p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-xl font-black text-white">{count ?? '—'}</p>
                <p className="text-[11px] text-gray-500">{unit}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-[#FF9933] transition-colors flex-shrink-0" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
