import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, Prisma } from '@grabit/db'
import { config } from '@grabit/config'
import { closeAllQueues, getQueue } from '@grabit/queue'
import { DEFAULT_STOPPING_RULES_CONFIG } from '@grabit/core'
import {
  GmailMessageProvider,
  MockMessageProvider,
  WhatsAppCloudProvider,
  processMessage,
  renderRecoveryCopy,
  type MessageProvider,
} from '../src/workers/message.worker.js'
import { stableUuid } from '../src/workers/recovery.worker.js'

const originalChannel = config.messageChannel
config.messageChannel = 'mock'
const paymentIds: string[] = []
const uniquePaymentId = () => {
  const id = `pay_message_test_${Date.now()}_${Math.random().toString(36).slice(2)}`
  paymentIds.push(id)
  return id
}

after(async () => {
  await prisma.failedPayment.deleteMany({ where: { razorpayPaymentId: { in: paymentIds } } })
  await closeAllQueues()
  config.messageChannel = originalChannel
  await prisma.$disconnect()
})

async function seedJob() {
  const payment = await prisma.failedPayment.create({
    data: {
      razorpayPaymentId: uniquePaymentId(),
      amount: new Prisma.Decimal(1500),
      currency: 'INR',
      failureReason: 'Insufficient funds',
      failureSource: 'payment',
      customerPhone: '+918810566953',
      customerName: 'Yug',
      rawPayload: {},
    },
  })
  const job = await prisma.recoveryJob.create({
    data: { failedPaymentId: payment.id, failureType: 'soft', status: 'processing' },
  })
  return job
}

async function seedJobFull(opts: { isPaid?: boolean } = {}) {
  const payment = await prisma.failedPayment.create({
    data: {
      razorpayPaymentId: uniquePaymentId(),
      amount: new Prisma.Decimal(1500),
      currency: 'INR',
      isPaid: opts.isPaid ?? false,
      failureReason: 'Insufficient funds',
      failureSource: 'payment',
      customerPhone: '+918810566953',
      customerName: 'Yug',
      rawPayload: {},
    },
  })
  const job = await prisma.recoveryJob.create({
    data: { failedPaymentId: payment.id, failureType: 'soft', status: 'processing' },
  })
  return { payment, job }
}

const messageData = (recoveryJobId: string, body = 'Pay here: https://example.test/pay/demo') => ({
  recoveryJobId,
  followUpCount: 0,
  toPhone: '+918810566953',
  messageBody: body,
  paymentLinkUrl: 'https://example.test/pay/demo',
  templateVars: { 1: 'Yug', 2: '₹1500', 3: 'order_test_123', 4: 'Insufficient funds', 5: 'try again using the payment link' },
})

test('message: mock provider persists one sent message and increments once', async () => {
  const job = await seedJob()
  let calls = 0
  const provider: MessageProvider = {
    async send() {
      calls++
      return { providerMessageId: `wamid.mock.test.${calls}` }
    },
  }

  const result = await processMessage(messageData(job.id), new Date('2026-01-01T10:00:00Z'), provider)
  assert.equal(result.outcome, 'sent')
  assert.equal(calls, 1)

  const message = await prisma.message.findUniqueOrThrow({ where: { id: result.messageId } })
  assert.equal(message.status, 'sent')
  assert.match(message.providerMessageId ?? '', /^wamid\.mock\.test\./)

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.followUpCount, 1)

  const replay = await processMessage(messageData(job.id), new Date(), provider)
  assert.equal(replay.outcome, 'duplicate')
  assert.equal(calls, 1)
})

test('message: successful send bumps count and schedules the delayed recovery tick', async () => {
  const { job } = await seedJobFull()
  const now = new Date('2026-01-01T10:00:00Z')
  const result = await processMessage(messageData(job.id), now, new MockMessageProvider('fu-bump'))
  assert.equal(result.outcome, 'sent')

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.followUpCount, 1)
  assert.equal(
    updated.nextAttemptAt?.getTime(),
    now.getTime() + DEFAULT_STOPPING_RULES_CONFIG.followUp1GapHours * 3600_000,
    'next_attempt_at must advance by the follow-up wait window',
  )

  const tickId = stableUuid(`recovery:${job.id}:fu1`)
  const tick = await getQueue('recovery').getJob(tickId)
  assert.ok(tick, 'successful send must enqueue the delayed recovery tick')
  assert.equal(tick.data.recoveryJobId, job.id)
  assert.equal(Number(tick.delay), DEFAULT_STOPPING_RULES_CONFIG.followUp1GapHours * 3600_000)
  await tick.remove()
})

test('message: replay of a sent job keeps the count and does not duplicate the tick', async () => {
  const { job } = await seedJobFull()
  await processMessage(messageData(job.id), new Date('2026-01-01T10:00:00Z'), new MockMessageProvider('fu-replay'))
  const tickId = stableUuid(`recovery:${job.id}:fu1`)

  const replay = await processMessage(messageData(job.id), new Date('2026-01-01T11:00:00Z'), new MockMessageProvider('fu-replay'))
  assert.equal(replay.outcome, 'duplicate')

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.followUpCount, 1, 'replay must not advance the count again')

  const tick = await getQueue('recovery').getJob(tickId)
  assert.ok(tick, 'replay must keep the follow-up tick')
  assert.equal(Number(tick.delay), DEFAULT_STOPPING_RULES_CONFIG.followUp1GapHours * 3600_000)
  await tick.remove()
})

test('message: failed send keeps count unchanged and schedules no follow-up tick', async () => {
  const { job } = await seedJobFull()
  const provider: MessageProvider = {
    async send() {
      throw new Error('provider down')
    },
  }
  await assert.rejects(processMessage(messageData(job.id), new Date(), provider), /provider down/)

  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.followUpCount, 0)
  assert.equal(await getQueue('recovery').getJob(stableUuid(`recovery:${job.id}:fu1`)), undefined)
  const message = await prisma.message.findFirstOrThrow({ where: { recoveryJobId: job.id } })
  assert.equal(message.status, 'failed')
})

test('message: already-paid payment sends but schedules no follow-up tick', async () => {
  const { job } = await seedJobFull({ isPaid: true })
  const result = await processMessage(messageData(job.id), new Date(), new MockMessageProvider('fu-paid'))
  assert.equal(result.outcome, 'sent')
  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.followUpCount, 1)
  assert.equal(await getQueue('recovery').getJob(stableUuid(`recovery:${job.id}:fu1`)), undefined)
})

test('message: unexpected URL fails closed without incrementing follow-up count', async () => {
  const job = await seedJob()
  await assert.rejects(
    processMessage(messageData(job.id, 'Pay here: https://evil.example/collect'), new Date(), new MockMessageProvider()),
    /unexpected URL/,
  )
  const updated = await prisma.recoveryJob.findUniqueOrThrow({ where: { id: job.id } })
  assert.equal(updated.followUpCount, 0)
  const message = await prisma.message.findFirstOrThrow({ where: { recoveryJobId: job.id } })
  assert.equal(message.status, 'failed')
})

test('message: email channel persists canonical rendered body and passes it to the provider', async () => {
  config.messageChannel = 'email'
  try {
    const job = await seedJob()
    let received: any
    const provider: MessageProvider = {
      async send(input) {
        received = input
        return { providerMessageId: 'wamid.canonical' }
      },
    }
    const result = await processMessage({
      ...messageData(job.id),
      toEmail: 'customer@example.com',
      paymentLinkUrl: 'https://rzp.io/i/real-link',
      templateVars: { 1: 'Yug', 2: '₹1500', 3: 'order_test_123', 4: 'Insufficient funds', 5: 'try again using the payment link' },
    }, new Date(), provider)
    assert.equal(result.outcome, 'sent')
    const message = await prisma.message.findUniqueOrThrow({ where: { id: result.messageId } })
    assert.equal(message.messageBody, renderRecoveryCopy({
      name: 'Yug', amount: '₹1500', orderLabel: 'order_test_123',
      why: 'Insufficient funds', action: 'try again using the payment link',
      link: 'https://rzp.io/i/real-link',
    }).text)
    assert.match(received.subject ?? '', /₹1500/)
    assert.match(received.htmlBody ?? '', /Pay now/)
  } finally {
    config.messageChannel = 'mock'
  }
})

test('message: persistence failure after provider acceptance never marks failed (no double send)', async () => {
  const job = await seedJob()
  let calls = 0
  const provider: MessageProvider = {
    async send() {
      calls++
      return { providerMessageId: `wamid.uncertain.${calls}` }
    },
  }
  const originalTransaction = prisma.$transaction.bind(prisma)
  prisma.$transaction = (() => Promise.reject(new Error('simulated transaction failure'))) as any
  try {
    const result = await processMessage(messageData(job.id), new Date(), provider)
    // Reconcile path completes the send state without re-sending.
    assert.equal(result.outcome, 'sent')
  } finally {
    prisma.$transaction = originalTransaction
  }
  assert.equal(calls, 1)
  const message = await prisma.message.findUniqueOrThrow({
    where: { id: stableUuid(`message:${job.id}:0`) },
  })
  assert.equal(message.status, 'sent')
  const replay = await processMessage(messageData(job.id), new Date(), provider)
  assert.equal(replay.outcome, 'duplicate')
  assert.equal(calls, 1, 'provider must not be called again after reconciliation')
})

test('message: Gmail provider sends shared recovery copy and payment link', async () => {
  let mail: any
  const provider = new GmailMessageProvider({
    user: 'grabit@example.com',
    pass: 'app-password',
    from: 'Grabit <grabit@example.com>',
    transport: { sendMail: async (message: any) => { mail = message; return { messageId: 'smtp-message-1' } } },
  })
  const result = await provider.send({
    toEmail: 'customer@example.com',
    messageBody: 'ignored by renderer',
    templateName: 'payment_failed_2',
    templateLang: 'en_US',
    templateVars: { 1: 'Yug', 2: '₹1500', 3: 'order_test_123', 4: 'Insufficient funds', 5: 'try again using the payment link' },
    paymentLinkUrl: 'https://example.test/pay/demo',
  })
  assert.equal(result.providerMessageId, 'smtp-message-1')
  assert.equal(mail.to, 'customer@example.com')
  assert.match(mail.subject, /₹1500/)
  assert.match(mail.text, /Insufficient funds/)
  assert.match(mail.text, /https:\/\/example\.test\/pay\/demo/)
  assert.match(mail.html, /Pay now/)
})

test('message: Cloud API sends approved template payload and stores provider id', async () => {
  let request: { url: string; init?: RequestInit } | undefined
  const provider = new WhatsAppCloudProvider({
    phoneNumberId: 'phone-number-id',
    accessToken: 'token-not-persisted',
    graphApiUrl: 'https://graph.example/v21.0',
    fetchFn: async (url, init) => {
      request = { url: url.toString(), init }
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.cloud.test' }] }), { status: 200 })
    },
  })

  const result = await provider.send({
    toPhone: '+918810566953',
    messageBody: 'Pay here: https://example.test/pay/demo',
    templateName: 'payment_failed_recover',
    templateLang: 'en_US',
    templateVars: { 1: 'Yug', 2: '₹1500', 3: 'order_test_123', 4: 'Insufficient funds', 5: 'try again using the payment link' },
    paymentLinkUrl: 'https://example.test/pay/demo',
  })

  assert.equal(result.providerMessageId, 'wamid.cloud.test')
  assert.equal(request?.url, 'https://graph.example/v21.0/phone-number-id/messages')
  const body = JSON.parse(request?.init?.body as string)
  assert.equal(body.to, '918810566953')
  assert.equal(body.template.name, 'payment_failed_recover')
  assert.equal(body.template.language.code, 'en_US')
  assert.deepEqual(body.template.components[0].parameters.map((p: any) => p.text), [
    'Yug', '₹1500', 'order_test_123', 'Insufficient funds', 'try again using the payment link',
  ])
})
