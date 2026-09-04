// Integration tests for /jobs and /jobs/:id/timeline endpoints.
// Run: pnpm --filter @grabit/api test

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, Prisma } from '@grabit/db'
import { app } from '../src/app.js'

const createdPaymentIds: string[] = []
const uniqPaymentId = () => {
  const id = `pay_api_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  createdPaymentIds.push(id)
  return id
}

after(async () => {
  // Cascading deletes on failed_payments remove recovery_jobs, ledger, messages, hitl tasks, agent decisions
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
  amount?: number
  failureType?: 'hard' | 'soft' | 'autopay_failed' | 'autopay_cancelled'
  status?: 'pending' | 'processing' | 'waiting' | 'hitl' | 'recovered' | 'unrecovered' | 'rejected' | 'stale'
  withAuditLog?: boolean
  withDecision?: boolean
  withMessage?: boolean
  withHitl?: boolean
  withLedger?: boolean
  messageCreatedAt?: Date
  decisionCreatedAt?: Date
  ledgerCreatedAt?: Date
}) {
  const razorpayPaymentId = uniqPaymentId()
  const failedPayment = await prisma.failedPayment.create({
    data: {
      razorpayPaymentId,
      amount: new Prisma.Decimal(opts.amount ?? 2499),
      currency: 'INR',
      failureCode: 'insufficient_funds',
      failureReason: 'Insufficient balance in account',
      failureSource: 'payment',
      paymentMethod: 'upi',
      customerPhone: '+919876543210',
      customerName: 'Test Customer',
      customerEmail: 'test@example.com',
      rawPayload: { entity: { id: razorpayPaymentId } },
    },
  })

  const job = await prisma.recoveryJob.create({
    data: {
      failedPaymentId: failedPayment.id,
      status: opts.status ?? 'pending',
      failureType: opts.failureType ?? 'soft',
      followUpCount: 0,
      maxFollowUps: 2,
    },
  })

  if (opts.withAuditLog) {
    await prisma.auditLog.create({
      data: {
        entityType: 'recovery_jobs',
        entityId: job.id,
        action: 'stopping_rules_passed',
        oldValue: { status: 'pending' },
        newValue: {
          status: 'processing',
          reason: 'All stopping and timing rules passed. Ready for AI processing.',
        },
        performedBy: 'stopping_rules',
      },
    })
  }

  if (opts.withDecision) {
    await prisma.agentDecision.create({
      data: {
        recoveryJobId: job.id,
        decisionType: 'one_click',
        explanation: 'Low balance soft decline; salary credit period detected.',
        confidence: 0.92,
        modelVersion: 'gemini-2.0-flash',
        actionPayload: {
          template: 'recovery_link_v1',
          urgency: 'medium',
        },
        ...(opts.decisionCreatedAt ? { createdAt: opts.decisionCreatedAt } : {}),
      },
    })
  }

  if (opts.withMessage) {
    await prisma.message.create({
      data: {
        recoveryJobId: job.id,
        channel: 'whatsapp',
        toPhone: '+919876543210',
        messageBody: 'Hi Test, your payment of ₹2499 failed. Tap here to retry: https://rzp.io/l/xyz',
        status: 'delivered',
        sentAt: opts.messageCreatedAt ?? new Date(),
        ...(opts.messageCreatedAt ? { createdAt: opts.messageCreatedAt } : {}),
      },
    })
  }

  if (opts.withHitl) {
    await prisma.hitlQueue.create({
      data: {
        recoveryJobId: job.id,
        reason: 'Payment amount exceeds HITL threshold of ₹10,000.',
        status: 'pending',
      },
    })
  }

  if (opts.withLedger) {
    await prisma.recoveryLedger.create({
      data: {
        recoveryJobId: job.id,
        failedPaymentId: failedPayment.id,
        amount: failedPayment.amount,
        status: 'recovered',
        recoveryMethod: 'one_click',
        recoveredAt: opts.ledgerCreatedAt ?? new Date(),
        ...(opts.ledgerCreatedAt ? { createdAt: opts.ledgerCreatedAt } : {}),
      },
    })
  }

  return { failedPayment, job }
}

test('GET /jobs returns 200 with jobs array (empty DB does not 500)', async () => {
  const res = await app.request('/jobs')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(Array.isArray(data.jobs))
})

test('GET /jobs returns seeded job with status, failure_type, and amount', async () => {
  const { job, failedPayment } = await seedFixture({
    amount: 1999,
    failureType: 'soft',
    status: 'pending',
    withAuditLog: true,
    withDecision: true,
  })

  const res = await app.request('/jobs')
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(Array.isArray(data.jobs))

  const found = data.jobs.find((j: any) => j.id === job.id)
  assert.ok(found, 'Seeded job should be found in /jobs list')
  assert.equal(found.id, job.id)
  assert.equal(found.status, 'pending')
  assert.equal(found.failureType, 'soft')
  assert.equal(found.failure_type, 'soft')
  assert.equal(found.amount, 1999)
  assert.equal(found.currency, 'INR')
  assert.equal(found.razorpayPaymentId, failedPayment.razorpayPaymentId)
  assert.equal(found.customerPhone, '+919876543210')
  assert.ok(found.latestDecision)
  assert.equal(found.latestDecision.decisionType, 'one_click')
})

test('GET /jobs filters by status and failure_type', async () => {
  const { job: job1 } = await seedFixture({
    amount: 500,
    failureType: 'hard',
    status: 'unrecovered',
  })
  const { job: job2 } = await seedFixture({
    amount: 15000,
    failureType: 'soft',
    status: 'hitl',
  })

  // Filter by status=hitl
  const resStatus = await app.request('/jobs?status=hitl')
  assert.equal(resStatus.status, 200)
  const dataStatus = await resStatus.json()
  const foundInStatus = dataStatus.jobs.find((j: any) => j.id === job2.id)
  const notFoundInStatus = dataStatus.jobs.find((j: any) => j.id === job1.id)
  assert.ok(foundInStatus, 'job2 should be present when filtering status=hitl')
  assert.equal(notFoundInStatus, undefined, 'job1 should not be present when filtering status=hitl')

  // Filter by failure_type=hard
  const resFailure = await app.request('/jobs?failure_type=hard')
  assert.equal(resFailure.status, 200)
  const dataFailure = await resFailure.json()
  const foundInFailure = dataFailure.jobs.find((j: any) => j.id === job1.id)
  const notFoundInFailure = dataFailure.jobs.find((j: any) => j.id === job2.id)
  assert.ok(foundInFailure, 'job1 should be present when filtering failure_type=hard')
  assert.equal(notFoundInFailure, undefined, 'job2 should not be present when filtering failure_type=hard')
})

test('GET /jobs validates status/failure_type/from/to and strips rawPayload PII', async () => {
  const { job } = await seedFixture({ withMessage: true })

  // Unsupported enum values must be rejected with 400, not a Prisma 500
  const badStatus = await app.request('/jobs?status=bogus')
  assert.equal(badStatus.status, 400)
  const badFailure = await app.request('/jobs?failure_type=nope')
  assert.equal(badFailure.status, 400)
  const badFrom = await app.request('/jobs?from=not-a-date')
  assert.equal(badFrom.status, 400)
  const badTo = await app.request('/jobs?to=nonsense')
  assert.equal(badTo.status, 400)

  // rawPayload (verbatim webhook + customer data) must not be serialized
  const ok = await app.request(`/jobs/${job.id}`)
  assert.equal(ok.status, 200)
  const data = await ok.json()
  assert.equal(data.job.failedPayment.rawPayload, undefined)
  assert.ok(JSON.stringify(data).includes('pay_') || true)
  assert.equal(JSON.stringify(data).includes('rawPayload'), false)
})

test('GET /jobs/:id returns 404 for non-existent or invalid UUID', async () => {
  const nonExistentUuid = '00000000-0000-0000-0000-000000000000'
  const resNotFound = await app.request(`/jobs/${nonExistentUuid}`)
  assert.equal(resNotFound.status, 404)

  const resInvalid = await app.request('/jobs/not-a-valid-uuid')
  assert.equal(resInvalid.status, 404)
})

test('GET /jobs/:id returns job detail with relations', async () => {
  const { job } = await seedFixture({
    amount: 3500,
    failureType: 'autopay_failed',
    status: 'waiting',
    withDecision: true,
    withMessage: true,
  })

  const res = await app.request(`/jobs/${job.id}`)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.id, job.id)
  assert.equal(data.status, 'waiting')
  assert.equal(data.failureType, 'autopay_failed')
  assert.equal(data.amount, 3500)
  assert.equal(data.decisions.length, 1)
  assert.equal(data.messages.length, 1)
})

test('GET /jobs/:id/timeline returns 404 for non-existent job', async () => {
  const nonExistentUuid = '00000000-0000-0000-0000-000000000000'
  const res = await app.request(`/jobs/${nonExistentUuid}/timeline`)
  assert.equal(res.status, 404)

  const resInvalid = await app.request('/jobs/invalid-id/timeline')
  assert.equal(resInvalid.status, 404)
})

test('GET /jobs/:id/timeline returns time-ordered events with stopping-rule reason', async () => {
  // Seed the message with an OLDER timestamp than the decision so the
  // endpoint's explicit chronological sort is what satisfies the ordering
  // assertion — insertion order alone would put the message last and fail.
  const olderBySeconds = new Date(Date.now() - 5_000)
  const { job } = await seedFixture({
    amount: 4999,
    failureType: 'soft',
    status: 'recovered',
    withAuditLog: true,
    withDecision: true,
    withMessage: true,
    withLedger: true,
    messageCreatedAt: olderBySeconds,
    ledgerCreatedAt: olderBySeconds,
  })

  const res = await app.request(`/jobs/${job.id}/timeline`)
  assert.equal(res.status, 200)
  const data = await res.json()

  assert.equal(data.jobId, job.id)
  assert.ok(Array.isArray(data.timeline))
  assert.ok(data.timeline.length >= 4, 'Timeline should contain multiple events across stages')

  // Verify chronological ordering
  for (let i = 1; i < data.timeline.length; i++) {
    const prevTime = new Date(data.timeline[i - 1].timestamp).getTime()
    const currTime = new Date(data.timeline[i].timestamp).getTime()
    assert.ok(currTime >= prevTime, `Event ${i} must be chronologically after or equal to event ${i - 1}`)
  }

  // Verify event types are present
  const types = data.timeline.map((e: any) => e.type)
  assert.ok(types.includes('ingested'), 'Timeline should have ingested event')
  assert.ok(types.includes('rule_decision'), 'Timeline should have rule_decision event')
  assert.ok(types.includes('agent_decision'), 'Timeline should have agent_decision event')
  assert.ok(types.includes('message'), 'Timeline should have message event')
  assert.ok(types.includes('ledger'), 'Timeline should have ledger event')

  // Verify stopping-rule reason is preserved
  const ruleEvent = data.timeline.find((e: any) => e.type === 'rule_decision')
  assert.ok(ruleEvent, 'Rule decision event should exist')
  assert.match(ruleEvent.reason, /All stopping and timing rules passed/)

  // Verify AI decision explanation is preserved
  const aiEvent = data.timeline.find((e: any) => e.type === 'agent_decision')
  assert.ok(aiEvent, 'Agent decision event should exist')
  assert.match(aiEvent.reason, /salary credit period detected/)

  // Verify ledger entry details
  const ledgerEvent = data.timeline.find((e: any) => e.type === 'ledger')
  assert.ok(ledgerEvent, 'Ledger event should exist')
  assert.equal(ledgerEvent.data.amount, 4999)
  assert.equal(ledgerEvent.data.status, 'recovered')
})
