'use client';

import Link from 'next/link';
import { Search, ArrowRight, Star, Shield, MapPin } from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-screen bg-[#0d0d0d]">
      {/* Hero */}
      <section className="min-h-screen flex items-center justify-center pt-16">
        <div className="max-w-2xl mx-auto px-6 text-center">
          <div className="flex items-center justify-center gap-3 mb-6">
            <span className="text-4xl">🙏</span>
            <h1 className="text-5xl font-black text-[#138808]">Seva</h1>
            <span className="text-4xl">🙏</span>
          </div>

          <h2 className="text-3xl font-bold text-white mb-4">
            Find Trusted Service Providers Near You
          </h2>

          <p className="text-gray-400 text-lg mb-8 max-w-lg mx-auto">
            Book verified electricians, plumbers, home cooks, and more.
            Built for middle-class India.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/services"
              className="saffron-btn rounded-xl px-8 py-3.5 font-semibold text-sm flex items-center justify-center gap-2"
            >
              <Search className="w-4 h-4" />
              Browse Services
            </Link>
            <Link
              href="/how-it-works"
              className="border border-[#2a2a2a] text-gray-300 hover:text-white hover:border-[#FF9933]/50 rounded-xl px-8 py-3.5 font-semibold text-sm transition-all"
            >
              How It Works
            </Link>
          </div>

          <div className="flex items-center justify-center gap-8 mt-12">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Shield className="w-4 h-4 text-[#138808]" />
              KYC Verified
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Star className="w-4 h-4 text-[#FF9933]" />
              Real Reviews
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <MapPin className="w-4 h-4 text-[#FF9933]" />
              GPS Enabled
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
