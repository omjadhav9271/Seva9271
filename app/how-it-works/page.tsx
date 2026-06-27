import Link from 'next/link';
import { Search, UserCheck, Calendar, ArrowRight } from 'lucide-react';

const customerSteps = [
  { icon: Search, title: 'Find a Service', desc: 'Browse or search for what you need. Electrician, plumber, cook, and more.' },
  { icon: UserCheck, title: 'Pick a Provider', desc: 'See verified profiles with ratings, reviews, and pricing. Choose who fits you best.' },
  { icon: Calendar, title: 'Book & Relax', desc: 'Select a date and time. The provider arrives at your doorstep. Pay after the job is done.' },
];

const providerSteps = [
  { icon: UserCheck, title: 'Create Account', desc: 'Sign up and choose your service category. Plumber, electrician, cook, or anything else.' },
  { icon: Search, title: 'Get Verified', desc: 'Submit your Aadhaar and PAN. We verify you within 24 hours for customer safety.' },
  { icon: Calendar, title: 'Start Earning', desc: 'Set your availability and hourly rate. Customers book you directly. No middlemen.' },
];

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-16">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h1 className="text-3xl font-black text-white text-center mb-2">How It Works</h1>
        <p className="text-gray-400 text-center mb-12">Simple, transparent, and built for India.</p>

        {/* Customer Steps */}
        <h2 className="text-sm font-semibold text-[#FF9933] uppercase tracking-wider mb-6">For Customers</h2>
        <div className="space-y-4 mb-12">
          {customerSteps.map((step, i) => (
            <div key={step.title} className="bg-[#161616] border border-[#2a2a2a] rounded-xl p-5 flex gap-4">
              <div className="w-10 h-10 rounded-xl bg-[#FF9933]/10 flex items-center justify-center flex-shrink-0">
                <step.icon className="w-5 h-5 text-[#FF9933]" />
              </div>
              <div>
                <h3 className="font-bold text-white mb-1">{step.title}</h3>
                <p className="text-sm text-gray-400">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Provider Steps */}
        <h2 className="text-sm font-semibold text-[#138808] uppercase tracking-wider mb-6">For Providers</h2>
        <div className="space-y-4 mb-12">
          {providerSteps.map((step, i) => (
            <div key={step.title} className="bg-[#161616] border border-[#2a2a2a] rounded-xl p-5 flex gap-4">
              <div className="w-10 h-10 rounded-xl bg-[#138808]/10 flex items-center justify-center flex-shrink-0">
                <step.icon className="w-5 h-5 text-[#138808]" />
              </div>
              <div>
                <h3 className="font-bold text-white mb-1">{step.title}</h3>
                <p className="text-sm text-gray-400">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="text-center">
          <Link href="/services" className="saffron-btn rounded-xl px-6 py-3 font-semibold text-sm inline-flex items-center gap-2">
            Browse Services <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
