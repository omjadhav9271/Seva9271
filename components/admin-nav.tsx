'use client';

/* One tab strip across every admin page.

   The provider-application queue was fully built and effectively unreachable: the navbar's "Admin"
   link went only to /admin/disputes, and the sole route onward was a grey text link at the top of
   that page. Anything an admin does regularly should be one click from wherever they are. */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Scale, BadgeCheck, Tag, LayoutDashboard } from 'lucide-react';

const TABS = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/admin/disputes', label: 'Disputes', icon: Scale },
  { href: '/admin/providers', label: 'Providers', icon: BadgeCheck },
  { href: '/admin/categories', label: 'Categories', icon: Tag },
];

export default function AdminNav({ counts }: { counts?: { disputes?: number; providers?: number } }) {
  const pathname = usePathname();
  const countFor = (href: string) =>
    href === '/admin/disputes' ? counts?.disputes
      : href === '/admin/providers' ? counts?.providers
        : undefined;

  return (
    <div className="flex flex-wrap gap-2 mb-6">
      {TABS.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        const n = countFor(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium transition-all ${
              active
                ? 'bg-[#FF9933] text-white'
                : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/50 hover:text-white'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
            {n != null && n > 0 && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${active ? 'bg-white/20' : 'bg-[#FF9933]/15 text-[#FF9933]'}`}>
                {n}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
