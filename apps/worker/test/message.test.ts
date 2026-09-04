import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, Prisma } from '@grabit/db'
import { closeAllQueues } from '@grabit/queue'
import {
  MockMessageProvider,
  WhatsAppCloudProvider,
  processMessage,
  type MessageProvider,
} from '../src/workers/message.worker.js'

const paymentIds: string[] = []
const uniquePaymentId = () => {
  const id = `pay_message_test_${Date.now()}_${Math.random().toString(36).slice(2)}`
  paymentIds.push(id)
  return id
}

after(async () => {
  await prisma.failedPayment.deleteMany({ where: { razorpayPaymentId: { in: paymentIds } } })
  await closeAllQueues()
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

const messageData = (recoveryJobId: string, body = 'Pay here: https://example.test/pay/demo') => ({
  recoveryJobId,
  followUpCount: 0,
  toPhone: '+918810566953',
  messageBody: body,
  paymentLinkUrl: 'https://example.test/pay/demo',
  templateVars: { 1: 'Yug', 2: '1500', 3: 'Insufficient funds', 4: 'https://example.test/pay/demo' },
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
    templateVars: { 1: 'Yug', 2: '1500', 3: 'Insufficient funds', 4: 'https://example.test/pay/demo' },
    paymentLinkUrl: 'https://example.test/pay/demo',
  })

  assert.equal(result.providerMessageId, 'wamid.cloud.test')
  assert.equal(request?.url, 'https://graph.example/v21.0/phone-number-id/messages')
  const body = JSON.parse(request?.init?.body as string)
  assert.equal(body.to, '918810566953')
  assert.equal(body.template.name, 'payment_failed_recover')
  assert.equal(body.template.language.code, 'en_US')
  assert.deepEqual(body.template.components[0].parameters.map((p: any) => p.text), [
    'Yug', '1500', 'Insufficient funds', 'https://example.test/pay/demo',
  ])
})
