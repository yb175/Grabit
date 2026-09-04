import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PaymentLinkService,
  rupeesToPaise,
  generateMockPaymentLink,
  createPaymentLink,
} from '../src/payment-link.js'

test('payment-link: rupeesToPaise converts rupees to paise accurately', () => {
  assert.equal(rupeesToPaise(100), 10000)
  assert.equal(rupeesToPaise(1500), 150000)
  assert.equal(rupeesToPaise(49.5), 4950)
  assert.equal(rupeesToPaise('49.50'), 4950)
  assert.equal(rupeesToPaise({ toString: () => '2499.99' }), 249999)

  assert.throws(() => rupeesToPaise(0), /Invalid amount/)
  assert.throws(() => rupeesToPaise(-100), /Invalid amount/)
  assert.throws(() => rupeesToPaise('invalid'), /Invalid amount/)
})

test('payment-link: disabled mode returns deterministic mock link without HTTP call', async () => {
  let fetchCalled = false
  const customFetch = async () => {
    fetchCalled = true
    return new Response(JSON.stringify({}), { status: 200 })
  }

  const service = new PaymentLinkService({
    enabled: false,
    keyId: 'rzp_test_123',
    keySecret: 'secret_123',
    fetchFn: customFetch as any,
  })

  const result = await service.create({
    referenceId: 'job_uuid_abc_123',
    amount: 1500,
    currency: 'INR',
    description: 'Payment failure recovery',
  })

  assert.equal(fetchCalled, false)
  assert.equal(result.isMock, true)
  assert.equal(result.shortUrl, 'https://example.test/pay/job_uuid_abc_123')
  assert.match(result.id, /^plink_mock_/)
  assert.equal(result.amount, 1500)
  assert.equal(result.currency, 'INR')
})

test('payment-link: missing keys fallback to mock link even when enabled', async () => {
  const service = new PaymentLinkService({
    enabled: true,
    keyId: undefined,
    keySecret: undefined,
  })

  const result = await service.create({
    referenceId: 'job_456',
    amount: 250.5,
  })

  assert.equal(result.isMock, true)
  assert.equal(result.shortUrl, 'https://example.test/pay/job_456')
  assert.equal(result.amount, 250.5)
})

test('payment-link: enabled mode sends paise and auth header to Razorpay API', async () => {
  let capturedUrl = ''
  let capturedOptions: any = null

  const mockRazorpayResponse = {
    id: 'plink_rzp_test_9999',
    short_url: 'https://rzp.io/i/testAbc123',
    status: 'created',
    amount: 150000,
    currency: 'INR',
  }

  const customFetch = async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = url.toString()
    capturedOptions = init
    return new Response(JSON.stringify(mockRazorpayResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const service = new PaymentLinkService({
    enabled: true,
    keyId: 'rzp_test_key_sample',
    keySecret: 'sample_secret_key',
    baseUrl: 'https://api.razorpay.com',
    fetchFn: customFetch as any,
  })

  const result = await service.create({
    referenceId: 'job-uuid-777',
    amount: 1500,
    currency: 'INR',
    description: 'UPI mandate failure recovery',
    customer: {
      name: 'Rohan Sharma',
      contact: '+919876543210',
      email: 'rohan@example.com',
    },
    notes: {
      recovery_job_id: 'job-uuid-777',
    },
  })

  assert.equal(capturedUrl, 'https://api.razorpay.com/v1/payment_links')
  assert.equal(capturedOptions.method, 'POST')

  // Auth Header checks
  const expectedAuth = 'Basic ' + Buffer.from('rzp_test_key_sample:sample_secret_key').toString('base64')
  assert.equal(capturedOptions.headers.Authorization, expectedAuth)

  // Body payload checks
  const body = JSON.parse(capturedOptions.body)
  assert.equal(body.amount, 150000) // ₹1500 in paise
  assert.equal(body.currency, 'INR')
  assert.equal(body.reference_id, 'job-uuid-777')
  assert.equal(body.description, 'UPI mandate failure recovery')
  assert.equal(body.customer.name, 'Rohan Sharma')
  assert.equal(body.customer.contact, '+919876543210')
  assert.equal(body.customer.email, 'rohan@example.com')
  assert.equal(body.notify.sms, false)
  assert.equal(body.notify.email, false)
  assert.equal(body.reminder_enable, false)
  assert.equal(body.notes.recovery_job_id, 'job-uuid-777')

  // Return value checks
  assert.equal(result.isMock, false)
  assert.equal(result.id, 'plink_rzp_test_9999')
  assert.equal(result.shortUrl, 'https://rzp.io/i/testAbc123')
  assert.equal(result.amount, 1500)
})

test('payment-link: handles Razorpay API errors cleanly without leaking secret', async () => {
  const customFetch = async () => {
    return new Response(
      JSON.stringify({
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'Payment link already issued for this reference_id',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const service = new PaymentLinkService({
    enabled: true,
    keyId: 'rzp_test_key',
    keySecret: 'super_secret_never_leak',
    fetchFn: customFetch as any,
  })

  await assert.rejects(
    async () => {
      await service.create({
        referenceId: 'job_dup_123',
        amount: 500,
      })
    },
    (err: Error) => {
      // Duplicate reference_id is detected and surfaced distinctly so the
      // worker never replaces a real link with a mock URL; secret still never leaks.
      assert.match(err.message, /duplicate reference_id/)
      assert.doesNotMatch(err.message, /super_secret_never_leak/)
      return true
    },
  )
})

test('payment-link: live (rzp_live_) key with enabled=true is rejected — test-mode only', async () => {
  const service = new PaymentLinkService({
    enabled: true,
    keyId: 'rzp_live_abc123',
    keySecret: 'secret_key',
  })

  await assert.rejects(
    service.create({ referenceId: 'job_live_1', amount: 500 }),
    /test-mode only; RAZORPAY_KEY_ID must start with rzp_test_/,
  )
})

test('payment-link: invalid amount is rejected before a mock link is returned', async () => {
  const service = new PaymentLinkService({ enabled: false })

  await assert.rejects(service.create({ referenceId: 'job_zero', amount: 0 }), /Invalid amount/)
  await assert.rejects(service.create({ referenceId: 'job_neg', amount: -100 }), /Invalid amount/)
  await assert.rejects(service.create({ referenceId: 'job_invalid', amount: 'not-a-number' }), /Invalid amount/)
})
