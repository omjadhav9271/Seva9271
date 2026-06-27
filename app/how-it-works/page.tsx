import Link from 'next/link';
import {
  Search, Star, CheckCircle, Shield, Clock, Wallet, MapPin,
  MessageCircle, Bell, Award, ArrowRight, User,
  Map, CreditCard, Heart, Share2, Calendar,
  Smartphone, Fingerprint, Users, FileCheck,
  LogIn
} from 'lucide-react';

const customerAppSteps = [
  {
    icon: LogIn,
    title: 'Sign Up or Sign In',
    desc: 'Open Seva on your phone or browser. Tap Get Started. Enter your name, email, and mobile number. We will send an OTP to verify. No long forms, just one minute to join.',
    color: '#FF9933',
    step: 1
  },
  {
    icon: Map,
    title: 'Enable GPS Location',
    desc: 'Tap Allow Location on your phone. Seva uses your GPS to find service providers closest to you. No need to type your city manually. You can see exactly how far each provider is from your home in real-time.',
    color: '#138808',
    step: 2
  },
  {
    icon: Search,
    title: 'Browse or Search Services',
    desc: 'Choose from 25+ services — Electrician, Plumber, Home Cook, House Help, Painter, Mason, Auto Driver, Mobile Repair, Tailor, and more. Use the search bar to type what you need, or browse by category. Tap any service card to see nearby providers.',
    color: '#FF9933',
    step: 3
  },
  {
    icon: Star,
    title: 'Select a Provider',
    desc: 'See a list of providers sorted by distance. Tap any provider to see their full profile: photo, rating, reviews, experience, hourly rate, phone number, address, and work hours. You can also view their location on Google Maps.',
    color: '#FF9933',
    step: 4
  },
  {
    icon: Calendar,
    title: 'Book Date & Time',
    desc: 'Tap Book Now on the provider profile. Choose a date from the calendar. Pick a time slot: 9 AM, 11 AM, 2 PM, 4 PM, 6 PM, or 8 PM. Select if you need one-time service, weekly, monthly, or yearly. Add any special notes about the work.',
    color: '#054187',
    step: 5
  },
  {
    icon: CreditCard,
    title: 'Choose Payment & Confirm',
    desc: 'Pay via UPI (GPay, PhonePe, Paytm), Seva Wallet, or Cash on Delivery. If you choose UPI, you will be redirected to your app. If you choose Wallet, money is deducted instantly. If COD, pay the provider when they arrive. Tap Confirm Booking.',
    color: '#138808',
    step: 6
  },
  {
    icon: Bell,
    title: 'Track & Get Notified',
    desc: 'After booking, you will get an SMS and in-app notification. When the provider is on the way, you get another alert with their live location. You can call them directly if needed. Once the work is done, mark it complete and leave a review.',
    color: '#FF9933',
    step: 7
  },
];

const providerSteps = [
  {
    icon: User,
    title: 'Create Your Account',
    desc: 'Open Seva, tap Sign Up, enter your name, email, and mobile number. Verify with OTP. Then go to your Profile page and tap the Become a Provider button.',
    color: '#FF9933',
    step: 1
  },
  {
    icon: FileCheck,
    title: 'Submit Your Details',
    desc: 'Fill in your business name, select which service you provide (e.g., Electrician, Plumber, Home Cook), set your hourly rate, describe your experience, and upload a profile photo. Enter your work address and city.',
    color: '#138808',
    step: 2
  },
  {
    icon: Fingerprint,
    title: 'Complete KYC Verification',
    desc: 'Upload your Aadhaar card number, PAN card number, and a selfie photo. Optionally add your Voter ID, electricity bill, or rent agreement as address proof. Enter your emergency contact name and relation. This data is encrypted and only used for verification.',
    color: '#054187',
    step: 3
  },
  {
    icon: Shield,
    title: 'Background & Police Check',
    desc: 'Our team will verify your Aadhaar and PAN through official channels. We also check for any police records. If you have a police verification certificate, upload it. This process usually takes 24 to 48 hours.',
    color: '#FF9933',
    step: 4
  },
  {
    icon: Clock,
    title: 'Set Your Working Hours',
    desc: 'Set when you are open for work. Choose which days of the week you are available (Mon-Sun). Set your opening time and closing time. You can open or close your availability anytime with one tap. This helps customers see only when you are free.',
    color: '#138808',
    step: 5
  },
  {
    icon: Bell,
    title: 'Receive & Accept Bookings',
    desc: 'Once approved, your profile goes live. Customers near you can see you and book. You get a notification on your phone and a WhatsApp message. You can accept the booking, decline it, or suggest a different time.',
    color: '#054187',
    step: 6
  },
  {
    icon: Wallet,
    title: 'Earn & Get Paid',
    desc: 'After completing the work, the customer pays you via the app or in cash. For app payments, money is transferred to your linked bank account within 24 hours. The more jobs you complete and the better your reviews, the higher you appear in search results.',
    color: '#FF9933',
    step: 7
  },
];

const faqs = [
  { q: 'How are providers verified?', a: 'Every provider undergoes Aadhaar identity verification, PAN check, background screening, and optional police verification before being approved on the platform. Your safety is our priority.' },
  { q: 'What payment methods are accepted?', a: 'We accept UPI (GPay, PhonePe, Paytm), Debit/Credit Cards, Seva Wallet, and Cash on Delivery for eligible services. All payments are encrypted and secure.' },
  { q: 'What is the Seva Wallet?', a: 'Seva Wallet is a digital wallet that earns rewards on your balance. You can top up via UPI and use it for instant bookings. Wallet users get priority access to top-rated providers.' },
  { q: 'Is there a money-back guarantee?', a: 'Yes. If you are unsatisfied with the service, contact support within 24 hours and we will arrange a refund or re-service at no extra cost.' },
  { q: 'Can I book recurring services?', a: 'Absolutely. Choose from one-time, weekly, monthly, or yearly plans. Great for tiffin service, house cleaning, or caretaker needs.' },
  { q: 'How do I become a provider?', a: 'Sign up, go to your Profile, tap Become a Provider, fill your details, complete KYC, and wait 24-48 hours for approval. Once approved, you can start receiving bookings immediately.' },
  { q: 'How do I track my provider?', a: 'Once a provider accepts your booking and starts moving, you see their live location on Google Maps inside the app. Similar to how you track an Uber driver.' },
  { q: 'What services are available?', a: 'We have 25+ services: Electrician, Plumber, Home Cook, House Cleaning, Caretaker, Driver, Home-Visit Doctor, Tutor, Appliance Repair, Carpenter, Gardening, Beauty, Farm Fresh Delivery, Delivery, Painter, Mason, Laundry, Security Guard, Maid, Auto Rickshaw, Cycle Mechanic, Mobile Repair, Water Tanker, Cow Dung Manure, and Tailor.' },
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
          <p className="text-gray-400 text-lg mb-4">
            A simple, transparent process for both customers and service providers.
            Built for middle-class India.
          </p>
          <p className="text-gray-500 text-sm mb-8">
            25+ Indian services | GPS-enabled | KYC-verified | Secure payments
          </p>
          <div className="flex flex-wrap gap-4 justify-center">
            <Link href="/services" className="saffron-btn rounded-xl px-6 py-3 font-semibold text-sm">
              Book a Service
            </Link>
            <Link href="/profile" className="border border-[#138808]/50 text-[#138808] hover:bg-[#138808]/10 rounded-xl px-6 py-3 font-semibold text-sm transition-all">
              Become a Provider
            </Link>
          </div>
        </div>
      </section>

      {/* For Customers - Detailed App Guide */}
      <section className="py-20 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <span className="text-[#FF9933] font-semibold text-sm uppercase tracking-wider">For Customers</span>
          <h2 className="text-3xl sm:text-4xl font-black text-white mt-2">How to Book a Service</h2>
          <p className="text-gray-400 text-sm mt-2 max-w-xl mx-auto">
            A step-by-step guide on how to use the Seva app to find and book verified service providers near you.
          </p>
        </div>

        <div className="space-y-6">
          {customerAppSteps.map((step, i) => (
            <div key={step.title} className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6 flex gap-5 seva-card-hover">
              <div className="flex-shrink-0">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: `${step.color}20` }}>
                  <step.icon className="w-6 h-6" style={{ color: step.color }} />
                </div>
                <div className="w-px h-full mx-auto bg-[#2a2a2a] mt-4" />
              </div>
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="w-7 h-7 rounded-full bg-[#FF9933] text-white text-xs font-black flex items-center justify-center">
                    {step.step}
                  </span>
                  <h3 className="font-bold text-white text-lg">{step.title}</h3>
                </div>
                <p className="text-sm text-gray-400 leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* For Providers - Detailed Guide */}
      <section className="py-20 bg-[#0a0a0a]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <span className="text-[#138808] font-semibold text-sm uppercase tracking-wider">For Service Providers</span>
            <h2 className="text-3xl sm:text-4xl font-black text-white mt-2">How to Become a Provider</h2>
            <p className="text-gray-400 text-sm mt-2 max-w-xl mx-auto">
              Start earning by listing your skills. Complete KYC in minutes, set your hours, and get bookings from customers near you.
            </p>
          </div>

          <div className="space-y-6">
            {providerSteps.map((step, i) => (
              <div key={step.title} className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-6 flex gap-5 seva-card-hover">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: `${step.color}20` }}>
                    <step.icon className="w-6 h-6" style={{ color: step.color }} />
                  </div>
                  <div className="w-px h-full mx-auto bg-[#2a2a2a] mt-4" />
                </div>
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="w-7 h-7 rounded-full bg-[#138808] text-white text-xs font-black flex items-center justify-center">
                      {step.step}
                    </span>
                    <h3 className="font-bold text-white text-lg">{step.title}</h3>
                  </div>
                  <p className="text-sm text-gray-400 leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Key Features */}
      <section className="py-20 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="text-3xl font-black text-white text-center mb-12">What Makes Seva Different</h2>
        <div className="grid md:grid-cols-3 gap-6">
          {[
            { icon: Shield, title: 'KYC Verified Every Provider', desc: 'Aadhaar, PAN, and background checks are mandatory. No anonymous providers. Every person you hire is verified.', color: '#FF9933' },
            { icon: Star, title: 'Real Reviews Only', desc: 'Only customers who actually booked a service can leave a review. No fake ratings. No paid reviews. What you see is what you get.', color: '#138808' },
            { icon: MapPin, title: 'GPS Location Tracking', desc: 'See the nearest providers first. Track their arrival on a live map like Uber. Know exactly where they are and how long they will take.', color: '#054187' },
            { icon: Wallet, title: 'Multiple Payment Options', desc: 'Pay via UPI, Seva Wallet, or Cash on Delivery. Your money is protected. We hold payment until service is confirmed complete.', color: '#FF9933' },
            { icon: MessageCircle, title: 'Direct Communication', desc: 'Call or chat directly with your provider before and after booking. No middlemen. Direct connection between customer and service worker.', color: '#138808' },
            { icon: Clock, title: 'Open/Close Availability', desc: 'Providers can open or close their availability with one tap. Customers only see providers who are actually ready to work right now.', color: '#054187' },
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
              <details key={i} className="group bg-[#161616] border border-[#2a2a2a] rounded-2xl overflow-hidden">
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
        <p className="text-gray-400 mb-8">Join Seva today. Whether you need a service or want to earn, we are here for you.</p>
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
