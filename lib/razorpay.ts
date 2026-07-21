/* SERVER-ONLY Razorpay client. Import ONLY from app/api/** route handlers.
 *
 * RAZORPAY_KEY_SECRET must never reach the browser — only NEXT_PUBLIC_RAZORPAY_KEY_ID is
 * public (Checkout needs it). Construction is lazy so `next build` doesn't crash when the
 * secret is absent; a request against a misconfigured deploy fails loudly instead. */

import Razorpay from 'razorpay';

let cached: Razorpay | null = null;

export function getRazorpay(): Razorpay {
  if (cached) return cached;
  const key_id = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error('razorpay: NEXT_PUBLIC_RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set (server-only).');
  }
  cached = new Razorpay({ key_id, key_secret });
  return cached;
}
