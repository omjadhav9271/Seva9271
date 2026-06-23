import Link from 'next/link';
import { MapPin, Phone, Mail } from 'lucide-react';

const popularServices = [
  { label: 'Electrician Services', href: '/services?category=electrician' },
  { label: 'Plumbing Services', href: '/services?category=plumber' },
  { label: 'Home Cleaning', href: '/services?category=house-cleaning' },
  { label: 'Home Cook / Tiffin', href: '/services?category=home-cook' },
  { label: 'Tutoring Services', href: '/services?category=tutor' },
];

const company = [
  { label: 'About Us', href: '/how-it-works' },
  { label: 'How It Works', href: '/how-it-works' },
  { label: 'Become a Provider', href: '/become-provider' },
  { label: 'Careers', href: '/how-it-works' },
  { label: 'Press & Media', href: '/how-it-works' },
];

const support = [
  { label: 'Help Center', href: '/how-it-works' },
  { label: 'Safety Guidelines', href: '/how-it-works' },
  { label: 'Privacy Policy', href: '/how-it-works' },
  { label: 'Terms of Service', href: '/how-it-works' },
];

export default function Footer() {
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
              {company.map((c) => (
                <li key={c.label}>
                  <Link href={c.href} className="text-sm text-blue-200/70 hover:text-white transition-colors">
                    {c.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <h3 className="text-white font-semibold mb-5">Support</h3>
            <ul className="space-y-3 mb-5">
              {support.map((s) => (
                <li key={s.label}>
                  <Link href={s.href} className="text-sm text-blue-200/70 hover:text-white transition-colors">
                    {s.label}
                  </Link>
                </li>
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
