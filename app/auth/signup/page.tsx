'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Mail, Lock, User, ArrowRight, CheckCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { toast } from 'sonner';

export default function SignUpPage() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [role, setRole] = useState<'customer' | 'provider'>('customer');
  const { signUp } = useAuth();
  const router = useRouter();

  const passwordStrength = password.length === 0 ? 0 : password.length < 6 ? 1 : password.length < 8 ? 2 : 3;
  const strengthLabels = ['', 'Weak', 'Fair', 'Strong'];
  const strengthColors = ['', 'bg-red-500', 'bg-yellow-500', 'bg-[#138808]'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName || !email || !password) {
      toast.error('Please fill in all fields');
      return;
    }
    if (password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    const { error } = await signUp(email, password, fullName);
    setLoading(false);
    if (error) {
      toast.error(error);
    } else {
      toast.success('Account created! Welcome to Seva.');
      router.push('/');
    }
  };

  const benefits = [
    'Book verified service providers',
    'Earn 8% APR on wallet balance',
    'Real-time tracking & updates',
    'Money-back guarantee',
  ];

  return (
    <div className="min-h-screen bg-[#0d0d0d] flex items-center justify-center px-4 pt-16 pb-10">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-20 right-1/4 w-96 h-96 bg-[#FF9933]/6 rounded-full blur-[120px]" />
        <div className="absolute bottom-20 left-1/4 w-96 h-96 bg-[#138808]/6 rounded-full blur-[120px]" />
      </div>

      <div className="w-full max-w-md relative">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2">
            <span className="text-3xl">🙏</span>
            <span className="text-3xl font-black text-[#138808]">Seva</span>
            <span className="text-3xl">🙏</span>
          </Link>
          <h1 className="text-2xl font-black text-white mt-4">Create your account</h1>
          <p className="text-gray-400 text-sm mt-1">Join India's #1 service marketplace</p>
        </div>

        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-8">
          {/* Role Selection */}
          <div className="mb-6">
            <label className="text-sm font-medium text-gray-300 block mb-3">I want to...</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setRole('customer')}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium transition-all ${role === 'customer' ? 'bg-[#FF9933]/10 border-[#FF9933]/40 text-[#FF9933]' : 'bg-[#1e1e1e] border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/30'}`}
              >
                <User className="w-4 h-4" />
                <div className="text-left">
                  <p className="font-semibold">Hire</p>
                  <p className="text-[10px] opacity-70">Book services</p>
                </div>
              </button>
              <button
                onClick={() => setRole('provider')}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium transition-all ${role === 'provider' ? 'bg-[#FF9933]/10 border-[#FF9933]/40 text-[#FF9933]' : 'bg-[#1e1e1e] border-[#2a2a2a] text-gray-400 hover:border-[#FF9933]/30'}`}
              >
                <span className="text-lg">🔧</span>
                <div className="text-left">
                  <p className="font-semibold">Provide</p>
                  <p className="text-[10px] opacity-70">Offer services</p>
                </div>
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Full Name */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Full Name</label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" style={{ width: '18px', height: '18px' }} />
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Your full name"
                  className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl pl-10 pr-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#FF9933] transition-colors"
                  required
                />
              </div>
            </div>

            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" style={{ width: '18px', height: '18px' }} />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl pl-10 pr-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#FF9933] transition-colors"
                  required
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Password</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" style={{ width: '18px', height: '18px' }} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl pl-10 pr-12 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#FF9933] transition-colors"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {showPassword ? <EyeOff style={{ width: '18px', height: '18px' }} /> : <Eye style={{ width: '18px', height: '18px' }} />}
                </button>
              </div>

              {/* Password Strength */}
              {password && (
                <div className="mt-2">
                  <div className="flex gap-1 mb-1">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`flex-1 h-1 rounded-full transition-all ${i <= passwordStrength ? strengthColors[passwordStrength] : 'bg-[#2a2a2a]'}`}
                      />
                    ))}
                  </div>
                  <p className={`text-xs ${passwordStrength === 1 ? 'text-red-400' : passwordStrength === 2 ? 'text-yellow-400' : 'text-[#138808]'}`}>
                    {strengthLabels[passwordStrength]} password
                  </p>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="saffron-btn w-full rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>Create Account <ArrowRight className="w-4 h-4" /></>
              )}
            </button>
          </form>

          {/* Benefits */}
          <div className="mt-6 pt-5 border-t border-[#222]">
            <div className="grid grid-cols-2 gap-2">
              {benefits.map((b) => (
                <div key={b} className="flex items-start gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5 text-[#138808] mt-0.5 flex-shrink-0" />
                  <span className="text-xs text-gray-400 leading-relaxed">{b}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-center text-sm text-gray-400 mt-5">
            Already have an account?{' '}
            <Link href="/auth/signin" className="text-[#FF9933] hover:text-[#e8872e] font-semibold transition-colors">
              Sign in
            </Link>
          </p>
        </div>

        <p className="text-center text-xs text-gray-600 mt-4">
          By creating an account, you agree to our{' '}
          <Link href="/terms" className="text-gray-500 hover:text-gray-300">Terms</Link>{' '}
          and{' '}
          <Link href="/privacy" className="text-gray-500 hover:text-gray-300">Privacy Policy</Link>
        </p>
      </div>
    </div>
  );
}
