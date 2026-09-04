// Webhook signature verification tests — pure crypto, no DB/Redis needed.
// Run: pnpm --filter @grabit/api test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifyRazorpaySignature } from '../src/lib/razorpay.js'
import { classifyFailure, isAllowedEvent, ALLOWED_EVENTS } from '@grabit/core'

const SECRET = 'test_webhook_secret'
const BODY = JSON.stringify({
  event: 'payment.failed',
  payload: { payment: { entity: { id: 'pay_123', amount: 100000 } } },
})

const sign = (body: string, secret: string = SECRET) =>
  createHmac('sha256', secret).update(body, 'utf8').digest('hex')

test('valid signature passes', () => {
  assert.equal(verifyRazorpaySignature(BODY, sign(BODY), SECRET), true)
})

test('tampered body fails', () => {
  const other = BODY.replace('100000', '200000')
  assert.equal(verifyRazorpaySignature(other, sign(BODY), SECRET), false)
})

test('wrong secret fails', () => {
  assert.equal(verifyRazorpaySignature(BODY, sign(BODY, 'other_secret'), SECRET), false)
})

test('missing signature header fails (fail closed)', () => {
  assert.equal(verifyRazorpaySignature(BODY, undefined, SECRET), false)
})

test('unset webhook secret fails (fail closed)', () => {
  assert.equal(verifyRazorpaySignature(BODY, sign(BODY), undefined), false)
})

test('signature length mismatch does not throw', () => {
  assert.equal(verifyRazorpaySignature(BODY, 'deadbeef', SECRET), false)
})

// --- classification rules ---

test('classifyFailure: hard decline codes map to hard', () => {
  for (const code of ['invalid_card', 'card_blocked', 'fraudulent', 'invalid_vpa', 'authorization_denied']) {
    assert.equal(classifyFailure('payment.failed', code), 'hard')
  }
})

test('classifyFailure: transient errors map to soft', () => {
  assert.equal(classifyFailure('payment.failed', 'insufficient_funds'), 'soft')
  assert.equal(classifyFailure('payment.failed', null), 'soft')
})

test('classifyFailure: autopay events', () => {
  assert.equal(classifyFailure('subscription.halted', null), 'autopay_failed')
  assert.equal(classifyFailure('subscription.cancelled', null), 'autopay_cancelled')
  assert.equal(classifyFailure('mandate.revoked', null), 'autopay_cancelled')
})

test('event whitelist', () => {
  for (const e of ALLOWED_EVENTS) assert.ok(isAllowedEvent(e))
  assert.equal(isAllowedEvent('subscription.charged'), false)
  assert.equal(isAllowedEvent('payment.captured'), true)
  assert.equal(isAllowedEvent('order.paid'), true)
  assert.equal(isAllowedEvent('dummy.unsupported'), false)
})
