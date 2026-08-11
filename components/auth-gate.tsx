'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

/* The whole site sits behind a session. Everything not listed here redirects to sign-in, so the
   list is the ONLY way in — a new page is gated the moment it exists, rather than gated when
   somebody remembers to add a guard to it. That is the point of putting this in the layout
   instead of copying the /wallet-style per-page redirect into another dozen files.

   This is UX routing, not the security boundary. The boundary is in the database — RLS, the
   SECURITY DEFINER RPCs, and the server-only wallet/reputation writes — and it does not move
   because of anything here. Nothing on the client is trusted before this gate or after it.

   Note what is deliberately NOT covered: /api/**. Route handlers never render through a layout,
   so they are untouched by this file, which is exactly right — /api/payments/webhook is called by
   Razorpay, not a browser, and has no session to check. It authenticates by verifying the
   Razorpay signature; the rest authenticate the Bearer token via lib/api-auth.

   Password recovery is public for a reason that is easy to get wrong: BOTH halves have to be.
   /auth/reset-password is where the emailed link lands, and at that moment there is usually no
   session yet — the token is still sitting in the URL fragment waiting for supabase-js to exchange
   it. Gating that route would redirect first, and since AuthGate's `?next=` carries only pathname
   and search, the fragment — the token itself — would be thrown away. Worse, an EXPIRED link would
   bounce to sign-in with no explanation, when the whole point of that page is to say "this link is
   dead, here is a fresh one". */
const PUBLIC_ROUTES = ['/auth/signin', '/auth/signup', '/auth/forgot-password', '/auth/reset-password'];

const isPublic = (pathname: string) =>
  PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'));

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const open = isPublic(pathname);

  useEffect(() => {
    if (loading || open || user) return;
    /* Carry the destination so a shared link survives the detour — a provider link sent to
       someone signed out used to land them on the homepage with no idea what they were sent.
       Read from location rather than useSearchParams: the hook forces every page under this
       layout into client-side rendering, and this is the only thing here that needs the query. */
    const next = window.location.pathname + window.location.search;
    router.replace(`/auth/signin?next=${encodeURIComponent(next)}`);
  }, [loading, open, user, router]);

  if (open) return <>{children}</>;

  // The session is restored asynchronously from localStorage, so `loading` is the difference
  // between "signed out" and "we don't know yet". Rendering the page during that window would
  // flash it at a signed-out visitor; redirecting during it would throw a signed-in one out on
  // every hard refresh, which is the bug commit a715c60 fixed on /profile, /wallet and /bookings.
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] pt-20 flex items-center justify-center text-gray-400">
        Loading…
      </div>
    );
  }
  if (!user) return null; // the redirect above is in flight

  return <>{children}</>;
}
