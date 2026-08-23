// Grabit API — Razorpay webhook signature verification.
//
// Razorpay's standard scheme: the webhook body is signed with the webhook
// secret using HMAC-SHA256, hex-encoded, sent in the X-Razorpay-Signature
// header. We recompute over the RAW body (never a re-serialized JSON —
// key order/whitespace would break the hash) and compare timing-safely.
//
// Fails closed: missing header or unset secret => false.

import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyRazorpaySignature(
  rawBody: string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) return false

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

  // timingSafeEqual throws on length mismatch — guard first.
  if (expected.length !== signature.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))
  } catch {
    return false
  }
}
