import Link from 'next/link';
import { MapPin, Mail, HelpCircle } from 'lucide-react';

const popularServices = [
  { label: 'Electrician', href: '/services?category=electrician' },
  { label: 'Plumber', href: '/services?category=plumber' },
  { label: 'Home Cook / Tiffin', href: '/services?category=home-cook' },
  { label: 'House Cleaning', href: '/services?category=house-cleaning' },
  { label: 'Painter', href: '/services?category=painter' },
  { label: 'Maid / House Help', href: '/services?category=maid' },
  { label: 'Auto Driver', href: '/services?category=auto-driver' },
  { label: 'Mobile Repair', href: '/services?category=mobile-repair' },
  { label: 'Tailor', href: '/services?category=tailor' },
  { label: 'Water Tanker', href: '/services?category=water-tanker' },
];

const company = [
  { label: 'About Us', href: '/how-it-works' },
  { label: 'How It Works', href: '/how-it-works' },
  { label: 'How to Become a Provider', href: '/how-it-works' },
  { label: 'Careers', href: '/how-it-works' },
];

const support = [
  { label: 'Help Center', href: '/how-it-works' },
  { label: 'Safety Guidelines', href: '/how-it-works' },
  { label: 'Privacy Policy', href: '/how-it-works' },
  { label: 'Terms of Service', href: '/how-it-works' },
];

export default function Footer() {
  return (
    <footer className="bg-[#0a0a0a] border-t border-[#1a1a1a]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10">
          {/* Brand */}
          <div>
            <Link href="/" className="flex items-center gap-2 mb-4">
              <span className="text-2xl">🙏</span>
              <span className="text-2xl font-bold text-[#138808]">Seva</span>
              <span className="text-2xl">🙏</span>
            </Link>
            <p className="text-gray-500 text-sm leading-relaxed mb-5">
              Connecting middle-class India with verified service providers. 25+ services, GPS-enabled, KYC-verified.
            </p>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <MapPin className="w-4 h-4 text-[#FF9933] flex-shrink-0" />
              <span>India</span>
            </div>
          </div>

          {/* Popular Services */}
          <div>
            <h3 className="text-white font-semibold mb-5 text-sm">Our Services</h3>
            <ul className="space-y-2">
              {popularServices.map((s) => (
                <li key={s.href}>
                  <Link href={s.href} className="text-sm text-gray-500 hover:text-[#FF9933] transition-colors">
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-white font-semibold mb-5 text-sm">Company</h3>
            <ul className="space-y-2">
              {company.map((c) => (
                <li key={c.label}>
                  <Link href={c.href} className="text-sm text-gray-500 hover:text-[#FF9933] transition-colors">
                    {c.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <h3 className="text-white font-semibold mb-5 text-sm">Support</h3>
            <ul className="space-y-2 mb-5">
              {support.map((s) => (
                <li key={s.label}>
                  <Link href={s.href} className="text-sm text-gray-500 hover:text-[#FF9933] transition-colors">
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <HelpCircle className="w-4 h-4 text-[#FF9933] flex-shrink-0" />
                <span>Support via Help Center</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Mail className="w-4 h-4 text-[#FF9933] flex-shrink-0" />
                <span>Contact via app</span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-10 pt-6 border-t border-[#1a1a1a] flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-gray-600">
            &copy; {new Date().getFullYear()} Seva. All rights reserved.
          </p>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-[#FF9933]" />
            <span className="w-3 h-3 rounded-full bg-white" />
            <span className="w-3 h-3 rounded-full bg-[#138808]" />
            <span className="ml-2 text-xs text-gray-600">Proudly Indian</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
