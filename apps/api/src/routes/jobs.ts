// Grabit API — /jobs routes.
//
// Inspection/control endpoints for the recovery pipeline: list jobs by state,
// retrieve single job details, and trace the full timeline of events
// (ingested -> rule decision -> AI decision -> hitl/message -> ledger).

import { Hono } from 'hono'
import { prisma, Prisma, type RecoveryJobStatus, type FailureType } from '@grabit/db'

// Supported enum values for GET /jobs query filters — validated before Prisma
// so unsupported values return 400 instead of an uncaught enum 500.
const VALID_STATUSES: readonly string[] = [
  'pending', 'processing', 'waiting', 'hitl', 'recovered', 'unrecovered', 'rejected', 'stale',
]
const VALID_FAILURE_TYPES: readonly string[] = [
  'hard', 'soft', 'autopay_failed', 'autopay_cancelled',
]

const app = new Hono()

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id)
}

function formatJob(job: any) {
  const payment = job.failedPayment
  return {
    id: job.id,
    failedPaymentId: job.failedPaymentId,
    status: job.status,
    failureType: job.failureType,
    failure_type: job.failureType,
    followUpCount: job.followUpCount,
    maxFollowUps: job.maxFollowUps,
    nextAttemptAt: job.nextAttemptAt,
    priority: job.priority,
    assignedTo: job.assignedTo,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    amount: payment ? Number(payment.amount) : 0,
    currency: payment?.currency ?? 'INR',
    customerPhone: payment?.customerPhone ?? null,
    customerEmail: payment?.customerEmail ?? null,
    customerName: payment?.customerName ?? null,
    paymentMethod: payment?.paymentMethod ?? null,
    failureCode: payment?.failureCode ?? null,
    failureReason: payment?.failureReason ?? null,
    failureSource: payment?.failureSource ?? null,
    razorpayPaymentId: payment?.razorpayPaymentId ?? null,
    failedPayment: payment ? { ...payment, rawPayload: undefined } : null,
    decisions: job.decisions ?? [],
    latestDecision: job.decisions?.[0] ?? null,
    messages: job.messages ?? [],
    hitlTasks: job.hitlTasks ?? [],
    latestHitlTask: job.hitlTasks?.[0] ?? null,
    ledger: job.ledger ?? [],
    latestLedger: job.ledger?.[0] ?? null,
  }
}

// GET /jobs — recent recovery pipeline jobs with optional filtering
app.get('/', async (c) => {
  const status = c.req.query('status')
  const failureType = c.req.query('failure_type') ?? c.req.query('failureType')
  const from = c.req.query('from')
  const to = c.req.query('to')

  const where: Prisma.RecoveryJobWhereInput = {}

  if (status && !VALID_STATUSES.includes(status)) {
    return c.json({ error: 'invalid_status', message: `status must be one of: ${VALID_STATUSES.join(', ')}` }, 400)
  }
  if (status) {
    where.status = status as RecoveryJobStatus
  }

  if (failureType && !VALID_FAILURE_TYPES.includes(failureType)) {
    return c.json({ error: 'invalid_failure_type', message: `failure_type must be one of: ${VALID_FAILURE_TYPES.join(', ')}` }, 400)
  }
  if (failureType) {
    where.failureType = failureType as FailureType
  }

  if (from && isNaN(new Date(from).getTime())) {
    return c.json({ error: 'invalid_from', message: 'from must be a valid ISO date' }, 400)
  }
  if (to && isNaN(new Date(to).getTime())) {
    return c.json({ error: 'invalid_to', message: 'to must be a valid ISO date' }, 400)
  }
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    }
  }

  const jobs = await prisma.recoveryJob.findMany({
    where,
    include: {
      failedPayment: true,
      decisions: {
        orderBy: { createdAt: 'desc' },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
      },
      hitlTasks: {
        orderBy: { createdAt: 'desc' },
      },
      ledger: {
        orderBy: { createdAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return c.json({ jobs: jobs.map(formatJob) })
})

// GET /jobs/:id/timeline — full chronological timeline of events for a recovery job
app.get('/:id/timeline', async (c) => {
  const id = c.req.param('id')

  if (!isValidUuid(id)) {
    return c.json({ error: 'not_found', message: `Job ${id} not found` }, 404)
  }

  const job = await prisma.recoveryJob.findUnique({
    where: { id },
    include: {
      failedPayment: true,
      decisions: {
        orderBy: { createdAt: 'asc' },
      },
      messages: {
        orderBy: { createdAt: 'asc' },
      },
      hitlTasks: {
        orderBy: { createdAt: 'asc' },
      },
      ledger: {
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  if (!job) {
    return c.json({ error: 'not_found', message: `Job ${id} not found` }, 404)
  }

  const auditLogs = await prisma.auditLog.findMany({
    where: {
      OR: [
        { entityId: id },
        { entityId: job.failedPaymentId },
      ],
    },
    orderBy: { createdAt: 'asc' },
  })

  interface TimelineEvent {
    id: string
    type: 'ingested' | 'rule_decision' | 'agent_decision' | 'hitl' | 'message' | 'ledger' | 'audit'
    title: string
    description?: string
    reason?: string | null
    performedBy?: string | null
    timestamp: string
    data?: Record<string, unknown>
  }

  const events: TimelineEvent[] = []

  // 1. Ingested event
  events.push({
    id: `ingested-${job.id}`,
    type: 'ingested',
    title: 'Payment failure ingested',
    description: `Payment ${job.failedPayment.razorpayPaymentId} failed (${job.failureType}) - ₹${job.failedPayment.amount}`,
    reason: job.failedPayment.failureReason ?? job.failedPayment.failureCode ?? null,
    performedBy: 'gateway',
    timestamp: (job.failedPayment.createdAt ?? job.createdAt).toISOString(),
    data: {
      razorpayPaymentId: job.failedPayment.razorpayPaymentId,
      amount: Number(job.failedPayment.amount),
      currency: job.failedPayment.currency,
      failureCode: job.failedPayment.failureCode,
      failureReason: job.failedPayment.failureReason,
      failureType: job.failureType,
      customerPhone: job.failedPayment.customerPhone,
      customerName: job.failedPayment.customerName,
      customerEmail: job.failedPayment.customerEmail,
      paymentMethod: job.failedPayment.paymentMethod,
    },
  })

  // 2. Audit logs / Rule Decisions
  for (const log of auditLogs) {
    const newVal = (log.newValue as Record<string, unknown>) ?? {}
    const oldVal = (log.oldValue as Record<string, unknown>) ?? {}
    const reason = (newVal.reason as string) ?? null

    if (log.action === 'stopping_rules_passed') {
      events.push({
        id: log.id,
        type: 'rule_decision',
        title: 'Stopping rules evaluated: passed',
        description: reason ?? 'All stopping and timing rules passed. Ready for AI processing.',
        reason: reason ?? 'All stopping and timing rules passed.',
        performedBy: log.performedBy ?? 'stopping_rules',
        timestamp: log.createdAt.toISOString(),
        data: { action: log.action, oldValue: oldVal, newValue: newVal },
      })
    } else if (log.action === 'scheduled_delay') {
      events.push({
        id: log.id,
        type: 'rule_decision',
        title: 'Stopping rule: recovery delayed (smart timing)',
        description: reason ?? `Delayed until ${newVal.nextAttemptAt}`,
        reason: reason ?? 'Smart timing window constraint',
        performedBy: log.performedBy ?? 'stopping_rules',
        timestamp: log.createdAt.toISOString(),
        data: { action: log.action, nextAttemptAt: newVal.nextAttemptAt, oldValue: oldVal, newValue: newVal },
      })
    } else if (
      log.action === 'stop_unrecovered' ||
      log.action === 'stop_recovered' ||
      log.action === 'stop_rejected' ||
      log.action === 'marked_stale'
    ) {
      events.push({
        id: log.id,
        type: 'rule_decision',
        title: `Stopping rule triggered: ${log.action}`,
        description: reason ?? `Job marked as ${log.action}`,
        reason: reason ?? `Stopping rule: ${log.action}`,
        performedBy: log.performedBy ?? 'stopping_rules',
        timestamp: log.createdAt.toISOString(),
        data: { action: log.action, oldValue: oldVal, newValue: newVal },
      })
    } else if (log.action === 'escalated_hitl') {
      events.push({
        id: log.id,
        type: 'hitl',
        title: 'Escalated to human reviewer (HITL)',
        description: reason ?? 'Escalated to human reviewer',
        reason: reason ?? 'HITL threshold triggered',
        performedBy: log.performedBy ?? 'stopping_rules',
        timestamp: log.createdAt.toISOString(),
        data: { action: log.action, oldValue: oldVal, newValue: newVal },
      })
    } else if (log.action === 'agent_decision') {
      if (job.decisions.length === 0) {
        events.push({
          id: log.id,
          type: 'agent_decision',
          title: 'AI Agent decision',
          description: (newVal.customer_message as string) ?? undefined,
          reason: (newVal.explanation as string) ?? reason,
          performedBy: log.performedBy ?? 'agent',
          timestamp: log.createdAt.toISOString(),
          data: { actionPayload: newVal },
        })
      }
    } else {
      events.push({
        id: log.id,
        type: 'audit',
        title: `Audit event: ${log.action}`,
        description: reason ?? undefined,
        reason: reason ?? null,
        performedBy: log.performedBy,
        timestamp: log.createdAt.toISOString(),
        data: { action: log.action, oldValue: oldVal, newValue: newVal },
      })
    }
  }

  // 3. Agent Decisions
  for (const d of job.decisions) {
    events.push({
      id: d.id,
      type: 'agent_decision',
      title: `AI Agent Decision: ${d.decisionType}`,
      description: d.explanation ?? undefined,
      reason: d.explanation ?? null,
      performedBy: d.modelVersion ? `agent (${d.modelVersion})` : 'agent',
      timestamp: d.createdAt.toISOString(),
      data: {
        decisionType: d.decisionType,
        explanation: d.explanation,
        confidence: d.confidence,
        modelVersion: d.modelVersion,
        actionPayload: d.actionPayload as Record<string, unknown>,
      },
    })
  }

  // 4. HITL Tasks
  for (const h of job.hitlTasks) {
    const exists = events.some((e) => e.type === 'hitl' && e.reason === h.reason)
    if (!exists) {
      events.push({
        id: h.id,
        type: 'hitl',
        title: `HITL Task: ${h.status}`,
        description: h.notes ?? h.reason,
        reason: h.reason,
        performedBy: h.reviewedBy ?? 'reviewer',
        timestamp: h.createdAt.toISOString(),
        data: {
          hitlTaskId: h.id,
          status: h.status,
          reason: h.reason,
          reviewedBy: h.reviewedBy,
          reviewedAt: h.reviewedAt,
          notes: h.notes,
        },
      })
    }
    if (h.reviewedAt) {
      events.push({
        id: `${h.id}-reviewed`,
        type: 'hitl',
        title: `HITL Task Reviewed: ${h.status}`,
        description: h.notes ?? `Reviewed by ${h.reviewedBy}`,
        reason: h.notes ?? h.reason,
        performedBy: h.reviewedBy,
        timestamp: h.reviewedAt.toISOString(),
        data: {
          hitlTaskId: h.id,
          status: h.status,
          reviewedBy: h.reviewedBy,
          notes: h.notes,
        },
      })
    }
  }

  // 5. Messages
  for (const m of job.messages) {
    events.push({
      id: m.id,
      type: 'message',
      title: `Message (${m.channel}): ${m.status}`,
      description: m.messageBody,
      reason: m.errorMessage ?? null,
      performedBy: 'messaging_worker',
      timestamp: (m.sentAt ?? m.createdAt).toISOString(),
      data: {
        messageId: m.id,
        channel: m.channel,
        toPhone: m.toPhone,
        status: m.status,
        templateName: m.templateName,
        providerMessageId: m.providerMessageId,
        errorMessage: m.errorMessage,
        messageBody: m.messageBody,
      },
    })
  }

  // 6. Recovery Ledger
  for (const l of job.ledger) {
    events.push({
      id: l.id,
      type: 'ledger',
      title: `Recovery Ledger: ${l.status} (₹${l.amount})`,
      description: l.recoveryMethod ? `Recovered via ${l.recoveryMethod}` : `Outcome: ${l.status}`,
      reason: null,
      performedBy: 'recovery_worker',
      timestamp: (l.recoveredAt ?? l.createdAt).toISOString(),
      data: {
        ledgerId: l.id,
        amount: Number(l.amount),
        status: l.status,
        recoveryMethod: l.recoveryMethod,
        recoveredAt: l.recoveredAt,
      },
    })
  }

  // Sort events chronologically (oldest first)
  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  return c.json({
    jobId: job.id,
    timeline: events,
    events,
    total: events.length,
  })
})

// GET /jobs/:id — single recovery job detail
app.get('/:id', async (c) => {
  const id = c.req.param('id')

  if (!isValidUuid(id)) {
    return c.json({ error: 'not_found', message: `Job ${id} not found` }, 404)
  }

  const job = await prisma.recoveryJob.findUnique({
    where: { id },
    include: {
      failedPayment: true,
      decisions: {
        orderBy: { createdAt: 'desc' },
      },
      messages: {
        orderBy: { createdAt: 'asc' },
      },
      hitlTasks: {
        orderBy: { createdAt: 'desc' },
      },
      ledger: {
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!job) {
    return c.json({ error: 'not_found', message: `Job ${id} not found` }, 404)
  }

  const formatted = formatJob(job)
  return c.json({ job: formatted, ...formatted })
})

export default app
