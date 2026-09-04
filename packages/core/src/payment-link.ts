// @grabit/core — Razorpay Payment Link Service.
//
// Generates test-mode Razorpay Payment Links for `one_click` recovery messages.
// Enforces:
//   - Amount in rupees in domain/DB -> converted to paise only at the Razorpay HTTP boundary.
//   - Idempotency via reference_id (recovery job id).
//   - Mock URL fallback (https://example.test/pay/{jobId}) when disabled or keys are missing.
//   - No secrets leaked in logs or error messages.

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
    this.keyId = options.keyId ?? process.env.RAZORPAY_KEY_ID
    this.keySecret = options.keySecret ?? process.env.RAZORPAY_KEY_SECRET
    this.enabled = options.enabled ?? (process.env.RAZORPAY_PAYMENT_LINK_ENABLED === 'true')
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

    // When disabled or keys are missing: return mock payment link without error
    if (!this.enabled || !this.keyId || !this.keySecret) {
      return generateMockPaymentLink(input.referenceId, amountInRupees, currency)
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
      try {
        const errJson = (await response.json()) as { error?: { description?: string; code?: string } }
        if (errJson.error?.description) {
          errorDetail = `${errJson.error.code ?? 'ERROR'}: ${errJson.error.description}`
        }
      } catch {
        // use default errorDetail
      }
      throw new Error(`Razorpay Payment Link API failed: ${errorDetail}`)
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
