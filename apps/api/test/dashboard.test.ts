// Integration tests for GET /dashboard/summary (Command View KPIs).
// Run: pnpm --filter @grabit/api test

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, Prisma } from '@grabit/db'
import { app } from '../src/app.js'

const createdPaymentIds: string[] = []
const uniqPaymentId = () => {
  const id = `pay_dash_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  createdPaymentIds.push(id)
  return id
}

after(async () => {
  // Cascading deletes on failed_payments remove recovery_jobs, ledger, hitl
  if (createdPaymentIds.length > 0) {
    const payments = await prisma.failedPayment.findMany({
      where: { razorpayPaymentId: { in: createdPaymentIds } },
      select: { id: true },
    })
    const paymentIds = payments.map((p) => p.id)
    const jobs = await prisma.recoveryJob.findMany({
      where: { failedPaymentId: { in: paymentIds } },
      select: { id: true },
    })
    const jobIds = jobs.map((j) => j.id)

    if (jobIds.length > 0) {
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { entityId: { in: jobIds } },
            { entityId: { in: paymentIds } },
          ],
        },
      })
    }
    await prisma.failedPayment.deleteMany({
      where: { razorpayPaymentId: { in: createdPaymentIds } },
    })
  }
  await prisma.$disconnect()
})

async function seedFixture(opts: {
  amount: number
  status: 'recovered' | 'unrecovered' | 'hitl' | 'waiting'
  failureType: 'hard' | 'soft' | 'autopay_cancelled'
  withLedger?: boolean
  recoveryMethod?: 'one_click' | 'retry'
  withHitlPending?: boolean
}) {
  const razorpayPaymentId = uniqPaymentId()
  const failedPayment = await prisma.failedPayment.create({
    data: {
      razorpayPaymentId,
      amount: new Prisma.Decimal(opts.amount),
      currency: 'INR',
      failureCode: 'insufficient_funds',
      failureReason: 'Insufficient balance in account',
      failureSource: 'payment',
      paymentMethod: 'upi',
      customerPhone: '+919876543210',
      customerName: 'Dashboard Test',
      customerEmail: 'test@example.com',
      rawPayload: { entity: { id: razorpayPaymentId } },
    },
  })

  const job = await prisma.recoveryJob.create({
    data: {
      failedPaymentId: failedPayment.id,
      status: opts.status,
      failureType: opts.failureType,
      followUpCount: 0,
      maxFollowUps: 2,
      ...(opts.status === 'waiting' ? { nextAttemptAt: new Date(Date.now() + 86400000) } : {}),
    },
  })

  if (opts.withLedger) {
    await prisma.recoveryLedger.create({
      data: {
        recoveryJobId: job.id,
        failedPaymentId: failedPayment.id,
        amount: failedPayment.amount,
        status: opts.status === 'unrecovered' ? 'unrecovered' : 'recovered',
        ...(opts.status === 'recovered'
          ? { recoveryMethod: opts.recoveryMethod ?? 'retry', recoveredAt: new Date() }
          : {}),
      },
    })
  }

  if (opts.withHitlPending) {
    await prisma.hitlQueue.create({
      data: {
        recoveryJobId: job.id,
        reason: 'High-value case requires human review',
        status: 'pending',
      },
    })
  }

  return { failedPayment, job }
}

test('GET /dashboard/summary returns 200 with all KPI keys as numbers on an empty DB', async () => {
  // Shape-only on purpose: `pnpm test` runs all API test files concurrently
  // against one shared Postgres DB, so other suites' rows can be in-window and
  // literal zero assertions would be flaky. The seeded test below asserts the
  // real values.
  const res = await app.request('/dashboard/summary')
  assert.equal(res.status, 200)
  const data = await res.json()
  for (const key of [
    'recoveredAmount',
    'recoveredCases',
    'activeJobs',
    'stopped',
    'hitlPending',
    'oneClickRecoveredAmount',
  ]) {
    assert.ok(key in data, `summary must include ${key}`)
    assert.equal(typeof data[key], 'number')
  }
  assert.equal(data.windowDays, 30)
})

test('GET /dashboard/summary — recovered ₹ equals ledger sum, counts reflect jobs + hitl', async () => {
  // One-click recovered ₹1499, retry recovered ₹399, one hard unrecovered,
  // one HITL pending (no ledger), one active waiting job (no ledger yet).
  await seedFixture({ amount: 1499, status: 'recovered', failureType: 'soft', withLedger: true, recoveryMethod: 'one_click' })
  await seedFixture({ amount: 399, status: 'recovered', failureType: 'soft', withLedger: true, recoveryMethod: 'retry' })
  await seedFixture({ amount: 7499, status: 'unrecovered', failureType: 'hard', withLedger: true })
  await seedFixture({ amount: 42000, status: 'hitl', failureType: 'autopay_cancelled', withHitlPending: true })
  await seedFixture({ amount: 599, status: 'waiting', failureType: 'soft' })

  const res = await app.request('/dashboard/summary')
  assert.equal(res.status, 200)
  const data = await res.json()

  // Expected values use the same trailing-30-day window as the endpoint;
  // retained rows older than 30 days are intentionally excluded by both.
  // Computed after seeding, before the request, so fixtures (created ~now)
  // are inside the window for both endpoint and assertions.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  // recoveredAmount must equal the ledger sum of status=recovered rows
  const ledgerSum = await prisma.recoveryLedger.aggregate({
    where: { status: 'recovered', recoveredAt: { gte: since } },
    _sum: { amount: true },
  })
  assert.equal(data.recoveredAmount, Number(ledgerSum._sum.amount ?? 0))

  const ledgerCases = await prisma.recoveryLedger.count({
    where: { status: 'recovered', recoveredAt: { gte: since } },
  })
  assert.equal(data.recoveredCases, ledgerCases)

  const oneClickSum = await prisma.recoveryLedger.aggregate({
    where: { status: 'recovered', recoveryMethod: 'one_click', recoveredAt: { gte: since } },
    _sum: { amount: true },
  })
  assert.equal(data.oneClickRecoveredAmount, Number(oneClickSum._sum.amount ?? 0))

  const active = await prisma.recoveryJob.count({
    where: { status: { in: ['pending', 'processing', 'waiting'] }, createdAt: { gte: since } },
  })
  assert.equal(data.activeJobs, active)

  const stopped = await prisma.recoveryJob.count({
    where: { status: { in: ['unrecovered', 'rejected', 'stale'] }, createdAt: { gte: since } },
  })
  assert.equal(data.stopped, stopped)

  const hitlPending = await prisma.hitlQueue.count({ where: { status: 'pending' } })
  assert.equal(data.hitlPending, hitlPending)

  // Sanity: our fixtures moved the numbers off zero.
  assert.ok(data.recoveredAmount > 0, 'recoveredAmount must include the seeded ₹1499 + ₹399')
  assert.ok(data.activeJobs >= 1, 'waiting job must count as active')
  assert.ok(data.stopped >= 1, 'unrecovered job must count as stopped')
  assert.ok(data.hitlPending >= 1, 'pending hitl task must be counted')
})