// @grabit/core — Razorpay Payment Link Service.
//
// Generates test-mode Razorpay Payment Links for `one_click` recovery messages.
// Enforces:
//   - Amount in rupees in domain/DB -> converted to paise only at the Razorpay HTTP boundary.
//   - Idempotency via reference_id (recovery job id).
//   - Mock URL fallback (https://example.test/pay/{jobId}) when disabled or keys are missing.
//   - Test-mode ONLY: live (`rzp_live_`) keys are rejected.
//   - No secrets leaked in logs or error messages.

import { config } from '@grabit/config'


export interface CreatePaymentLinkInput {
  amount: number | string | { toString(): string }
  currency?: string
  referenceId: string
  description?: string
  customer?: {
    name?: string | null
    contact?: string | null
    email?: string | null
  }
  notes?: Record<string, string>
}

export interface PaymentLinkOutput {
  id: string
  shortUrl: string
  amount: number // in rupees
  currency: string
  status: string
  isMock: boolean
}

export interface PaymentLinkServiceOptions {
  keyId?: string
  keySecret?: string
  enabled?: boolean
  baseUrl?: string
  fetchFn?: typeof fetch
}

/**
 * Converts monetary amount in rupees to integer paise for Razorpay API.
 */
export function rupeesToPaise(amountInRupees: number | string | { toString(): string }): number {
  const num = typeof amountInRupees === 'number' ? amountInRupees : Number(amountInRupees.toString())
  if (isNaN(num) || num <= 0) {
    throw new Error(`Invalid amount for payment link: ${amountInRupees}`)
  }
  return Math.round(num * 100)
}

/**
 * Generates deterministic fallback mock payment link when Razorpay is disabled or unconfigured.
 */
export function generateMockPaymentLink(
  referenceId: string,
  amountInRupees: number,
  currency = 'INR',
): PaymentLinkOutput {
  return {
    id: `plink_mock_${referenceId.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20)}`,
    shortUrl: `https://example.test/pay/${referenceId}`,
    amount: amountInRupees,
    currency,
    status: 'created',
    isMock: true,
  }
}

export class PaymentLinkService {
  private keyId?: string
  private keySecret?: string
  private enabled: boolean
  private baseUrl: string
  private fetchFn: typeof fetch

  constructor(options: PaymentLinkServiceOptions = {}) {
    this.keyId = options.keyId ?? config.razorpayKeyId
    this.keySecret = options.keySecret ?? config.razorpayKeySecret
    this.enabled = options.enabled ?? config.razorpayPaymentLinkEnabled
    this.baseUrl = (options.baseUrl ?? 'https://api.razorpay.com').replace(/\/+$/, '')
    this.fetchFn = options.fetchFn ?? globalThis.fetch
  }

  /**
   * Creates a Razorpay Payment Link (or deterministic mock if disabled/keys missing).
   */
  async create(input: CreatePaymentLinkInput): Promise<PaymentLinkOutput> {
    const amountInRupees = typeof input.amount === 'number'
      ? input.amount
      : Number(input.amount.toString())

    const currency = input.currency ?? 'INR'

    // When disabled or keys are missing: return mock payment link without error,
    // but still validate the amount so an unusable (zero/negative) checkout link
    // is never sent to a customer.
    if (!this.enabled || !this.keyId || !this.keySecret) {
      rupeesToPaise(amountInRupees)
      return generateMockPaymentLink(input.referenceId, amountInRupees, currency)
    }

    // Test-mode only: a live key with PAYMENT_LINK_ENABLED=true would create real
    // links. Reject non-test keys so this never happens by accident.
    if (!this.keyId.startsWith('rzp_test_')) {
      throw new Error('Razorpay payment links are test-mode only; RAZORPAY_KEY_ID must start with rzp_test_')
    }

    const amountInPaise = rupeesToPaise(input.amount)
    const authHeader = 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')

    const payload: Record<string, unknown> = {
      amount: amountInPaise,
      currency,
      accept_partial: false,
      reference_id: input.referenceId,
      description: input.description ?? 'Payment recovery link',
      notify: {
        sms: false,
        email: false,
      },
      reminder_enable: false,
    }

    if (input.customer && (input.customer.name || input.customer.contact || input.customer.email)) {
      payload.customer = {
        name: input.customer.name ?? undefined,
        contact: input.customer.contact ?? undefined,
        email: input.customer.email ?? undefined,
      }
    }

    if (input.notes && Object.keys(input.notes).length > 0) {
      payload.notes = input.notes
    }

    const response = await this.fetchFn(`${this.baseUrl}/v1/payment_links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      let errorDetail = `HTTP ${response.status}`
      let isDuplicateReference = false
      try {
        const errJson = (await response.json()) as { error?: { description?: string; code?: string } }
        if (errJson.error?.description) {
          errorDetail = `${errJson.error.code ?? 'ERROR'}: ${errJson.error.description}`
        }
        // A repeated reference_id that Razorpay did not resolve to the existing
        // link surfaces here. The worker keeps the job retryable instead of
        // replacing a real link with a mock URL.
        isDuplicateReference =
          /reference|already exists|duplicate/i.test(JSON.stringify(errJson))
      } catch {
        // use default errorDetail
      }
      throw new Error(
        isDuplicateReference
          ? `Razorpay Payment Link duplicate reference_id (${input.referenceId}) — reuse the stored link`
          : `Razorpay Payment Link API failed: ${errorDetail}`,
      )
    }

    const data = (await response.json()) as {
      id: string
      short_url?: string
      url?: string
      amount?: number
      currency?: string
      status?: string
    }

    const shortUrl = data.short_url ?? data.url
    if (!shortUrl) {
      throw new Error('Razorpay Payment Link API returned success but missing short_url')
    }

    return {
      id: data.id,
      shortUrl,
      amount: amountInRupees,
      currency: data.currency ?? currency,
      status: data.status ?? 'created',
      isMock: false,
    }
  }
}

export const paymentLinkService = new PaymentLinkService()

export function createPaymentLink(
  input: CreatePaymentLinkInput,
  options?: PaymentLinkServiceOptions,
): Promise<PaymentLinkOutput> {
  return new PaymentLinkService(options).create(input)
}
