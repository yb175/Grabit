// @grabit/core — Razorpay domain logic shared by the API and workers.
//
// Pure functions + types only: no I/O, no Prisma, no Redis. This keeps the
// webhook endpoint thin (receive -> verify -> enqueue) while the ingest
// worker reuses the same classification rules deterministically.

import type { FailureType } from './index.js'

/// Razorpay webhook event — only the fields Grabit cares about.
/// payload is intentionally loose (unknown at the edges) because Razorpay
/// adds fields without notice; rawPayload in failed_payments keeps the truth.
export interface RazorpayWebhookEvent {
  event: string
  payload: {
    payment?: {
      entity: {
        id: string
        order_id: string | null
        amount: number // paise
        currency: string
        method: string | null
        error_code: string | null
        error_description: string | null
        contact: string | null
        email: string | null
        notes: Record<string, string> | null
      }
    }
    subscription?: {
      entity: {
        id: string
        payment_id: string | null
        customer_id: string | null
        notes: Record<string, string> | null
      }
    }
    mandate?: {
      entity: {
        id: string
        status: string
      }
    }
  }
}

/// Events that enter the recovery pipeline. Everything else is dropped at
/// the webhook (200 + event_ignored) so Razorpay doesn't retry junk.
/// NOTE: subscription.charged is a SUCCESS event — excluded by design.
export const ALLOWED_EVENTS = [
  'payment.failed',
  'subscription.halted',
  'subscription.cancelled',
  'mandate.revoked',
] as const

export const isAllowedEvent = (event: string): boolean =>
  (ALLOWED_EVENTS as readonly string[]).includes(event)

/// Razorpay decline codes where retrying the same instrument will not help.
/// Anything else on a payment.failed is treated as soft (transient).
/// Extendable as we learn from real traffic.
export const HARD_DECLINE_CODES = new Set([
  'invalid_card',
  'card_blocked',
  'fraudulent',
  'invalid_vpa',
  'authorization_denied',
])

/// Rule-based initial classification. The recovery phase (AI agent) may
/// reclassify later — this is just the ingest-time default so the job lands
/// in the right playbook immediately.
export function classifyFailure(
  event: string,
  errorCode: string | null,
): FailureType {
  if (event === 'subscription.cancelled' || event === 'mandate.revoked')
    return 'autopay_cancelled'
  if (event === 'subscription.halted') return 'autopay_failed'
  // payment.failed
  if (errorCode && HARD_DECLINE_CODES.has(errorCode)) return 'hard'
  return 'soft'
}

/// Where the failure surfaced — stored as failure_source on failed_payments.
export function failureSource(event: string): 'payment' | 'subscription' | 'mandate' {
  if (event.startsWith('mandate')) return 'mandate'
  if (event.startsWith('subscription')) return 'subscription'
  return 'payment'
}
