import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRazorpayPaymentStatus,
  fetchRazorpayPaymentStatus,
  isPaymentSuccessEvent,
} from '../src/razorpay.js'

test('isPaymentSuccessEvent identifies capture and paid events', () => {
  assert.equal(isPaymentSuccessEvent('payment.captured'), true)
  assert.equal(isPaymentSuccessEvent('order.paid'), true)
  assert.equal(isPaymentSuccessEvent('payment.failed'), false)
  assert.equal(isPaymentSuccessEvent('subscription.halted'), false)
})

test('parseRazorpayPaymentStatus parses valid status strings', () => {
  assert.equal(parseRazorpayPaymentStatus('captured'), 'paid')
  assert.equal(parseRazorpayPaymentStatus('CAPTURED'), 'paid')
  assert.equal(parseRazorpayPaymentStatus('paid'), 'paid')
  assert.equal(parseRazorpayPaymentStatus('failed'), 'failed')
})

test('parseRazorpayPaymentStatus treats invalid / untrusted status values as unknown', () => {
  assert.equal(parseRazorpayPaymentStatus('created'), 'unknown')
  assert.equal(parseRazorpayPaymentStatus('authorized'), 'unknown')
  assert.equal(parseRazorpayPaymentStatus('refunded'), 'unknown')
  assert.equal(parseRazorpayPaymentStatus(''), 'unknown')
  assert.equal(parseRazorpayPaymentStatus(null), 'unknown')
  assert.equal(parseRazorpayPaymentStatus(undefined), 'unknown')
  assert.equal(parseRazorpayPaymentStatus(123), 'unknown')
  assert.equal(parseRazorpayPaymentStatus({}), 'unknown')
})

test('fetchRazorpayPaymentStatus returns unknown if keys or payment ID missing', async () => {
  const res1 = await fetchRazorpayPaymentStatus('pay_123', {
    keyId: '',
    keySecret: 'secret',
  })
  assert.equal(res1, 'unknown')

  const res2 = await fetchRazorpayPaymentStatus('sub_123', {
    keyId: 'key',
    keySecret: 'secret',
  })
  assert.equal(res2, 'unknown')
})

test('fetchRazorpayPaymentStatus returns paid on 200 with captured status', async () => {
  const mockFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ id: 'pay_123', status: 'captured', amount: 5000 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  const res = await fetchRazorpayPaymentStatus('pay_123', {
    keyId: 'rzp_test_key',
    keySecret: 'rzp_test_secret',
    baseUrl: 'https://api.razorpay.test',
    fetchFn: mockFetch,
  })

  assert.equal(res, 'paid')
})

test('fetchRazorpayPaymentStatus returns unknown on HTTP error', async () => {
  const mockFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })

  const res = await fetchRazorpayPaymentStatus('pay_123', {
    keyId: 'rzp_test_key',
    keySecret: 'rzp_test_secret',
    baseUrl: 'https://api.razorpay.test',
    fetchFn: mockFetch,
  })

  assert.equal(res, 'unknown')
})

test('fetchRazorpayPaymentStatus returns unknown on network exception / timeout', async () => {
  const mockFetch: typeof fetch = async () => {
    throw new Error('Network timeout')
  }

  const res = await fetchRazorpayPaymentStatus('pay_123', {
    keyId: 'rzp_test_key',
    keySecret: 'rzp_test_secret',
    baseUrl: 'https://api.razorpay.test',
    fetchFn: mockFetch,
  })

  assert.equal(res, 'unknown')
})

test('fetchRazorpayPaymentStatus returns unknown on malformed JSON response', async () => {
  const mockFetch: typeof fetch = async () =>
    new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })

  const res = await fetchRazorpayPaymentStatus('pay_123', {
    keyId: 'rzp_test_key',
    keySecret: 'rzp_test_secret',
    baseUrl: 'https://api.razorpay.test',
    fetchFn: mockFetch,
  })

  assert.equal(res, 'unknown')
})
