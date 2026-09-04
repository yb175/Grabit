// message.worker — sends one-click recovery messages through WhatsApp.

import { Worker } from 'bullmq'
import { prisma } from '@grabit/db'
import { config } from '@grabit/config'
import { DEFAULT_STOPPING_RULES_CONFIG } from '@grabit/core'
import { QUEUES, getQueue } from '@grabit/queue'
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
  subject?: string
  htmlBody?: string
  templateName: string
  templateLang: string
  templateVars: Record<string, string>
  paymentLinkUrl?: string
}

export interface MessageProvider {
  send(input: MessageProviderInput): Promise<{ providerMessageId: string }>
}

const URL_RE = /https?:\/\/[^\s)\">']+/gi

function urls(value: string): string[] {
  return value.match(URL_RE) ?? []
}

function assertSafeContent(data: MessageJobData, canonicalBody: string, htmlBody?: string): void {
  const allowed = data.paymentLinkUrl
  // HTML-escaped anchors contain &amp; — normalize before comparing.
  const unescape = (value: string) => value.replace(/&amp;/g, '&')
  const found = [canonicalBody, htmlBody ?? '', ...Object.values(data.templateVars ?? {}).map(String)]
    .flatMap(urls)
    .map(unescape)
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
        // Cleartext credentials are never acceptable: when not using implicit
        // TLS (port 465), force STARTTLS before authentication.
        requireTLS: !(options.secure ?? config.smtpSecure),
        auth: { user, pass },
      })
    }
  }

  async send(input: MessageProviderInput): Promise<{ providerMessageId: string }> {
    if (!input.toEmail) throw new Error('customer email is missing')
    const rendered = input.subject && input.htmlBody
      ? { subject: input.subject, text: input.messageBody, html: input.htmlBody }
      : renderRecoveryCopy({
      name: input.templateVars['1'] ?? 'there',
      amount: input.templateVars['2'] ?? '',
      orderLabel: input.templateVars['3'] ?? 'your order',
      why: input.templateVars['4'] ?? 'the payment could not be processed',
      action: input.templateVars['5'] ?? 'try again using the payment link',
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

/**
 * After a successful send, schedule the next recovery tick (the wait window).
 * The recovery worker re-evaluates the job on tick instead of blindly sending:
 *   paid            -> stop_recovered + ledger   (no AI, no send)
 *   unpaid, count<max -> stopping rules -> next follow-up send
 *   unpaid, count==max -> stop_unrecovered + ledger (no third send)
 *   >24h silence    -> stale
 * Deterministic jobId (per #11 style) makes repeated adds a no-op, so a
 * retry/replay never double-schedules and never double-sends.
 */
function scheduleFollowUpTick(recoveryJobId: string, followUpCount: number, delayMs: number) {
  return getQueue('recovery').add(
    'evaluate-recovery',
    { recoveryJobId },
    { delay: delayMs, jobId: stableUuid(`recovery:${recoveryJobId}:fu${followUpCount}`) },
  )
}

export async function processMessage(
  data: MessageJobData,
  now = new Date(),
  provider?: MessageProvider,
) {
  const job = await prisma.recoveryJob.findUnique({
    where: { id: data.recoveryJobId },
    include: { failedPayment: true },
  })
  if (!job) return { outcome: 'not_found' as const, recoveryJobId: data.recoveryJobId }

  const attempt = data.followUpCount ?? job.followUpCount
  const messageId = stableUuid(`message:${job.id}:${attempt}`)
  const existing = await prisma.message.findUnique({ where: { id: messageId } })
  if (existing?.status === 'sent' || existing?.status === 'delivered' || existing?.status === 'read') {
    const countWasBumped = existing.status === 'sent' && job.followUpCount === attempt
    // The provider already accepted this message. Repair any partially
    // reconciled state (e.g. follow-up bump lost in a previous crash) before
    // returning, so the pipeline never stalls or re-sends.
    if (countWasBumped) {
      const gapHours = (attempt + 1) === 1
        ? DEFAULT_STOPPING_RULES_CONFIG.followUp1GapHours
        : DEFAULT_STOPPING_RULES_CONFIG.followUp2GapHours
      try {
        await prisma.recoveryJob.updateMany({
          where: { id: job.id, followUpCount: attempt },
          data: {
            followUpCount: attempt + 1,
            nextAttemptAt: new Date(now.getTime() + gapHours * 60 * 60 * 1000),
          },
        })
        await prisma.auditLog.upsert({
          where: { id: stableUuid(`audit:message_sent:${existing.id}`) },
          create: {
            id: stableUuid(`audit:message_sent:${existing.id}`),
            entityType: 'messages',
            entityId: existing.id,
            action: 'message_sent',
            oldValue: { status: 'queued' },
            newValue: { status: 'sent', providerMessageId: existing.providerMessageId },
            performedBy: 'message_worker',
          },
          update: {},
        })
      } catch (reconcileError) {
        // Reconcile failure must not be swallowed: BullMQ retries the job and
        // this duplicate path retries the reconcile until it lands.
        throw reconcileError
      }
    }
    // Self-heal the lost-enqueue window: send committed + count bumped, but
    // the delayed recovery tick was never added (crash between). Replay
    // restores it idempotently via the stable jobId.
    const tickCount = countWasBumped ? attempt + 1 : job.followUpCount
    if (!job.failedPayment.isPaid && tickCount > attempt) {
      const gapHours = tickCount === 1
        ? DEFAULT_STOPPING_RULES_CONFIG.followUp1GapHours
        : DEFAULT_STOPPING_RULES_CONFIG.followUp2GapHours
      await scheduleFollowUpTick(job.id, tickCount, gapHours * 60 * 60 * 1000)
    }
    return { outcome: 'duplicate' as const, recoveryJobId: job.id, messageId }
  }

  const channel = config.messageChannel as MessageChannel
  if (!['mock', 'email', 'whatsapp'].includes(channel)) throw new Error(`Unsupported MESSAGE_CHANNEL: ${config.messageChannel}`)
  if (channel === 'email' && !data.toEmail) throw new Error('customer email is missing')
  if (channel === 'whatsapp' && !data.toPhone) throw new Error('customer phone is missing')
  if (channel === 'email' && (!data.paymentLinkUrl || data.paymentLinkUrl.includes('example.test'))) {
    throw new Error('email requires a real payment link')
  }

  // Render the canonical copy once and persist exactly what the customer receives.
  const rendered = channel === 'email'
    ? renderRecoveryCopy({
        name: String(data.templateVars?.[1] ?? 'there'),
        amount: String(data.templateVars?.[2] ?? ''),
        orderLabel: String(data.templateVars?.[3] ?? 'your order'),
        why: String(data.templateVars?.[4] ?? 'the payment could not be processed'),
        action: String(data.templateVars?.[5] ?? 'try again using the payment link'),
        link: data.paymentLinkUrl,
      })
    : undefined
  const canonicalBody = rendered?.text ?? data.messageBody

  const message = existing ?? await prisma.message.create({
    data: {
      id: messageId,
      recoveryJobId: job.id,
      channel,
      toPhone: data.toPhone,
      toEmail: data.toEmail,
      messageBody: canonicalBody,
      templateName: channel === 'whatsapp' ? config.waTemplateName : null,
      status: 'queued',
    },
  })
  // If a previous attempt stored a non-canonical body, keep the record accurate.
  if (existing && existing.messageBody !== canonicalBody) {
    await prisma.message.update({ where: { id: message.id }, data: { messageBody: canonicalBody } })
  }

  try {
    assertSafeContent(data, canonicalBody, rendered?.html)
  } catch (error) {
    await prisma.message.update({
      where: { id: message.id },
      data: { status: 'failed', errorMessage: error instanceof Error ? error.message : 'validation failed' },
    })
    throw error
  }

  // Provider construction (e.g. missing SMTP credentials) fails before any
  // submission — safe to mark failed and let BullMQ retry with bookkeeping.
  let providerInstance: MessageProvider
  let result: { providerMessageId: string }
  try {
    providerInstance = provider ?? providerFor(message.id)
    result = await providerInstance.send({
      toPhone: data.toPhone,
      toEmail: data.toEmail,
      messageBody: canonicalBody,
      subject: rendered?.subject,
      htmlBody: rendered?.html,
      templateName: config.waTemplateName,
      templateLang: config.waTemplateLang,
      templateVars: templateVars(data),
      paymentLinkUrl: data.paymentLinkUrl,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'message provider failed'
    await prisma.message.update({ where: { id: message.id }, data: { status: 'failed', errorMessage } })
    throw error
  }

  // The provider has ACCEPTED the message. From here on the message must never
  // be marked failed: a retry would see a non-sent row and re-send the same
  // message to the customer. Persist with idempotent reconcile writes instead.
  const auditId = stableUuid(`audit:message_sent:${message.id}`)
  const nextFollowUpCount = attempt + 1
  const gapHours = nextFollowUpCount === 1
    ? DEFAULT_STOPPING_RULES_CONFIG.followUp1GapHours
    : DEFAULT_STOPPING_RULES_CONFIG.followUp2GapHours

  const markSent = () => prisma.message.update({
    where: { id: message.id },
    data: { status: 'sent', providerMessageId: result.providerMessageId, sentAt: now, errorMessage: null },
  })
  const bumpJob = () => prisma.recoveryJob.updateMany({
    where: { id: job.id, followUpCount: attempt },
    data: {
      followUpCount: nextFollowUpCount,
      nextAttemptAt: new Date(now.getTime() + gapHours * 60 * 60 * 1000),
    },
  })
  const writeAudit = () => prisma.auditLog.upsert({
    where: { id: auditId },
    create: {
      id: auditId,
      entityType: 'messages',
      entityId: message.id,
      action: 'message_sent',
      oldValue: { status: 'queued' },
      newValue: { status: 'sent', providerMessageId: result.providerMessageId },
      performedBy: 'message_worker',
    },
    update: {},
  })

  try {
    await prisma.$transaction([markSent(), bumpJob(), writeAudit()])
  } catch (transactionError) {
    // Best-effort idempotent reconcile. A later replay of this job hits the
    // `sent` duplicate check and never re-sends.
    try {
      await markSent()
      await bumpJob()
      await writeAudit()
    } catch (reconcileError) {
      throw transactionError
    }
    console.warn(`[message] transaction failed but send was reconciled for ${message.id}:`,
      transactionError instanceof Error ? transactionError.message : transactionError)
  }

  // Follow-up wait window (see scheduleFollowUpTick). Skipped for already-paid
  // payments — the tick would only re-confirm recovery. Errors propagate so
  // BullMQ retries and the duplicate path restores the tick idempotently.
  if (!job.failedPayment.isPaid) {
    await scheduleFollowUpTick(job.id, nextFollowUpCount, gapHours * 60 * 60 * 1000)
  }

  return { outcome: 'sent' as const, recoveryJobId: job.id, messageId, providerMessageId: result.providerMessageId }
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
