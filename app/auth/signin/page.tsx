'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Mail, Lock, ArrowRight } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { toast } from 'sonner';

export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuth();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error('Please fill in all fields');
      return;
    }
    setLoading(true);
    const { error } = await signIn(email, password);
    setLoading(false);
    if (error) {
      toast.error(error);
    } else {
      toast.success('Welcome back!');
      router.push('/');
    }
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d] flex items-center justify-center px-4 pt-16">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-20 left-1/4 w-96 h-96 bg-[#FF9933]/6 rounded-full blur-[120px]" />
        <div className="absolute bottom-20 right-1/4 w-96 h-96 bg-[#138808]/6 rounded-full blur-[120px]" />
      </div>

      <div className="w-full max-w-md relative">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2">
            <span className="text-3xl">🙏</span>
            <span className="text-3xl font-black text-[#138808]">Seva</span>
            <span className="text-3xl">🙏</span>
          </Link>
          <h1 className="text-2xl font-black text-white mt-4">Welcome back</h1>
          <p className="text-gray-400 text-sm mt-1">Sign in to your Seva account</p>
        </div>

        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-gray-500" style={{ width: '18px', height: '18px' }} />
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
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-300">Password</label>
                <Link href="/auth/forgot-password" className="text-xs text-[#FF9933] hover:text-[#e8872e] transition-colors">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" style={{ width: '18px', height: '18px' }} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
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
            </div>

            <button
              type="submit"
              disabled={loading}
              className="saffron-btn w-full rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>Sign In <ArrowRight className="w-4 h-4" /></>
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-[#2a2a2a]" />
            <span className="text-xs text-gray-600">OR</span>
            <div className="flex-1 h-px bg-[#2a2a2a]" />
          </div>

          {/* Demo Accounts */}
          <div className="space-y-2 mb-6">
            <p className="text-xs text-gray-500 text-center mb-3">Quick demo access</p>
            {[
              { label: 'Customer Demo', email: 'customer@seva.demo', icon: '👤' },
              { label: 'Provider Demo', email: 'provider@seva.demo', icon: '🔧' },
            ].map((demo) => (
              <button
                key={demo.email}
                onClick={() => { setEmail(demo.email); setPassword('demo1234'); }}
                className="w-full flex items-center gap-3 px-4 py-3 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl text-sm text-gray-300 hover:border-[#FF9933]/50 hover:text-white transition-all"
              >
                <span>{demo.icon}</span>
                <span>{demo.label}</span>
                <span className="ml-auto text-xs text-gray-500">{demo.email}</span>
              </button>
            ))}
          </div>

          <p className="text-center text-sm text-gray-400">
            Don't have an account?{' '}
            <Link href="/auth/signup" className="text-[#FF9933] hover:text-[#e8872e] font-semibold transition-colors">
              Sign up free
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
