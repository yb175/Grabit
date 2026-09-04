import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, Prisma } from '@grabit/db'
import { fromISTComponents, PaymentLinkService } from '@grabit/core'
import { closeAllQueues } from '@grabit/queue'
import { processRecoveryJob } from '../src/workers/recovery.worker.js'

const paymentIds: string[] = []
const uniqPaymentId = () => {
  const id = `pay_plink_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  paymentIds.push(id)
  return id
}

after(async () => {
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
  customerPhone?: string
  customerName?: string
  paymentLinkId?: string
  paymentLinkUrl?: string
}) {
  const razorpayPaymentId = uniqPaymentId()
  const failedPayment = await prisma.failedPayment.create({
    data: {
      razorpayPaymentId,
      amount: new Prisma.Decimal(opts.amount ?? 1500),
      currency: 'INR',
      failureCode: opts.failureCode ?? 'insufficient_funds',
      failureReason: 'Bank declined transaction due to low balance',
      failureSource: 'payment',
      customerName: opts.customerName ?? 'Rahul Verma',
      customerPhone: opts.customerPhone ?? '+919876543210',
      rawPayload: {},
    },
  })

  const job = await prisma.recoveryJob.create({
    data: {
      failedPaymentId: failedPayment.id,
      status: 'pending',
      failureType: opts.failureType ?? 'soft',
      followUpCount: opts.followUpCount ?? 0,
      maxFollowUps: 2,
      paymentLinkId: opts.paymentLinkId,
      paymentLinkUrl: opts.paymentLinkUrl,
    },
  })

  return { failedPayment, job }
}

test('recovery: soft one_click with test keys creates Razorpay payment link and attaches to job & decision', async () => {
  const { job } = await seedJob({ amount: 1500, customerName: 'Rahul Verma', customerPhone: '+919876543210' })
  const daytime = fromISTComponents(2025, 5, 10, 11, 0, 0)

  let razorpayHttpPayload: any = null
  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    razorpayHttpPayload = JSON.parse(init?.body as string)
    return new Response(
      JSON.stringify({
        id: 'plink_rzp_live_test_12345',
        short_url: 'https://rzp.io/i/AbCdEfGh',
        status: 'created',
        amount: razorpayHttpPayload.amount,
        currency: 'INR',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const customPaymentService = new PaymentLinkService({
    enabled: true,
    keyId: 'rzp_test_sample_key',
    keySecret: 'sample_secret_key',
    fetchFn: mockFetch as any,
  })

  const result = await processRecoveryJob(
    {
      recoveryJobId: job.id,
      paymentLinkService: customPaymentService,
      agentOverride: {
        decision_type: 'one_click',
        failure_type: 'soft',
        explanation: 'Low balance soft failure — sending one-click payment link.',
        customer_message: 'Hi Rahul, your payment of ₹1,500 could not be processed. Tap below to complete it.',
        action_payload: { recovery_method: 'one_click' },
        confidence: 0.95,
        model_version: 'gemini-1.5-flash',
        should_escalate_hitl: false,
        taxonomy_match: 'insufficient_funds',
        tools_used: [],
      },
    },
    daytime,
  )

  assert.equal(result.outcome, 'completed')

  // Verify amount in paise at Razorpay boundary
  assert.equal(razorpayHttpPayload.amount, 150000)
  assert.equal(razorpayHttpPayload.currency, 'INR')
  assert.equal(razorpayHttpPayload.reference_id, job.id)
  assert.equal(razorpayHttpPayload.customer.name, 'Rahul Verma')
  assert.equal(razorpayHttpPayload.customer.contact, '+919876543210')

  // Verify database persisted fields on recovery_jobs
  const updatedJob = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updatedJob.paymentLinkId, 'plink_rzp_live_test_12345')
  assert.equal(updatedJob.paymentLinkUrl, 'https://rzp.io/i/AbCdEfGh')

  // Verify agent decision actionPayload contains payment link info
  const decision = await prisma.agentDecision.findFirstOrThrow({ where: { recoveryJobId: job.id } })
  const payload = decision.actionPayload as Record<string, unknown>
  assert.equal(payload.payment_link_id, 'plink_rzp_live_test_12345')
  assert.equal(payload.payment_link_url, 'https://rzp.io/i/AbCdEfGh')
})

test('recovery: idempotency reuses existing payment link without calling Razorpay API again', async () => {
  const { job } = await seedJob({
    amount: 2000,
    paymentLinkId: 'plink_existing_9999',
    paymentLinkUrl: 'https://rzp.io/i/ExistingUrl',
  })
  const daytime = fromISTComponents(2025, 5, 10, 11, 0, 0)

  let fetchCalled = false
  const mockFetch = async () => {
    fetchCalled = true
    return new Response(JSON.stringify({}), { status: 200 })
  }

  const customPaymentService = new PaymentLinkService({
    enabled: true,
    keyId: 'rzp_test_key',
    keySecret: 'secret_key',
    fetchFn: mockFetch as any,
  })

  await processRecoveryJob(
    {
      recoveryJobId: job.id,
      paymentLinkService: customPaymentService,
      agentOverride: {
        decision_type: 'one_click',
        failure_type: 'soft',
        explanation: 'Retry one_click',
        customer_message: 'Retry payment here',
        action_payload: {},
        confidence: 0.9,
        model_version: 'test',
        should_escalate_hitl: false,
        taxonomy_match: 'bank_error',
        tools_used: [],
      },
    },
    daytime,
  )

  assert.equal(fetchCalled, false) // No HTTP call made
  const updatedJob = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updatedJob.paymentLinkId, 'plink_existing_9999')
  assert.equal(updatedJob.paymentLinkUrl, 'https://rzp.io/i/ExistingUrl')
})

test('recovery: keys missing returns placeholder URL and worker does not crash', async () => {
  const { job } = await seedJob({ amount: 1200 })
  const daytime = fromISTComponents(2025, 5, 10, 11, 0, 0)

  const disabledPaymentService = new PaymentLinkService({
    enabled: false,
    keyId: undefined,
    keySecret: undefined,
  })

  const result = await processRecoveryJob(
    {
      recoveryJobId: job.id,
      paymentLinkService: disabledPaymentService,
      agentOverride: {
        decision_type: 'one_click',
        failure_type: 'soft',
        explanation: 'Payment link generated in test/disabled mode',
        customer_message: 'Pay at link',
        action_payload: {},
        confidence: 0.9,
        model_version: 'test',
        should_escalate_hitl: false,
        taxonomy_match: 'soft',
        tools_used: [],
      },
    },
    daytime,
  )

  assert.equal(result.outcome, 'completed')

  const updatedJob = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updatedJob.paymentLinkUrl, `https://example.test/pay/${job.id}`)
  assert.match(updatedJob.paymentLinkId ?? '', /^plink_mock_/)
})

test('recovery: hard / stop / HITL jobs never create a payment link', async () => {
  const { job } = await seedJob({ amount: 5000, failureType: 'hard', failureCode: 'card_blocked' })
  const daytime = fromISTComponents(2025, 5, 10, 11, 0, 0)

  let fetchCalled = false
  const mockFetch = async () => {
    fetchCalled = true
    return new Response(JSON.stringify({}), { status: 200 })
  }

  const customPaymentService = new PaymentLinkService({
    enabled: true,
    keyId: 'rzp_test_key',
    keySecret: 'secret_key',
    fetchFn: mockFetch as any,
  })

  const result = await processRecoveryJob(
    {
      recoveryJobId: job.id,
      paymentLinkService: customPaymentService,
    },
    daytime,
  )

  assert.equal(result.outcome, 'completed')
  assert.equal(result.decision?.action, 'stop_unrecovered')
  assert.equal(fetchCalled, false)

  const updatedJob = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updatedJob.paymentLinkId, null)
  assert.equal(updatedJob.paymentLinkUrl, null)
})
