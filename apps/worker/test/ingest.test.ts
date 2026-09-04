// Ingest flow integration tests — run against the real Postgres
// (docker compose -f infra/docker-compose.yml up -d postgres).
// Each test uses a unique razorpay payment id, so runs are order-independent.
// Run: pnpm --filter @grabit/worker test

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@grabit/db'
import { processIngestEvent } from '../src/workers/ingest.worker.js'

const ids: string[] = []
const uniqId = () => {
  const id = `pay_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  ids.push(id)
  return id
}

after(async () => {
  // cascade removes recovery_jobs tied to these payments
  await prisma.failedPayment.deleteMany({ where: { razorpayPaymentId: { in: ids } } })
  await prisma.$disconnect()
})

function paymentFailedEvent(id: string, errorCode: string | null = 'insufficient_funds') {
  return {
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id,
          order_id: 'order_test_123',
          amount: 100000, // paise
          currency: 'INR',
          method: 'upi',
          error_code: errorCode,
          error_description: 'Insufficient funds in the account',
          contact: '+919999999999',
          email: 'customer@example.com',
          notes: null,
        },
      },
    },
  }
}

test('successful ingest of payment.failed event', async () => {
  const id = uniqId()
  const result = await processIngestEvent({
    event: 'payment.failed',
    payload: paymentFailedEvent(id).payload,
    receivedAt: new Date().toISOString(),
  })

  assert.equal(result.outcome, 'created')
  assert.equal(result.failureType, 'soft')

  const fp = await prisma.failedPayment.findUniqueOrThrow({
    where: { razorpayPaymentId: id },
    include: { recoveryJobs: true },
  })

  // paise -> rupees
  assert.equal(fp.amount.toString(), '1000')
  assert.equal(fp.currency, 'INR')
  assert.equal(fp.failureSource, 'payment')
  assert.equal(fp.customerPhone, '+919999999999')

  // exactly one recovery job, in the right initial state
  assert.equal(fp.recoveryJobs.length, 1)
  assert.equal(fp.recoveryJobs[0].status, 'pending')
  assert.equal(fp.recoveryJobs[0].failureType, 'soft')
  assert.equal(fp.recoveryJobs[0].maxFollowUps, 2)
})

test('duplicate event is idempotent — exactly one job', async () => {
  const id = uniqId()
  const data = {
    event: 'payment.failed',
    payload: paymentFailedEvent(id).payload,
    receivedAt: new Date().toISOString(),
  }

  const first = await processIngestEvent(data)
  const second = await processIngestEvent(data)

  assert.equal(first.outcome, 'created')
  assert.equal(second.outcome, 'duplicate')

  const count = await prisma.failedPayment.count({ where: { razorpayPaymentId: id } })
  assert.equal(count, 1)

  const fp = await prisma.failedPayment.findUniqueOrThrow({
    where: { razorpayPaymentId: id },
    include: { recoveryJobs: true },
  })
  assert.equal(fp.recoveryJobs.length, 1)
})

test('hard decline code classifies as failure_type=hard', async () => {
  const id = uniqId()
  const result = await processIngestEvent({
    event: 'payment.failed',
    payload: paymentFailedEvent(id, "card_blocked").payload,
    receivedAt: new Date().toISOString(),
  })
  assert.equal(result.failureType, 'hard')
})

test('subscription.halted ingests with autopay_failed and sub fallback id', async () => {
  const subId = `sub_test_${Date.now()}`
  const result = await processIngestEvent({
    event: 'subscription.halted',
    payload: {
      subscription: {
        entity: { id: subId, payment_id: null, customer_id: 'cust_1', notes: null },
      },
    },
    receivedAt: new Date().toISOString(),
  })

  assert.equal(result.outcome, 'created')
  assert.equal(result.failureType, 'autopay_failed')

  const fp = await prisma.failedPayment.findUniqueOrThrow({
    where: { razorpayPaymentId: `sub_${subId}` },
  })
  assert.equal(fp.failureSource, 'subscription')
  assert.equal(fp.amount.toString(), '0')
})

test('payment.captured updates existing failed payment to isPaid=true', async () => {
  const id = uniqId()
  // 1. Ingest original failure
  const failResult = await processIngestEvent({
    event: 'payment.failed',
    payload: paymentFailedEvent(id).payload,
    receivedAt: new Date().toISOString(),
  })
  assert.equal(failResult.outcome, 'created')

  // 2. Later payment.captured arrives for the same payment id
  const capResult = await processIngestEvent({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id,
          amount: 100000,
          currency: 'INR',
          status: 'captured',
        },
      },
    },
    receivedAt: new Date().toISOString(),
  })

  assert.equal(capResult.outcome, 'updated')
  assert.equal(capResult.recoveryJobId, failResult.recoveryJobId)

  const fp = await prisma.failedPayment.findUniqueOrThrow({
    where: { razorpayPaymentId: id },
  })
  assert.equal(fp.isPaid, true)
  assert.ok(fp.paidAt)
})

test('duplicate payment.captured is idempotent and skipped', async () => {
  const id = uniqId()
  await processIngestEvent({
    event: 'payment.failed',
    payload: paymentFailedEvent(id).payload,
    receivedAt: new Date().toISOString(),
  })

  const capData = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id, amount: 100000, status: 'captured' },
      },
    },
    receivedAt: new Date().toISOString(),
  }

  const firstCap = await processIngestEvent(capData)
  const secondCap = await processIngestEvent(capData)

  assert.equal(firstCap.outcome, 'updated')
  assert.equal(secondCap.outcome, 'duplicate')

  const count = await prisma.failedPayment.count({ where: { razorpayPaymentId: id } })
  assert.equal(count, 1)
})

test('payment.captured for unknown payment is safely ignored', async () => {
  const unknownId = `pay_unknown_${Date.now()}`
  const result = await processIngestEvent({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: unknownId, amount: 50000, status: 'captured' },
      },
    },
    receivedAt: new Date().toISOString(),
  })

  assert.equal(result.outcome, 'ignored')
  assert.equal(result.failedPaymentId, null)
  assert.equal(result.recoveryJobId, null)
})

test('payment.captured reconciles terminal job (unrecovered/stale/rejected)', async () => {
  const id = uniqId()
  const failResult = await processIngestEvent({
    event: 'payment.failed',
    payload: paymentFailedEvent(id).payload,
    receivedAt: new Date().toISOString(),
  })
  assert.equal(failResult.outcome, 'created')

  // Put job in terminal unrecovered state
  await prisma.recoveryJob.update({
    where: { id: failResult.recoveryJobId! },
    data: { status: 'unrecovered' },
  })

  const capResult = await processIngestEvent({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id, amount: 100000, status: 'captured' },
      },
    },
    receivedAt: new Date().toISOString(),
  })

  assert.equal(capResult.outcome, 'updated')
  assert.equal(capResult.recoveryJobId, failResult.recoveryJobId)

  const fp = await prisma.failedPayment.findUniqueOrThrow({
    where: { razorpayPaymentId: id },
  })
  assert.equal(fp.isPaid, true)
})

test('concurrent duplicate payment.captured webhooks are handled atomically', async () => {
  const id = uniqId()
  await processIngestEvent({
    event: 'payment.failed',
    payload: paymentFailedEvent(id).payload,
    receivedAt: new Date().toISOString(),
  })

  const capData = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id, amount: 100000, status: 'captured' },
      },
    },
    receivedAt: new Date().toISOString(),
  }

  // Run two concurrent capture ingest events
  const [res1, res2] = await Promise.all([
    processIngestEvent(capData),
    processIngestEvent(capData),
  ])

  const outcomes = [res1.outcome, res2.outcome].sort()
  assert.deepEqual(outcomes, ['duplicate', 'updated'])
})
