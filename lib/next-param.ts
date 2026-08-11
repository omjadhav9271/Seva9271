/* The `?next=` handoff between AuthGate and the two auth pages.

   AuthGate sends a signed-out visitor to /auth/signin?next=<where they were going>; these two
   helpers are how that value gets back out again safely.

   `safeNext` is the security-relevant half. `next` arrives from the URL, so it is attacker-
   supplied: anyone can send a Seva user a link with any value in it. Handing it to router.push
   unchecked is an open redirect — the victim signs in on the real Seva sign-in page, at the real
   domain, and is then dropped on a page of the attacker's choosing wearing all the trust of the
   flow they just completed. So only a same-site ABSOLUTE PATH is allowed through:

     '/bookings/abc'   → kept
     'https://evil'    → dropped (absolute URL)
     '//evil.com'      → dropped (protocol-relative — starts with '/', so a bare startsWith('/')
                         check waves it through and the browser reads it as a host)
     '/\\evil.com'     → dropped (backslash — some browsers normalise it to '//')
     '/auth/signin'    → dropped, it would bounce straight back here

   Everything else falls back to '/', which is where this app has always sent people after
   sign-in. */

export function safeNext(next: string | null | undefined): string {
  if (!next) return '/';
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next === '/auth/signin' || next === '/auth/signup') return '/';
  return next;
}

/** Read `next` off the current URL. Client-side only — returns null during SSR. */
export function readNext(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('next');
}
