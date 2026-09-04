// message.worker — sends one-click recovery messages through WhatsApp.

import { Worker } from 'bullmq'
import { prisma } from '@grabit/db'
import { config } from '@grabit/config'
import { DEFAULT_STOPPING_RULES_CONFIG } from '@grabit/core'
import { QUEUES } from '@grabit/queue'
import nodemailer from 'nodemailer'
import { stableUuid } from './recovery.worker.js'

export type MessageChannel = 'mock' | 'email' | 'whatsapp'

export interface RecoveryCopySlots {
  name: string
  amount: string
  orderLabel: string
  why: string
  action: string
  link?: string
}

export interface RenderedRecoveryCopy {
  text: string
  subject: string
  html: string
}

export function renderRecoveryCopy(slots: RecoveryCopySlots): RenderedRecoveryCopy {
  const text = `Hi ${slots.name},\nYour payment of ${slots.amount} for ${slots.orderLabel} could not be processed.\n\nWhy this happened: ${slots.why}\n\nWhat you can do: ${slots.action}\n\nUse Pay now to complete the same order.${slots.link ? `\n\nPay now: ${slots.link}` : ''}`
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
  const link = slots.link ? `<p><a href="${escapeHtml(slots.link)}">Pay now</a></p>` : ''
  return {
    text,
    subject: `Your payment of ${slots.amount} for ${slots.orderLabel} could not be processed`,
    html: `<p>Hi ${escapeHtml(slots.name)},</p><p>Your payment of ${escapeHtml(slots.amount)} for ${escapeHtml(slots.orderLabel)} could not be processed.</p><p><strong>Why this happened:</strong> ${escapeHtml(slots.why)}</p><p><strong>What you can do:</strong> ${escapeHtml(slots.action)}</p><p>Use Pay now to complete the same order.</p>${link}`,
  }
}

export interface MessageJobData {
  recoveryJobId: string
  followUpCount?: number
  toPhone?: string
  toEmail?: string
  messageBody: string
  paymentLinkId?: string
  paymentLinkUrl?: string
  templateVars?: Record<string, string | number>
}

export interface MessageProviderInput {
  toPhone?: string
  toEmail?: string
  messageBody: string
  templateName: string
  templateLang: string
  templateVars: Record<string, string>
  paymentLinkUrl?: string
}

export interface MessageProvider {
  send(input: MessageProviderInput): Promise<{ providerMessageId: string }>
}

const URL_RE = /https?:\/\/[^\s)]+/gi

function urls(value: string): string[] {
  return value.match(URL_RE) ?? []
}

function assertSafeContent(data: MessageJobData): void {
  const allowed = data.paymentLinkUrl
  const found = [data.messageBody, ...Object.values(data.templateVars ?? {}).map(String)].flatMap(urls)
  if (found.some((url) => url !== allowed)) {
    throw new Error('message contains an unexpected URL')
  }
}

function templateVars(data: MessageJobData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data.templateVars ?? {}).map(([key, value]) => [key, String(value)]),
  )
}

export class MockMessageProvider implements MessageProvider {
  constructor(private readonly messageId = 'mock') {}

  async send(_input: MessageProviderInput): Promise<{ providerMessageId: string }> {
    console.log(`[message:mock] sent recovery message (${this.messageId})`)
    return { providerMessageId: `wamid.mock.${this.messageId}` }
  }
}

export class WhatsAppCloudProvider implements MessageProvider {
  constructor(
    private readonly options: {
      phoneNumberId?: string
      accessToken?: string
      graphApiUrl?: string
      fetchFn?: typeof fetch
    } = {},
  ) {}

  async send(input: MessageProviderInput): Promise<{ providerMessageId: string }> {
    const phoneNumberId = this.options.phoneNumberId ?? config.waPhoneNumberId
    const accessToken = this.options.accessToken ?? config.waAccessToken
    if (!phoneNumberId || !accessToken) throw new Error('WhatsApp Cloud API is missing credentials')

    const vars = input.templateVars
    const components: Record<string, unknown>[] = []
    if (Object.keys(vars).length > 0) {
      components.push({
        type: 'body',
        parameters: Object.keys(vars).sort((a, b) => Number(a) - Number(b)).map((key) => ({
          type: 'text',
          text: vars[key],
        })),
      })
    }
    if (input.paymentLinkUrl) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: input.paymentLinkUrl }],
      })
    }

    if (!input.toPhone) throw new Error('customer phone is missing')
    const response = await (this.options.fetchFn ?? fetch)(
      `${(this.options.graphApiUrl ?? config.waGraphApiUrl).replace(/\/+$/, '')}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: input.toPhone.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: input.templateName,
            language: { code: input.templateLang },
            ...(components.length ? { components } : {}),
          },
        }),
      },
    )

    const body = await response.json().catch(() => ({})) as {
      messages?: Array<{ id?: string }>
      error?: { code?: number; message?: string }
    }
    if (!response.ok) {
      throw new Error(`WhatsApp API HTTP ${response.status}${body.error?.code ? ` (${body.error.code})` : ''}`)
    }
    const providerMessageId = body.messages?.[0]?.id
    if (!providerMessageId) throw new Error('WhatsApp API response missing message id')
    return { providerMessageId }
  }
}

export class GmailMessageProvider implements MessageProvider {
  private readonly transporter: any

  constructor(private readonly options: {
    host?: string
    port?: number
    secure?: boolean
    user?: string
    pass?: string
    from?: string
    transport?: any
  } = {}) {
    if (options.transport) this.transporter = options.transport
    else {
      const user = options.user ?? config.smtpUser
      const pass = options.pass ?? config.smtpPass
      if (!user || !pass) throw new Error('Gmail SMTP is missing credentials')
      this.transporter = nodemailer.createTransport({
        host: options.host ?? config.smtpHost,
        port: options.port ?? config.smtpPort,
        secure: options.secure ?? config.smtpSecure,
        auth: { user, pass },
      })
    }
  }

  async send(input: MessageProviderInput): Promise<{ providerMessageId: string }> {
    if (!input.toEmail) throw new Error('customer email is missing')
    const vars = input.templateVars
    const rendered = renderRecoveryCopy({
      name: vars['1'] ?? 'there',
      amount: vars['2'] ?? '',
      orderLabel: vars['3'] ?? 'your order',
      why: vars['4'] ?? 'the payment could not be processed',
      action: vars['5'] ?? 'try again using the payment link',
      link: input.paymentLinkUrl,
    })
    const result = await this.transporter.sendMail({
      from: this.options.from ?? config.mailFrom ?? this.options.user,
      to: input.toEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    })
    return { providerMessageId: String(result.messageId ?? result.response ?? `smtp:${input.toEmail}`) }
  }
}

function providerFor(messageId: string): MessageProvider {
  if (config.messageChannel === 'mock') return new MockMessageProvider(messageId)
  if (config.messageChannel === 'email') return new GmailMessageProvider()
  if (config.messageChannel === 'whatsapp') return new WhatsAppCloudProvider()
  throw new Error(`Unsupported MESSAGE_CHANNEL: ${config.messageChannel}`)
}

export async function processMessage(
  data: MessageJobData,
  now = new Date(),
  provider?: MessageProvider,
) {
  const job = await prisma.recoveryJob.findUnique({ where: { id: data.recoveryJobId } })
  if (!job) return { outcome: 'not_found' as const, recoveryJobId: data.recoveryJobId }

  const attempt = data.followUpCount ?? job.followUpCount
  const messageId = stableUuid(`message:${job.id}:${attempt}`)
  const existing = await prisma.message.findUnique({ where: { id: messageId } })
  if (existing?.status === 'sent' || existing?.status === 'delivered' || existing?.status === 'read') {
    return { outcome: 'duplicate' as const, recoveryJobId: job.id, messageId }
  }

  const channel = config.messageChannel as MessageChannel
  if (!['mock', 'email', 'whatsapp'].includes(channel)) throw new Error(`Unsupported MESSAGE_CHANNEL: ${config.messageChannel}`)
  if (channel === 'email' && !data.toEmail) throw new Error('customer email is missing')
  if (channel === 'whatsapp' && !data.toPhone) throw new Error('customer phone is missing')
  if (channel === 'email' && (!data.paymentLinkUrl || data.paymentLinkUrl.includes('example.test'))) {
    throw new Error('email requires a real payment link')
  }

  const message = existing ?? await prisma.message.create({
    data: {
      id: messageId,
      recoveryJobId: job.id,
      channel,
      toPhone: data.toPhone,
      toEmail: data.toEmail,
      messageBody: data.messageBody,
      templateName: channel === 'whatsapp' ? config.waTemplateName : null,
      status: 'queued',
    },
  })

  try {
    assertSafeContent(data)
    const result = await (provider ?? providerFor(message.id)).send({
      toPhone: data.toPhone,
      toEmail: data.toEmail,
      messageBody: data.messageBody,
      templateName: config.waTemplateName,
      templateLang: config.waTemplateLang,
      templateVars: templateVars(data),
      paymentLinkUrl: data.paymentLinkUrl,
    })
    const nextFollowUpCount = job.followUpCount + 1
    const gapHours = nextFollowUpCount === 1
      ? DEFAULT_STOPPING_RULES_CONFIG.followUp1GapHours
      : DEFAULT_STOPPING_RULES_CONFIG.followUp2GapHours

    await prisma.$transaction([
      prisma.message.update({
        where: { id: message.id },
        data: { status: 'sent', providerMessageId: result.providerMessageId, sentAt: now, errorMessage: null },
      }),
      prisma.recoveryJob.updateMany({
        where: { id: job.id, followUpCount: attempt },
        data: {
          followUpCount: nextFollowUpCount,
          nextAttemptAt: new Date(now.getTime() + gapHours * 60 * 60 * 1000),
        },
      }),
      prisma.auditLog.create({
        data: {
          entityType: 'messages',
          entityId: message.id,
          action: 'message_sent',
          oldValue: { status: 'queued' },
          newValue: { status: 'sent', providerMessageId: result.providerMessageId },
          performedBy: 'message_worker',
        },
      }),
    ])
    return { outcome: 'sent' as const, recoveryJobId: job.id, messageId, providerMessageId: result.providerMessageId }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'message provider failed'
    await prisma.message.update({ where: { id: message.id }, data: { status: 'failed', errorMessage } })
    throw error
  }
}

export function startMessageWorker(): Worker<MessageJobData> {
  const worker = new Worker<MessageJobData>(
    QUEUES.message,
    async (job) => processMessage(job.data),
    { connection: { url: config.redisUrl }, concurrency: 5 },
  )
  worker.on('failed', (job, error) => console.error(`[message] job ${job?.id} failed:`, error.message))
  console.log(`[message] worker listening on ${QUEUES.message}`)
  return worker
}
