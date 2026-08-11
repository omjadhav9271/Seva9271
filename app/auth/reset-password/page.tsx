'use client';

/* Step two of password recovery: where the emailed link lands.

   HOW THE LINK ARRIVES. `lib/supabase.ts` creates the client with no auth options, so supabase-js
   is on its default **implicit** flow: Supabase verifies the token server-side and bounces the
   browser here with `#access_token=…&type=recovery` in the FRAGMENT, which the client picks up on
   its own (`detectSessionInUrl` is on by default) and turns into a real session. By the time
   `useAuth()` reports a user, the recovery session exists and `updateUser` will work.

   So this page does not parse the happy path — it waits for it. What it does parse is the two ways
   the happy path fails, because those are the ones that otherwise look like a broken site:

     1. A dead link. Supabase returns `#error=access_denied&error_code=otp_expired`. We read it
        BEST-EFFORT: supabase-js strips the fragment during its own initialisation, and that runs at
        import time, before React renders — so the parameters are often already gone. When we win
        the race we can say exactly what happened; when we lose it, the "auth settled and nobody is
        signed in" branch below catches the same case with a less specific message. Neither path
        leaves the visitor staring at a form that cannot work.
     2. `?token_hash=…` in the QUERY string. Supabase's newer email templates emit this shape, and
        it survives whatever `flowType` the client is on. Verifying it explicitly costs a few lines
        and means changing the template — or switching to PKCE — does not silently break recovery.

   WHAT THIS PAGE DOES NOT DEFEND AGAINST. A visitor who is already signed in normally can open
   this URL and set a new password without knowing the old one. That is not something introduced
   here: `supabase.auth.updateUser({ password })` behaves that way from any live session, on any
   page, and the mitigation is a project setting ("Secure password change", which requires recent
   re-authentication) rather than a client-side check. Recorded so nobody reads the absence of an
   old-password field as an oversight. */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Lock, ArrowRight, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

type Status = 'checking' | 'ready' | 'invalid';

export default function ResetPasswordPage() {
  const { user, loading, updatePassword, signOut } = useAuth();
  const router = useRouter();

  const [status, setStatus] = useState<Status>('checking');
  const [reason, setReason] = useState<string | null>(null);
  // Stays true until the URL has been interpreted, so the "no session" branch below cannot fire
  // while a verifyOtp call is still in flight.
  const [resolving, setResolving] = useState(true);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);

  // Same scale as the sign-up form, so "Strong" means the same thing in both places.
  const strength = password.length === 0 ? 0 : password.length < 6 ? 1 : password.length < 8 ? 2 : 3;
  const strengthLabels = ['', 'Weak', 'Fair', 'Strong'];
  const strengthColors = ['', 'bg-red-500', 'bg-yellow-500', 'bg-[#138808]'];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const query = new URLSearchParams(window.location.search);

      const err = hash.get('error_description') ?? hash.get('error')
        ?? query.get('error_description') ?? query.get('error');
      if (err) {
        if (!cancelled) { setReason(err.replace(/\+/g, ' ')); setStatus('invalid'); setResolving(false); }
        return;
      }

      const tokenHash = query.get('token_hash');
      if (tokenHash) {
        const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
        if (cancelled) return;
        if (error) { setReason(error.message); setStatus('invalid'); }
        setResolving(false);
        return;
      }

      if (!cancelled) setResolving(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (resolving || status !== 'checking') return;
    if (user) { setStatus('ready'); return; }
    if (loading) return;
    /* Auth has settled and nobody is signed in, so there is no recovery session to change a
       password with. Wait a beat before saying so: telling somebody their perfectly good link is
       invalid is the worst thing this page can do, and it is cheap to rule out a late arrival. */
    const t = setTimeout(() => setStatus((s) => (s === 'checking' ? 'invalid' : s)), 1500);
    return () => clearTimeout(t);
  }, [resolving, status, user, loading]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) { toast.error('Password must be at least 6 characters'); return; }
    if (password !== confirm) { toast.error('The two passwords do not match'); return; }

    setSaving(true);
    const { error } = await updatePassword(password);
    if (error) { setSaving(false); toast.error(error); return; }

    /* Then sign out EVERYWHERE. `updateUser` leaves every other session alive, and the person most
       likely to be resetting a password is someone who believes another party has it — leaving
       that party signed in would defeat the entire exercise. The side benefit is that the new
       password gets used once, immediately, which is the cheapest confirmation it is what they
       think it is. */
    await signOut();
    setSaving(false);
    toast.success('Password updated — sign in with your new password');
    router.replace('/auth/signin');
  };

  // relative + overflow-hidden — clips the decorative blobs, same as signin/signup.
  return (
    <div className="relative overflow-hidden min-h-screen bg-[#0d0d0d] flex items-center justify-center px-4 pt-20">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-20 left-1/4 w-96 h-96 bg-[#FF9933]/6 rounded-full blur-[120px]" />
        <div className="absolute bottom-20 right-1/4 w-96 h-96 bg-[#138808]/6 rounded-full blur-[120px]" />
      </div>

      <div className="w-full max-w-md relative">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2">
            <span className="text-3xl">🙏</span>
            <span className="text-3xl font-black text-[#138808]">Seva</span>
            <span className="text-3xl">🙏</span>
          </div>
          <h1 className="text-2xl font-black text-white mt-4">
            {status === 'invalid' ? 'This link has expired' : 'Set a new password'}
          </h1>
          <p className="text-gray-400 text-sm mt-1">
            {status === 'invalid'
              ? 'Reset links are single-use and short-lived'
              : 'Choose something you have not used here before'}
          </p>
        </div>

        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-8">
          {status === 'checking' && (
            <div className="flex flex-col items-center gap-3 py-6 text-sm text-gray-400">
              <div className="w-6 h-6 border-2 border-[#FF9933]/30 border-t-[#FF9933] rounded-full animate-spin" />
              Checking your link…
            </div>
          )}

          {status === 'invalid' && (
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mx-auto mb-5">
                <AlertTriangle className="w-7 h-7 text-red-400" />
              </div>
              <p className="text-sm text-gray-300 leading-relaxed">
                We could not use this password reset link. It has probably expired, or it has
                already been used once.
              </p>
              {reason && (
                <p className="text-xs text-gray-500 mt-3 break-words">{reason}</p>
              )}
              <Link
                href="/auth/forgot-password"
                className="saffron-btn w-full rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2 mt-6"
              >
                Send me a new link <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          )}

          {status === 'ready' && (
            <form onSubmit={submit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">New password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" style={{ width: '18px', height: '18px' }} />
                  <input
                    type={show ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="new-password"
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl pl-10 pr-12 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#FF9933] transition-colors"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShow(!show)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    {show ? <EyeOff style={{ width: '18px', height: '18px' }} /> : <Eye style={{ width: '18px', height: '18px' }} />}
                  </button>
                </div>
                {password.length > 0 && (
                  <div className="flex items-center gap-2 mt-2">
                    <div className="flex-1 h-1 bg-[#2a2a2a] rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${strengthColors[strength]}`}
                        style={{ width: `${(strength / 3) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-500">{strengthLabels[strength]}</span>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Confirm new password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500" style={{ width: '18px', height: '18px' }} />
                  <input
                    type={show ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="new-password"
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl pl-10 pr-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#FF9933] transition-colors"
                    required
                  />
                </div>
                {confirm.length > 0 && confirm !== password && (
                  <p className="text-xs text-red-400 mt-2">The two passwords do not match</p>
                )}
              </div>

              {/* Say what is about to happen before it happens — otherwise being thrown back to the
                  sign-in page reads as the reset having failed. */}
              <div className="flex items-start gap-2.5 rounded-xl bg-[#1e1e1e] border border-[#2a2a2a] px-3.5 py-3">
                <ShieldCheck className="w-4 h-4 text-[#138808] flex-shrink-0 mt-0.5" />
                <p className="text-xs text-gray-400 leading-relaxed">
                  Saving this signs you out on every device, so anyone else still holding your old
                  password loses access. You will sign in again with the new one.
                </p>
              </div>

              <button
                type="submit"
                disabled={saving}
                className="saffron-btn w-full rounded-xl py-3.5 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {saving ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>Update password <ArrowRight className="w-4 h-4" /></>
                )}
              </button>
            </form>
          )}

          {status !== 'invalid' && (
            <>
              <div className="flex items-center gap-3 my-6">
                <div className="flex-1 h-px bg-[#2a2a2a]" />
                <span className="text-xs text-gray-600">OR</span>
                <div className="flex-1 h-px bg-[#2a2a2a]" />
              </div>
              <Link
                href="/auth/signin"
                className="flex items-center justify-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Back to sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
