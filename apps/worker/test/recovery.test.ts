// Recovery Worker integration tests — testing stopping rules evaluation
// and DB execution against PostgreSQL.
// Run: pnpm --filter @grabit/worker test

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { prisma, Prisma } from '@grabit/db'
import { config } from '@grabit/config'
import { fromISTComponents, toISTComponents, PaymentLinkService } from '@grabit/core'
import { getQueue, closeAllQueues } from '@grabit/queue'
import { processRecoveryJob, stableUuid, buildAgentPayload } from '../src/workers/recovery.worker.js'
import { processIngestEvent } from '../src/workers/ingest.worker.js'
import { MockMessageProvider, processMessage } from '../src/workers/message.worker.js'

const originalMessageChannel = config.messageChannel
config.messageChannel = 'mock'
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
  config.messageChannel = originalMessageChannel
  await prisma.$disconnect()
})

async function seedJob(opts: {
  amount?: number
  customerPhone?: string
  failureCode?: string
  failureType?: 'hard' | 'soft' | 'autopay_failed' | 'autopay_cancelled'
  followUpCount?: number
  maxFollowUps?: number
  status?: 'pending' | 'processing' | 'waiting' | 'hitl' | 'recovered' | 'unrecovered' | 'rejected' | 'stale'
  isPaid?: boolean
}) {
  const razorpayPaymentId = uniqPaymentId()
  const failedPayment = await prisma.failedPayment.create({
    data: {
      razorpayPaymentId,
      amount: new Prisma.Decimal(opts.amount ?? 1500),
      currency: 'INR',
      isPaid: opts.isPaid ?? false,
      customerPhone: opts.customerPhone ?? '+919876543210',
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
  const originalAiAgentUrl = config.aiAgentUrl
  config.aiAgentUrl = 'http://127.0.0.1:1'
  let result
  try {
    result = await processRecoveryJob({ recoveryJobId: job.id }, daytime)
  } finally {
    config.aiAgentUrl = originalAiAgentUrl
  }

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

test('recovery: payment marked isPaid=true stops recovered immediately without AI call', async () => {
  const { job, failedPayment } = await seedJob({
    amount: 1500,
    isPaid: true,
  })

  const result = await processRecoveryJob({ recoveryJobId: job.id })

  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'stop_recovered')
  assert.equal(result.decision?.rule, 'already_recovered')
  assert.equal(result.decision?.shouldCallAi, false)

  const updatedJob = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updatedJob.status, 'recovered')

  const ledger = await prisma.recoveryLedger.findFirstOrThrow({
    where: { recoveryJobId: job.id },
  })
  assert.equal(ledger.status, 'recovered')
  assert.equal(ledger.amount.toString(), '1500')
  assert.equal(ledger.failedPaymentId, failedPayment.id)

  const decisions = await prisma.agentDecision.findMany({ where: { recoveryJobId: job.id } })
  assert.equal(decisions.length, 0)
})

test('recovery: paymentStatusResolver returning paid updates DB and stops before AI', async () => {
  const { job, failedPayment } = await seedJob({
    amount: 2000,
    isPaid: false,
  })

  let resolverCalls = 0
  const mockResolver = async (id: string) => {
    resolverCalls++
    assert.equal(id, failedPayment.razorpayPaymentId)
    return 'paid' as const
  }

  const result = await processRecoveryJob({
    recoveryJobId: job.id,
    paymentStatusResolver: mockResolver,
  })

  assert.equal(resolverCalls, 1)
  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'stop_recovered')
  assert.equal(result.decision?.rule, 'already_recovered')
  assert.equal(result.decision?.shouldCallAi, false)

  const updatedPayment = await prisma.failedPayment.findUniqueOrThrow({ where: { id: failedPayment.id } })
  assert.equal(updatedPayment.isPaid, true)
  assert.ok(updatedPayment.paidAt)

  const updatedJob = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updatedJob.status, 'recovered')

  const decisions = await prisma.agentDecision.findMany({ where: { recoveryJobId: job.id } })
  assert.equal(decisions.length, 0)
})

test('recovery: paymentStatusResolver error or failed does not mark paid and does not assume recovered', async () => {
  const { job, failedPayment } = await seedJob({
    amount: 1500,
    isPaid: false,
    failureType: 'soft',
  })

  const failingResolver = async () => {
    throw new Error('Network error connecting to payment gateway')
  }

  const daytime = fromISTComponents(2025, 5, 10, 11, 0, 0)
  const result = await processRecoveryJob({
    recoveryJobId: job.id,
    paymentStatusResolver: failingResolver,
  }, daytime)

  assert.equal(result.outcome, 'completed')
  // Because status was unknown, it proceeded with normal stopping rules and daytime soft failure -> continue to AI
  assert.equal(result.decision?.action, 'continue')
  assert.equal(result.decision?.shouldCallAi, true)

  const updatedPayment = await prisma.failedPayment.findUniqueOrThrow({ where: { id: failedPayment.id } })
  assert.equal(updatedPayment.isPaid, false)
})

test('recovery: continue re-entry guard skips AI call and reuses existing agent_decisions', async () => {
  const { job } = await seedJob({ amount: 1500, failureType: 'soft' })
  const daytime = fromISTComponents(2025, 5, 10, 11, 0, 0)

  // Seed existing agent_decision in DB before running processRecoveryJob
  const decisionId = stableUuid(`agent-decision:${job.id}`)
  await prisma.agentDecision.create({
    data: {
      id: decisionId,
      recoveryJobId: job.id,
      decisionType: 'one_click',
      explanation: 'Pre-existing decision explanation',
      actionPayload: {
        customer_message: 'Pay now via https://rzp.io/l/existing',
        taxonomy_match: 'insufficient_funds',
      },
      confidence: 0.95,
      modelVersion: 'gemini-3.1-flash',
    },
  })

  const result = await processRecoveryJob({ recoveryJobId: job.id, paymentLinkService: new PaymentLinkService({ enabled: false }) }, daytime)

  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'continue')

  // Job should not be escalated to HITL fallback because AI call was skipped and existing one_click was reused
  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.notEqual(updated.status, 'hitl')

  // Exactly one agent decision row exists
  const decisions = await prisma.agentDecision.findMany({
    where: { recoveryJobId: job.id },
  })
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].decisionType, 'one_click')
  assert.equal(decisions[0].explanation, 'Pre-existing decision explanation')

  // Message queue should contain the job with stable jobId
  const expectedJobId = stableUuid(`message:${job.id}:${job.followUpCount}`)
  const msgQueue = getQueue('message')
  const enqueued = await msgQueue.getJob(expectedJobId)
  assert.ok(enqueued, 'Message job must be enqueued with stable jobId')
  assert.equal(enqueued.data.recoveryJobId, job.id)
  assert.equal(enqueued.data.messageBody, 'Pay now via https://rzp.io/l/existing')
  await enqueued.remove()
})

test('recovery: retry after successful AI call calls AI HTTP once and maintains single agent_decisions row', async () => {
  let aiCallCount = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/decide' && req.method === 'POST') {
      aiCallCount++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          decision_type: 'one_click',
          failure_type: 'soft',
          explanation: 'Mocked agent diagnosis',
          customer_message: 'Hi, retry your payment here: https://rzp.io/l/mock',
          action_payload: { link: 'https://rzp.io/l/mock' },
          confidence: 0.99,
          model_version: 'mock-agent-v1',
          should_escalate_hitl: false,
          taxonomy_match: 'insufficient_funds',
          tools_used: ['payment_lookup'],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const originalAiAgentUrl = config.aiAgentUrl
  config.aiAgentUrl = `http://127.0.0.1:${port}`

  try {
    const { job } = await seedJob({ amount: 1200, failureType: 'soft' })
    const daytime = fromISTComponents(2025, 5, 10, 11, 0, 0)

    // First attempt: calls AI HTTP endpoint
    const result1 = await processRecoveryJob({ recoveryJobId: job.id, paymentLinkService: new PaymentLinkService({ enabled: false }) }, daytime)
    assert.equal(result1.outcome, 'completed')
    assert.equal(aiCallCount, 1)

    const decisionsAfterFirst = await prisma.agentDecision.findMany({
      where: { recoveryJobId: job.id },
    })
    assert.equal(decisionsAfterFirst.length, 1)
    assert.equal(decisionsAfterFirst[0].decisionType, 'one_click')

    // Second attempt (retry/re-evaluation): re-entry guard kicks in, skips AI HTTP
    const result2 = await processRecoveryJob({ recoveryJobId: job.id, paymentLinkService: new PaymentLinkService({ enabled: false }) }, daytime)
    assert.equal(result2.outcome, 'completed')
    assert.equal(aiCallCount, 1, 'AI HTTP must not be called again on retry')

    // Still exactly one decision row
    const decisionsAfterSecond = await prisma.agentDecision.findMany({
      where: { recoveryJobId: job.id },
    })
    assert.equal(decisionsAfterSecond.length, 1)

    // Verify stable message queue jobId
    const expectedJobId = stableUuid(`message:${job.id}:${job.followUpCount}`)
    const msgQueue = getQueue('message')
    const msgJob = await msgQueue.getJob(expectedJobId)
    assert.ok(msgJob)
    assert.equal(msgJob.data.messageBody, 'Hi, retry your payment here: https://rzp.io/l/mock')
    await msgJob.remove()
  } finally {
    config.aiAgentUrl = originalAiAgentUrl
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('recovery: parallel deliveries invoke AI endpoint only once', async () => {
  let aiCallCount = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/decide' && req.method === 'POST') {
      aiCallCount++
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            decision_type: 'one_click',
            failure_type: 'soft',
            explanation: 'Parallel test diagnosis',
            customer_message: 'Hi, retry here: https://rzp.io/l/parallel',
            action_payload: { link: 'https://rzp.io/l/parallel' },
            confidence: 0.95,
            model_version: 'mock-parallel-v1',
            should_escalate_hitl: false,
            taxonomy_match: 'insufficient_funds',
            tools_used: [],
          }),
        )
      }, 100)
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const originalAiAgentUrl = config.aiAgentUrl
  config.aiAgentUrl = `http://127.0.0.1:${port}`

  try {
    const { job } = await seedJob({ amount: 1200, failureType: 'soft' })
    const daytime = fromISTComponents(2025, 5, 10, 11, 0, 0)

    const [res1, res2] = await Promise.all([
      processRecoveryJob({ recoveryJobId: job.id, paymentLinkService: new PaymentLinkService({ enabled: false }) }, daytime),
      processRecoveryJob({ recoveryJobId: job.id, paymentLinkService: new PaymentLinkService({ enabled: false }) }, daytime),
    ])

    assert.equal(res1.outcome, 'completed')
    assert.equal(res2.outcome, 'completed')
    assert.equal(aiCallCount, 1, 'Parallel deliveries must only invoke AI endpoint once')

    const decisions = await prisma.agentDecision.findMany({
      where: { recoveryJobId: job.id },
    })
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].decisionType, 'one_click')
  } finally {
    config.aiAgentUrl = originalAiAgentUrl
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('queue: two enqueue attempts with same deterministic jobId creates only one BullMQ job', async () => {
  const msgQueue = getQueue('message')
  const testJobId = stableUuid(`message:test-dedupe-job:${Date.now()}`)

  const job1 = await msgQueue.add(
    'send-recovery-message',
    { test: true, attempt: 1 },
    { jobId: testJobId },
  )

  const job2 = await msgQueue.add(
    'send-recovery-message',
    { test: true, attempt: 2 },
    { jobId: testJobId },
  )

  assert.equal(job1.id, testJobId)
  assert.equal(job2.id, testJobId)

  // Verify there is only one job in the queue for this jobId
  const fetched = await msgQueue.getJob(testJobId)
  assert.ok(fetched)
  assert.equal(fetched.id, testJobId)
  // Payload is the first one added because duplicate jobId was ignored by BullMQ
  assert.equal(fetched.data.attempt, 1)

  await fetched.remove()
})

test('e2e: failed -> payment.captured/order.paid -> recovery stops before AI, single ledger row, no message', async () => {
  for (const successEvent of ['payment.captured', 'order.paid'] as const) {
    const id = uniqPaymentId()

    // 1. Original failure arrives
    const failResult = await processIngestEvent({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id,
            order_id: `order_${id}`,
            amount: 100000, // paise -> ₹1000
            currency: 'INR',
            method: 'upi',
            error_code: 'insufficient_funds',
            error_description: 'Insufficient funds in the account',
            contact: '+919876543210',
            email: 'customer@example.com',
            notes: null,
          },
        },
      },
      receivedAt: new Date().toISOString(),
    })
    assert.equal(failResult.outcome, 'created')

    // 2. Later capture/success event for the same payment id
    const cap1 = await processIngestEvent({
      event: successEvent,
      payload: {
        payment: {
          entity: { id, amount: 100000, status: 'captured' },
        },
      },
      receivedAt: new Date().toISOString(),
    })
    assert.equal(cap1.outcome, 'updated')
    assert.equal(cap1.recoveryJobId, failResult.recoveryJobId)

    // 3. Duplicate capture is idempotent — no new state
    const cap2 = await processIngestEvent({
      event: successEvent,
      payload: {
        payment: {
          entity: { id, amount: 100000, status: 'captured' },
        },
      },
      receivedAt: new Date().toISOString(),
    })
    assert.equal(cap2.outcome, 'duplicate')

    // 4. Recovery worker evaluates the open job: isPaid=true -> stop_recovered
    const daytime = fromISTComponents(2025, 5, 10, 11, 0, 0)
    const result = await processRecoveryJob({ recoveryJobId: cap1.recoveryJobId! }, daytime)
    assert.equal(result.outcome, 'completed')
    assert.equal(result.decision?.action, 'stop_recovered')
    assert.equal(result.decision?.rule, 'already_recovered')
    assert.equal(result.decision?.shouldCallAi, false)

    const job = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: cap1.recoveryJobId! } })
    assert.equal(job.status, 'recovered')

    // Ledger written exactly once, in rupees
    const ledger = await prisma.recoveryLedger.findMany({ where: { recoveryJobId: job.id } })
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].status, 'recovered')
    assert.equal(ledger[0].amount.toString(), '1000')
    assert.ok(ledger[0].recoveredAt)

    // No AI decision, no message enqueued, no message row
    const decisions = await prisma.agentDecision.findMany({ where: { recoveryJobId: job.id } })
    assert.equal(decisions.length, 0)
    const msgQueue = getQueue('message')
    assert.equal(await msgQueue.getJob(stableUuid(`message:${job.id}:${job.followUpCount}`)), undefined)
    assert.equal(await prisma.message.count({ where: { recoveryJobId: job.id } }), 0)

    // 5. Re-evaluation (e.g. queued duplicate) keeps exactly one ledger row
    const again = await processRecoveryJob({ recoveryJobId: job.id }, daytime)
    assert.equal(again.decision?.action, 'stop_recovered')
    const ledgerAgain = await prisma.recoveryLedger.findMany({ where: { recoveryJobId: job.id } })
    assert.equal(ledgerAgain.length, 1)
  }
})

test('e2e: send 1 then paid -> closing tick marks recovered, no send 2, zero AI calls', async () => {
  const { job, failedPayment } = await seedJob({ amount: 1200, failureType: 'soft' })

  // Send 1 happens while the payment is still unpaid; the message worker
  // bumps the count and schedules the follow-up tick.
  const send1 = await processMessage({
    recoveryJobId: job.id,
    followUpCount: 0,
    toPhone: '+919876543210',
    messageBody: 'Pay here: https://example.test/pay/demo',
    paymentLinkUrl: 'https://example.test/pay/demo',
  }, new Date('2026-01-01T10:00:00Z'), new MockMessageProvider('paid-e2e'))
  assert.equal(send1.outcome, 'sent')
  assert.equal((await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })).followUpCount, 1)

  // The customer pays via the link before the wait-window tick fires — the
  // payment.captured webhook marks failed_payments.is_paid (PR #6/#24).
  await prisma.failedPayment.update({
    where: { id: failedPayment.id },
    data: { isPaid: true, paidAt: new Date('2026-01-01T14:00:00Z') },
  })
  const tickTime = new Date('2026-01-01T15:00:00Z')
  const result = await processRecoveryJob({ recoveryJobId: job.id }, tickTime)

  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'stop_recovered')
  assert.equal(result.decision?.rule, 'already_recovered')
  assert.equal(result.decision?.shouldCallAi, false)

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.status, 'recovered')

  const ledger = await prisma.recoveryLedger.findMany({ where: { recoveryJobId: job.id } })
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].status, 'recovered')
  assert.equal(ledger[0].amount.toString(), '1200')

  assert.equal(await prisma.agentDecision.count({ where: { recoveryJobId: job.id } }), 0, 'AI must not decide payment status')
  assert.equal(await getQueue('message').getJob(stableUuid(`message:${job.id}:1`)), undefined, 'no second message')
  assert.equal(await prisma.message.count({ where: { recoveryJobId: job.id } }), 1)

  await getQueue('recovery').remove(stableUuid(`recovery:${job.id}:fu1`))
})

test('e2e: send 1 unpaid -> follow-up tick allows send 2 (count 1 -> 2)', async () => {
  const { job } = await seedJob({ amount: 1200, failureType: 'soft' })

  await processMessage({
    recoveryJobId: job.id,
    followUpCount: 0,
    toPhone: '+919876543210',
    messageBody: 'Pay here: https://example.test/pay/demo',
    paymentLinkUrl: 'https://example.test/pay/demo',
  }, new Date('2026-01-01T10:00:00Z'), new MockMessageProvider('fu2-e2e'))

  // Wait-window tick 4.5h later: repeat gap passed, still unpaid -> continue
  const tickTime = new Date('2026-01-01T14:30:00Z')
  const tick = await processRecoveryJob({
    recoveryJobId: job.id,
    agentOverride: {
      decision_type: 'one_click',
      failure_type: 'soft',
      explanation: 'first follow-up',
      customer_message: 'Hi, please try your payment again.',
      action_payload: {},
      confidence: 0.95,
      model_version: 'test-override',
      should_escalate_hitl: false,
      taxonomy_match: null,
      tools_used: [],
    },
    paymentLinkService: new PaymentLinkService({ enabled: false }),
  }, tickTime)
  assert.equal(tick.decision?.action, 'continue')

  const afterTick = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(afterTick.status, 'processing')

  // Message #2 enqueued with followUpCount = 1 and the stable jobId.
  const msg2 = await getQueue('message').getJob(stableUuid(`message:${job.id}:1`))
  assert.ok(msg2, 'second message must be enqueued')
  assert.equal(msg2.data.followUpCount, 1)

  // Send 2 executes and bumps to the max count; its closing tick schedules.
  const send2 = await processMessage(msg2.data, new Date('2026-01-01T14:30:10Z'), new MockMessageProvider('fu2-send2'))
  assert.equal(send2.outcome, 'sent')
  const afterSend2 = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(afterSend2.followUpCount, 2)
  assert.ok(
    await getQueue('recovery').getJob(stableUuid(`recovery:${job.id}:fu2`)),
    'send 2 must schedule the closing recovery tick',
  )

  await msg2.remove()
  await getQueue('recovery').remove(stableUuid(`recovery:${job.id}:fu1`))
  await getQueue('recovery').remove(stableUuid(`recovery:${job.id}:fu2`))
})

test('e2e: send 2 unpaid -> unrecovered ledger written once, extra tick idempotent, no third message', async () => {
  const { job } = await seedJob({ amount: 1200, failureType: 'soft', followUpCount: 2, maxFollowUps: 2 })
  await prisma.message.create({
    data: {
      recoveryJobId: job.id,
      toPhone: '+919876543210',
      messageBody: 'second follow-up',
      status: 'sent',
      sentAt: new Date('2026-01-01T10:00:00Z'),
      createdAt: new Date('2026-01-01T10:00:00Z'),
    },
  })

  // Closing tick lands 25h after the last send — past the 24h staleness
  // threshold. Once the budget is exhausted the case closes as unrecovered
  // (ledger row), never stale and never a third send.
  const r1 = await processRecoveryJob({ recoveryJobId: job.id }, new Date('2026-01-02T11:00:00Z'))
  assert.equal(r1.decision?.action, 'stop_unrecovered')
  assert.equal(r1.decision?.rule, 'max_followups_exceeded')

  // Duplicate delayed tick (queue replay) keeps exactly one ledger row.
  const r2 = await processRecoveryJob({ recoveryJobId: job.id }, new Date('2026-01-02T12:00:00Z'))
  assert.equal(r2.decision?.action, 'stop_unrecovered')

  const ledger = await prisma.recoveryLedger.findMany({ where: { recoveryJobId: job.id } })
  assert.equal(ledger.length, 1, 'duplicate ticks must keep exactly one ledger row')
  assert.equal(ledger[0].status, 'unrecovered')
  assert.equal(ledger[0].amount.toString(), '1200')

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.status, 'unrecovered')

  assert.equal(await getQueue('message').getJob(stableUuid(`message:${job.id}:2`)), undefined, 'no third message')
  assert.equal(await prisma.message.count({ where: { recoveryJobId: job.id } }), 1)
})

test('e2e: unpaid with one follow-up remaining, 25h silence -> stale', async () => {
  const { job } = await seedJob({ amount: 1200, failureType: 'soft', followUpCount: 1, maxFollowUps: 2 })
  await prisma.message.create({
    data: {
      recoveryJobId: job.id,
      toPhone: '+919876543210',
      messageBody: 'first follow-up',
      status: 'sent',
      sentAt: new Date('2026-01-01T10:00:00Z'),
      createdAt: new Date('2026-01-01T10:00:00Z'),
    },
  })

  const result = await processRecoveryJob({ recoveryJobId: job.id }, new Date('2026-01-02T12:00:00Z'))
  assert.equal(result.decision?.action, 'stale')
  assert.equal(result.decision?.rule, 'stale_timeout')

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.status, 'stale')
})

test('e2e: follow-up tick during quiet hours delays to next morning 08:00 IST', async () => {
  const { job } = await seedJob({ amount: 1200, failureType: 'soft', followUpCount: 1 })
  await prisma.message.create({
    data: {
      recoveryJobId: job.id,
      toPhone: '+919876543210',
      messageBody: 'first follow-up',
      status: 'sent',
      sentAt: fromISTComponents(2025, 5, 10, 14, 0, 0),
      createdAt: fromISTComponents(2025, 5, 10, 14, 0, 0),
    },
  })

  // 22:30 IST tick — repeat gap (4h) passed, but now inside quiet hours.
  const nightTick = fromISTComponents(2025, 5, 10, 22, 30, 0)
  const result = await processRecoveryJob({ recoveryJobId: job.id }, nightTick)
  assert.equal(result.decision?.action, 'delay')

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.status, 'waiting')
  assert.ok(updated.nextAttemptAt)
  const ist = toISTComponents(updated.nextAttemptAt)
  assert.equal(ist.day, 11)
  assert.equal(ist.hours, 8)
  assert.equal(ist.minutes, 0)
})

test('e2e: hard failure never reaches the message worker and keeps count 0', async () => {
  const { job } = await seedJob({ amount: 1500, failureType: 'hard', failureCode: 'card_blocked' })
  const result = await processRecoveryJob({ recoveryJobId: job.id }, fromISTComponents(2025, 5, 10, 11, 0, 0))
  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'stop_unrecovered')
  assert.equal(result.decision?.rule, 'hard_failure')

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.status, 'unrecovered')
  assert.equal(updated.followUpCount, 0)
  assert.equal(await getQueue('message').getJob(stableUuid(`message:${job.id}:0`)), undefined)
  assert.equal(await prisma.message.count({ where: { recoveryJobId: job.id } }), 0)
})

test('recovery: buildAgentPayload strips customer PII (phone, email, full name)', () => {
  const mockJob = {
    id: '00000000-0000-0000-0000-000000000001',
    followUpCount: 1,
    maxFollowUps: 2,
    status: 'pending',
    failedPayment: {
      razorpayPaymentId: 'pay_test_pii_123',
      amount: new Prisma.Decimal(1499),
      currency: 'INR',
      failureCode: 'insufficient_funds',
      failureReason: 'Account has insufficient funds',
      failureSource: 'payment',
      paymentMethod: 'upi',
      customerName: 'Aarav Sharma',
      customerPhone: '+919999999999',
      customerEmail: 'aarav.sharma@example.com',
      contact: '+919876543210',
      email: 'customer@test.com',
      notes: { customer_name: 'Aarav Sharma' },
    },
  }

  const payload = buildAgentPayload(mockJob)

  // Verify exact schema shape
  assert.deepEqual(payload, {
    job_id: '00000000-0000-0000-0000-000000000001',
    failed_payment: {
      razorpay_payment_id: 'pay_test_pii_123',
      amount: 1499,
      currency: 'INR',
      failure_code: 'insufficient_funds',
      failure_reason: 'Account has insufficient funds',
      failure_source: 'payment',
      payment_method: 'upi',
    },
    job: {
      follow_up_count: 1,
      max_follow_ups: 2,
      status: 'pending',
    },
  })

  // Verify that no PII strings leak into serialized JSON
  const serialized = JSON.stringify(payload)
  assert.equal(serialized.includes('+91'), false, 'Serialized payload should not contain phone country code +91')
  assert.equal(serialized.includes('@'), false, 'Serialized payload should not contain email symbol @')
  assert.equal(serialized.includes('Aarav'), false, 'Serialized payload should not contain customer name')
  assert.equal(serialized.includes('customer_name'), false, 'Serialized payload should not have customer_name key')
  assert.equal(serialized.includes('customer_phone'), false, 'Serialized payload should not have customer_phone key')
})
