'use client';

/* Step one of password recovery: ask for the address, send the link.

   The whole page is built around one rule — it must behave IDENTICALLY for an address that has a
   Seva account and one that does not. Supabase already does its half (it reports success either
   way and simply sends nothing to an unknown address); the UI has to not undo that. So there is no
   "no account found" branch anywhere below, and the confirmation names the address the visitor
   typed rather than confirming it exists. A reset form that distinguishes the two cases is a free
   account-enumeration oracle: type an address, learn whether that person is on Seva.

   The one thing that IS surfaced is Supabase's rate-limit error, because that is a fact about the
   request rather than about the account, and swallowing it would leave someone tapping a button
   that silently does nothing. */

import { useState } from 'react';
import Link from 'next/link';
import { Mail, ArrowRight, ArrowLeft, MailCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { toast } from 'sonner';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const { requestPasswordReset } = useAuth();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast.error('Please enter your email address');
      return;
    }
    setLoading(true);
    const { error } = await requestPasswordReset(email.trim());
    setLoading(false);
    if (error) {
      // Rate limiting lands here ("you can only request this after N seconds"). A missing account
      // does not — Supabase reports that as success, which is the point.
      toast.error(error);
      return;
    }
    setSent(true);
  };

  // relative + overflow-hidden — clips the decorative blobs, same as signin/signup.
  return (
    <div className="relative overflow-hidden min-h-screen bg-[#0d0d0d] flex items-center justify-center px-4 pt-20">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-20 left-1/4 w-96 h-96 bg-[#FF9933]/6 rounded-full blur-[120px]" />
        <div className="absolute bottom-20 right-1/4 w-96 h-96 bg-[#138808]/6 rounded-full blur-[120px]" />
      </div>

      <div className="w-full max-w-md relative">
        {/* Plain text, not a link: `/` is behind AuthGate, so for the only visitor who sees this
            page it would be a control that bounces straight to sign-in. */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2">
            <span className="text-3xl">🙏</span>
            <span className="text-3xl font-black text-[#138808]">Seva</span>
            <span className="text-3xl">🙏</span>
          </div>
          <h1 className="text-2xl font-black text-white mt-4">
            {sent ? 'Check your email' : 'Reset your password'}
          </h1>
          <p className="text-gray-400 text-sm mt-1">
            {sent
              ? 'The link is only good for one use'
              : "We'll email you a link to set a new one"}
          </p>
        </div>

        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-8">
          {sent ? (
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-[#138808]/10 border border-[#138808]/30 flex items-center justify-center mx-auto mb-5">
                <MailCheck className="w-7 h-7 text-[#138808]" />
              </div>
              {/* "If … has an account" is doing real work — it is what keeps this screen from
                  confirming whether the address is registered. */}
              <p className="text-sm text-gray-300 leading-relaxed">
                If <span className="text-white font-semibold break-all">{email.trim()}</span> has a
                Seva account, a password reset link is on its way.
              </p>
              <p className="text-xs text-gray-500 mt-3 leading-relaxed">
                It expires in about an hour. Nothing in your inbox? Check spam, then try again —
                and make sure the address matches the one you signed up with.
              </p>

              <button
                onClick={() => { setSent(false); }}
                className="w-full mt-6 px-4 py-3 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl text-sm text-gray-300 hover:border-[#FF9933]/50 hover:text-white transition-all"
              >
                Use a different address
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" style={{ width: '18px', height: '18px' }} />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    autoComplete="email"
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl pl-10 pr-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#FF9933] transition-colors"
                    required
                  />
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Use the address you signed up with.
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="saffron-btn w-full rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>Send reset link <ArrowRight className="w-4 h-4" /></>
                )}
              </button>
            </form>
          )}

          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-[#2a2a2a]" />
            <span className="text-xs text-gray-600">OR</span>
            <div className="flex-1 h-px bg-[#2a2a2a]" />
          </div>

          <Link
            href="/auth/signin"
            className="flex items-center justify-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
