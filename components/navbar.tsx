'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';

const navLinks = [
  { href: '/services', label: 'Services' },
  { href: '/how-it-works', label: 'How It Works' },
];

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { user } = useAuth();
  const pathname = usePathname();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[#0d0d0d]/90 backdrop-blur-md border-b border-[#2a2a2a]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href="/" className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xl font-bold text-[#138808]">Seva</span>
          </Link>

          <div className="hidden md:flex items-center gap-6">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm font-medium transition-colors ${
                  pathname === link.href ? 'text-[#FF9933]' : 'text-gray-300 hover:text-white'
                }`}
              >
                {link.label}
              </Link>
            ))}
            {user ? (
              <Link href="/profile" className="text-sm font-medium text-gray-300 hover:text-white transition-colors">
                Profile
              </Link>
            ) : (
              <Link href="/auth/signin" className="text-sm font-semibold bg-[#FF9933] hover:bg-[#e8872e] text-white px-4 py-2 rounded-lg transition-colors">
                Sign In
              </Link>
            )}
          </div>

          <button className="md:hidden p-2 text-gray-300 hover:text-white" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="md:hidden bg-[#0d0d0d] border-t border-[#2a2a2a]">
          <div className="px-4 py-4 space-y-2">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className={`block px-4 py-3 rounded-lg text-sm font-medium ${
                  pathname === link.href ? 'text-[#FF9933]' : 'text-gray-300'
                }`}
              >
                {link.label}
              </Link>
            ))}
            {user ? (
              <Link href="/profile" className="block px-4 py-3 rounded-lg text-sm font-medium text-gray-300">Profile</Link>
            ) : (
              <Link href="/auth/signin" className="block px-4 py-3 rounded-lg text-sm font-semibold bg-[#FF9933] text-white text-center">Sign In</Link>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
