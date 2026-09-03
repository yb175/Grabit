// Recovery Worker integration tests — testing stopping rules evaluation
// and DB execution against PostgreSQL.
// Run: pnpm --filter @grabit/worker test

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, Prisma } from '@grabit/db'
import { fromISTComponents, toISTComponents } from '@grabit/core'
import { closeAllQueues } from '@grabit/queue'
import { processRecoveryJob } from '../src/workers/recovery.worker.js'

const paymentIds: string[] = []
const uniqPaymentId = () => {
  const id = `pay_rec_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  paymentIds.push(id)
  return id
}

after(async () => {
  // Cascading deletes on failed_payments remove recovery_jobs, ledger, messages, hitl tasks
  await prisma.failedPayment.deleteMany({
    where: { razorpayPaymentId: { in: paymentIds } },
  })
  await closeAllQueues()
  await prisma.$disconnect()
})

async function seedJob(opts: {
  amount?: number
  failureCode?: string
  failureType?: 'hard' | 'soft' | 'autopay_failed' | 'autopay_cancelled'
  followUpCount?: number
  maxFollowUps?: number
  status?: 'pending' | 'processing' | 'waiting' | 'hitl' | 'recovered' | 'unrecovered' | 'rejected' | 'stale'
}) {
  const razorpayPaymentId = uniqPaymentId()
  const failedPayment = await prisma.failedPayment.create({
    data: {
      razorpayPaymentId,
      amount: new Prisma.Decimal(opts.amount ?? 1500),
      currency: 'INR',
      failureCode: opts.failureCode ?? 'insufficient_funds',
      failureReason: 'Payment failed at bank',
      failureSource: 'payment',
      rawPayload: {},
    },
  })

  const job = await prisma.recoveryJob.create({
    data: {
      failedPaymentId: failedPayment.id,
      status: opts.status ?? 'pending',
      failureType: opts.failureType ?? 'soft',
      followUpCount: opts.followUpCount ?? 0,
      maxFollowUps: opts.maxFollowUps ?? 2,
    },
  })

  return { failedPayment, job }
}

test('recovery: daytime soft failure records bounded fallback and escalates safely', async () => {
  const { job } = await seedJob({ amount: 1500, failureType: 'soft' })
  const daytime = fromISTComponents(2025, 5, 10, 11, 0, 0)

  const result = await processRecoveryJob({ recoveryJobId: job.id }, daytime)

  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'continue')
  assert.equal(result.decision?.shouldCallAi, true)

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.status, 'hitl')

  const logs = await prisma.auditLog.findMany({
    where: { entityId: job.id, entityType: 'recovery_jobs' },
  })
  assert.equal(logs.some((log) => log.action === 'stopping_rules_passed'), true)
  assert.equal(logs.some((log) => log.action === 'agent_decision'), true)
})

test('recovery: max follow-ups exceeded marks status=unrecovered and creates ledger row', async () => {
  const { job, failedPayment } = await seedJob({
    amount: 2500,
    followUpCount: 2,
    maxFollowUps: 2,
  })

  const result = await processRecoveryJob({ recoveryJobId: job.id })

  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'stop_unrecovered')
  assert.equal(result.decision?.rule, 'max_followups_exceeded')

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.status, 'unrecovered')

  const ledger = await prisma.recoveryLedger.findFirstOrThrow({
    where: { recoveryJobId: job.id },
  })
  assert.equal(ledger.status, 'unrecovered')
  assert.equal(ledger.amount.toString(), '2500')
  assert.equal(ledger.failedPaymentId, failedPayment.id)
})

test('recovery: already recovered job creates recovered ledger entry', async () => {
  const { job, failedPayment } = await seedJob({
    amount: 3000,
    status: 'recovered',
  })

  const result = await processRecoveryJob({ recoveryJobId: job.id })

  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'stop_recovered')

  const ledger = await prisma.recoveryLedger.findFirstOrThrow({
    where: { recoveryJobId: job.id },
  })
  assert.equal(ledger.status, 'recovered')
  assert.equal(ledger.amount.toString(), '3000')
  assert.ok(ledger.recoveredAt)
})

test('recovery: quiet hours delays job to next morning 08:00 IST (status=waiting)', async () => {
  const { job } = await seedJob({ amount: 1200 })
  const nightTime = fromISTComponents(2025, 5, 10, 22, 15, 0) // 10:15 PM IST

  const result = await processRecoveryJob({ recoveryJobId: job.id }, nightTime)

  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'delay')
  assert.ok(result.decision?.nextAttemptAt)

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.status, 'waiting')
  assert.ok(updated.nextAttemptAt)

  const ist = toISTComponents(updated.nextAttemptAt)
  assert.equal(ist.day, 11)
  assert.equal(ist.hours, 8)
  assert.equal(ist.minutes, 0)
})

test('recovery: high value failure (>= ₹10,000) escalates to HITL queue', async () => {
  const { job } = await seedJob({ amount: 15000 })
  const daytime = fromISTComponents(2025, 5, 10, 14, 0, 0)

  const result = await processRecoveryJob({ recoveryJobId: job.id }, daytime)

  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'hitl')
  assert.equal(result.decision?.rule, 'hitl_high_value')

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.status, 'hitl')

  const hitlTask = await prisma.hitlQueue.findFirstOrThrow({
    where: { recoveryJobId: job.id },
  })
  assert.equal(hitlTask.status, 'pending')
  assert.match(hitlTask.reason, /exceeds HITL threshold/)
})

test('recovery: stale job (>24h since last message) marks status=stale', async () => {
  const { job } = await seedJob({ amount: 1000, followUpCount: 1 })

  // Insert a message sent 26 hours ago
  const sentAt = fromISTComponents(2025, 5, 10, 10, 0, 0)
  await prisma.message.create({
    data: {
      recoveryJobId: job.id,
      toPhone: '+919876543210',
      messageBody: 'Test reminder message',
      status: 'delivered',
      sentAt,
      createdAt: sentAt,
    },
  })

  const now = fromISTComponents(2025, 5, 11, 12, 0, 0) // 26h later
  const result = await processRecoveryJob({ recoveryJobId: job.id }, now)

  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'stale')
  assert.equal(result.decision?.rule, 'stale_timeout')

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.status, 'stale')
})
