'use client';

/* Client-side only so it can read the signed-in role. The footer is otherwise static, and it was
   a server component until an admin browsing the site kept being invited to "Become a Provider"
   in the sitemap — item 17 fixed the navbar and missed this. Same rule as the navbar, applied in
   one place instead of two: an admin never books, never holds a balance and never applies.

   Presentation only. `role` is server-controlled and every admin surface re-checks it in RLS;
   hiding a link has never been the boundary. */

import Link from 'next/link';
import { MapPin, Phone, Mail } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';

const popularServices = [
  { label: 'Electrician Services', href: '/services?category=electrician' },
  { label: 'Plumbing Services', href: '/services?category=plumber' },
  { label: 'Home Cleaning', href: '/services?category=house-cleaning' },
  { label: 'Home Cook / Tiffin', href: '/services?category=home-cook' },
  { label: 'Tutoring Services', href: '/services?category=tutor' },
];

/* Item 22 — a link that goes somewhere unrelated is worse than one that admits it isn't built.
   Seven of these nine pointed at /how-it-works, so "Privacy Policy" quietly delivered the
   how-it-works page: the user cannot tell whether they misread the link or the site is broken,
   and there is nothing to signal which. Unbuilt destinations are now rendered as plain text with
   a "Soon" chip instead of links that misroute.

   ⚠️ Privacy Policy and Terms of Service are marked the same way, but they are NOT the same kind
   of gap: they are a legal requirement before public launch, not a nice-to-have. Flagged in
   /docs/Seva-Decisions-Log.md so the honest label here doesn't become a way to forget them. */

// 'Become a Provider' is split out rather than filtered by label — a string comparison against
// display copy silently stops working the day someone rewords the link.
const company = [
  { label: 'About Us', soon: true },
  { label: 'How It Works', href: '/how-it-works' },
  { label: 'Careers', soon: true },
  { label: 'Press & Media', soon: true },
];

const becomeProvider = { label: 'Become a Provider', href: '/become-provider' };

const support = [
  { label: 'Help Center', soon: true },
  { label: 'Safety Guidelines', soon: true },
  { label: 'Privacy Policy', soon: true },
  { label: 'Terms of Service', soon: true },
];

type FooterLink = { label: string; href?: string; soon?: boolean };

function FooterItem({ item }: { item: FooterLink }) {
  if (item.href) {
    return (
      <Link href={item.href} className="text-sm text-blue-200/70 hover:text-white transition-colors">
        {item.label}
      </Link>
    );
  }
  return (
    <span className="text-sm text-blue-200/40 inline-flex items-center gap-1.5 cursor-default" title={`${item.label} — coming soon`}>
      {item.label}
      <span className="text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded bg-white/10 text-blue-200/50">
        Soon
      </span>
    </span>
  );
}

export default function Footer() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  // Insert it where it has always been (third), so the ordering doesn't shuffle for everyone else.
  const companyLinks = isAdmin
    ? company
    : [...company.slice(0, 2), becomeProvider, ...company.slice(2)];

  return (
    <footer style={{ backgroundColor: '#0d1b4b' }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10">
          {/* Brand */}
          <div>
            <Link href="/" className="flex items-center gap-2 mb-4">
              <span className="text-2xl">🙏</span>
              <span className="text-2xl font-bold text-white">Seva</span>
              <span className="text-2xl">🙏</span>
            </Link>
            <p className="text-blue-200/70 text-sm leading-relaxed mb-5">
              Connecting you with verified service providers across India. From home services to professional help, we've got you covered.
            </p>
            <div className="flex items-center gap-2 text-sm text-blue-200/60">
              <MapPin className="w-4 h-4 text-blue-300 flex-shrink-0" />
              <span>Mumbai, Maharashtra, India</span>
            </div>
          </div>

          {/* Popular Services */}
          <div>
            <h3 className="text-white font-semibold mb-5">Popular Services</h3>
            <ul className="space-y-3">
              {popularServices.map((s) => (
                <li key={s.href}>
                  <Link href={s.href} className="text-sm text-blue-200/70 hover:text-white transition-colors">
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-white font-semibold mb-5">Company</h3>
            <ul className="space-y-3">
              {companyLinks.map((c) => (
                <li key={c.label}><FooterItem item={c} /></li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <h3 className="text-white font-semibold mb-5">Support</h3>
            <ul className="space-y-3 mb-5">
              {support.map((s) => (
                <li key={s.label}><FooterItem item={s} /></li>
              ))}
            </ul>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-blue-200/70">
                <Phone className="w-4 h-4 text-blue-300 flex-shrink-0" />
                <span>+91 98765 43210</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-blue-200/70">
                <Mail className="w-4 h-4 text-blue-300 flex-shrink-0" />
                <span>support@seva.com</span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-10 pt-6 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-blue-200/50">
            © {new Date().getFullYear()} Seva Marketplace Pvt. Ltd. All rights reserved.
          </p>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-[#FF9933]" />
            <span className="w-3 h-3 rounded-full bg-white" />
            <span className="w-3 h-3 rounded-full bg-[#138808]" />
            <span className="ml-2 text-xs text-blue-200/40">Proudly Indian</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
