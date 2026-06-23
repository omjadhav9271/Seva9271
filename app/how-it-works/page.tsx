import Link from 'next/link';
import {
  Search, Star, CheckCircle, Shield, Clock, Wallet, MapPin,
  MessageCircle, Bell, Award, TrendingUp, ArrowRight
} from 'lucide-react';

const customerSteps = [
  { icon: Search, title: 'Search Your Service', desc: 'Browse 14+ service categories or use smart search to find exactly what you need in your city.', color: '#FF9933' },
  { icon: Star, title: 'Choose a Provider', desc: 'Compare ratings, reviews, experience, and pricing. Read genuine reviews from verified customers.', color: '#138808' },
  { icon: CheckCircle, title: 'Book & Confirm', desc: 'Select your preferred date, time, and service duration. Choose one-time, weekly, or monthly plans.', color: '#054187' },
  { icon: Wallet, title: 'Secure Payment', desc: 'Pay via UPI (GPay, PhonePe), Seva Wallet, or Cash on Delivery. Money-back guarantee.', color: '#FF9933' },
];

const providerSteps = [
  { icon: Award, title: 'Apply & Verify', desc: 'Submit your application with documents. Background verification completed within 24 hours.', color: '#FF9933' },
  { icon: Bell, title: 'Receive Bookings', desc: 'Get instant notifications when customers book your service. Accept or decline as per availability.', color: '#138808' },
  { icon: Clock, title: 'Deliver Service', desc: 'Arrive on time, deliver quality service, and mark the job as complete through the app.', color: '#054187' },
  { icon: TrendingUp, title: 'Earn & Grow', desc: 'Get paid instantly after service completion. Build reviews and earn more over time.', color: '#FF9933' },
];

const faqs = [
  { q: 'How are providers verified?', a: 'Every provider undergoes identity verification (Aadhaar check), background screening, and skill assessment before being approved on the platform.' },
  { q: 'What payment methods are accepted?', a: 'We accept UPI (GPay, PhonePe, Paytm), Debit/Credit Cards, Seva Wallet, and Cash on Delivery for eligible services.' },
  { q: 'What is the Seva Wallet?', a: 'Seva Wallet is a digital wallet that earns 8% APR rewards on your balance. Upgrade to Gold or Platinum tier for exclusive benefits like priority booking and cashback.' },
  { q: 'Is there a money-back guarantee?', a: 'Yes! If you are unsatisfied with the service, contact support within 24 hours and we will arrange a refund or re-service at no extra cost.' },
  { q: 'Can I book recurring services?', a: 'Absolutely! Choose from one-time, weekly, monthly, or yearly plans. Great for tiffin service, house cleaning, or caretaker needs.' },
  { q: 'How do delivery gigs work?', a: 'Service providers who need delivery support can post gig listings. Delivery partners nearby can accept and earn by completing the delivery.' },
];

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-16">
      {/* Hero */}
      <section className="py-20 bg-[#0a0a0a] text-center">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <h1 className="text-4xl sm:text-5xl font-black text-white mb-4">
            How <span className="text-[#138808]">Seva</span> Works
          </h1>
          <p className="text-gray-400 text-lg mb-8">
            A simple, transparent process for both customers and service providers.
          </p>
          <div className="flex flex-wrap gap-4 justify-center">
            <Link href="/services" className="saffron-btn rounded-xl px-6 py-3 font-semibold text-sm">
              Book a Service
            </Link>
            <Link href="/become-provider" className="border border-[#138808]/50 text-[#138808] hover:bg-[#138808]/10 rounded-xl px-6 py-3 font-semibold text-sm transition-all">
              Become a Provider
            </Link>
          </div>
        </div>
      </section>

      {/* For Customers */}
      <section className="py-20 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <span className="text-[#FF9933] font-semibold text-sm uppercase tracking-wider">For Customers</span>
          <h2 className="text-3xl font-black text-white mt-2">Get Service in 4 Steps</h2>
        </div>

        <div className="grid md:grid-cols-4 gap-6 relative">
          <div className="hidden md:block absolute top-10 left-[calc(12.5%+24px)] right-[calc(12.5%+24px)] h-px bg-gradient-to-r from-[#FF9933]/30 via-[#138808]/30 to-[#FF9933]/30" />
          {customerSteps.map((step, i) => (
            <div key={step.title} className="text-center">
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg"
                style={{ background: `${step.color}20`, boxShadow: `0 8px 24px ${step.color}20` }}
              >
                <step.icon className="w-8 h-8" style={{ color: step.color }} />
              </div>
              <div className="w-8 h-8 rounded-full bg-[#FF9933] text-white text-sm font-black flex items-center justify-center mx-auto mb-3 -mt-2">
                {i + 1}
              </div>
              <h3 className="font-bold text-white mb-2">{step.title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* For Providers */}
      <section className="py-20 bg-[#0a0a0a]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <span className="text-[#138808] font-semibold text-sm uppercase tracking-wider">For Service Providers</span>
            <h2 className="text-3xl font-black text-white mt-2">Start Earning in 4 Steps</h2>
          </div>

          <div className="grid md:grid-cols-4 gap-6">
            {providerSteps.map((step, i) => (
              <div key={step.title} className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6 text-center seva-card-hover">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4" style={{ background: `${step.color}15` }}>
                  <step.icon className="w-6 h-6" style={{ color: step.color }} />
                </div>
                <div className="w-7 h-7 rounded-full bg-[#138808] text-white text-xs font-black flex items-center justify-center mx-auto mb-3">
                  {i + 1}
                </div>
                <h3 className="font-bold text-white mb-2">{step.title}</h3>
                <p className="text-sm text-gray-400 leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Key Features */}
      <section className="py-20 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="text-3xl font-black text-white text-center mb-12">Platform Features</h2>
        <div className="grid md:grid-cols-3 gap-6">
          {[
            { icon: Shield, title: 'Background Verified', desc: 'Every provider is ID-verified and background checked before approval.', color: '#FF9933' },
            { icon: Star, title: 'Genuine Reviews', desc: 'Only customers who actually booked can leave reviews. No fake ratings.', color: '#138808' },
            { icon: MapPin, title: 'Location Matching', desc: 'See providers near you first, sorted by distance and availability.', color: '#054187' },
            { icon: Wallet, title: 'Secure Payments', desc: 'Pay via UPI, wallet, or cash. Your money is protected until service is delivered.', color: '#FF9933' },
            { icon: MessageCircle, title: 'Direct Chat', desc: 'Chat directly with your provider for service details and updates.', color: '#138808' },
            { icon: Bell, title: 'Real-time Updates', desc: 'Get instant notifications on booking status, provider location, and more.', color: '#054187' },
          ].map((f) => (
            <div key={f.title} className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 flex gap-4 seva-card-hover">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${f.color}15` }}>
                <f.icon className="w-6 h-6" style={{ color: f.color }} />
              </div>
              <div>
                <h3 className="font-bold text-white mb-1">{f.title}</h3>
                <p className="text-sm text-gray-400 leading-relaxed">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 bg-[#0a0a0a]">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-black text-white text-center mb-12">Frequently Asked Questions</h2>
          <div className="space-y-4">
            {faqs.map((faq, i) => (
              <details
                key={i}
                className="group bg-[#161616] border border-[#2a2a2a] rounded-2xl overflow-hidden"
              >
                <summary className="flex items-center justify-between cursor-pointer px-6 py-5 text-white font-semibold hover:text-[#FF9933] transition-colors list-none">
                  {faq.q}
                  <ArrowRight className="w-4 h-4 text-gray-500 group-open:rotate-90 transition-transform flex-shrink-0" />
                </summary>
                <div className="px-6 pb-5 text-sm text-gray-400 leading-relaxed border-t border-[#222] pt-4">
                  {faq.a}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-3xl font-black text-white mb-4">Ready to Get Started?</h2>
        <p className="text-gray-400 mb-8">Join millions of Indians using Seva for trusted home services.</p>
        <div className="flex flex-wrap gap-4 justify-center">
          <Link href="/auth/signup" className="saffron-btn rounded-xl px-8 py-4 font-semibold">
            Create Free Account
          </Link>
          <Link href="/services" className="border border-[#FF9933]/40 text-[#FF9933] hover:bg-[#FF9933]/10 rounded-xl px-8 py-4 font-semibold transition-all">
            Browse Services
          </Link>
        </div>
      </section>
    </div>
  );
}
