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
export const ALLOWED_EVENTS = [
  'payment.failed',
  'subscription.halted',
  'subscription.cancelled',
  'mandate.revoked',
  'payment.captured',
  'order.paid',
] as const

export const isAllowedEvent = (event: string): boolean =>
  (ALLOWED_EVENTS as readonly string[]).includes(event)

/// Check whether a webhook event represents a successful payment/capture.
export function isPaymentSuccessEvent(event: string): boolean {
  return event === 'payment.captured' || event === 'order.paid'
}

export type ResolvedPaymentStatus = 'paid' | 'failed' | 'unknown'

/// Safely parse and normalize status strings from Razorpay API or webhooks.
export function parseRazorpayPaymentStatus(status: unknown): ResolvedPaymentStatus {
  if (typeof status !== 'string') return 'unknown'
  const normalized = status.trim().toLowerCase()
  if (normalized === 'captured' || normalized === 'paid') return 'paid'
  if (normalized === 'failed') return 'failed'
  return 'unknown'
}

export interface FetchRazorpayStatusOptions {
  keyId?: string
  keySecret?: string
  baseUrl?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

/// Bounded Razorpay payment status lookup.
/// Fails safe: provider/network/parse errors always return 'unknown' rather than 'paid'.
export async function fetchRazorpayPaymentStatus(
  razorpayPaymentId: string,
  options?: FetchRazorpayStatusOptions,
): Promise<ResolvedPaymentStatus> {
  const keyId = options?.keyId ?? process.env.RAZORPAY_KEY_ID
  const keySecret = options?.keySecret ?? process.env.RAZORPAY_KEY_SECRET
  const rawBaseUrl = options?.baseUrl ?? process.env.RAZORPAY_API_URL ?? 'https://api.razorpay.com'
  const baseUrl = rawBaseUrl.replace(/\/+$/, '')
  const timeoutMs = options?.timeoutMs ?? 5000
  const fetchFn = options?.fetchFn ?? globalThis.fetch

  if (!keyId || !keySecret || !razorpayPaymentId) {
    return 'unknown'
  }

  // Only real Razorpay payment IDs (pay_xxx) can be resolved via the API.
  if (!razorpayPaymentId.startsWith('pay_')) {
    return 'unknown'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`
    const res = await fetchFn(`${baseUrl}/v1/payments/${encodeURIComponent(razorpayPaymentId)}`, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })

    if (!res.ok) {
      return 'unknown'
    }

    const data = (await res.json()) as { status?: unknown }
    if (!data || typeof data !== 'object') {
      return 'unknown'
    }

    return parseRazorpayPaymentStatus(data.status)
  } catch {
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

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
