// Grabit API — /hitl routes (Human-in-the-Loop).
//
// When the AI agent flags a case as high-value, unclear, or risky (e.g. angry
// customer, dispute, mandate cancellation), it creates a HITL task instead of
// auto-messaging. These endpoints let a human reviewer list open tasks,
// see the details / recommendation, and approve or reject the next action.

import { Hono } from 'hono'
import { prisma, type HitlStatus } from '@grabit/db'
import { config } from '@grabit/config'
import { getQueue } from '@grabit/queue'

const app = new Hono()

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VALID_STATUSES: readonly HitlStatus[] = ['pending', 'approved', 'rejected']

// v0 Auth: require x-api-key on all HITL routes (fail closed if unconfigured or mismatch).
app.use('*', async (c, next) => {
  const apiKey = c.req.header('x-api-key')
  if (!apiKey) {
    return c.json({ error: 'unauthorized', message: 'Missing x-api-key header' }, 401)
  }

  const expectedApiKey = process.env.GRABIT_API_KEY || process.env.API_KEY
  if (!expectedApiKey || apiKey !== expectedApiKey) {
    return c.json({ error: 'unauthorized', message: 'Invalid or unconfigured API key' }, 401)
  }

  await next()
})

// GET /hitl — list pending human-review tasks (optional ?status=pending|approved|rejected filter)
app.get('/', async (c) => {
  const statusParam = c.req.query('status')
  if (statusParam && !VALID_STATUSES.includes(statusParam as HitlStatus)) {
    return c.json(
      { error: 'invalid_status', message: 'status must be pending, approved, or rejected' },
      400,
    )
  }

  const status: HitlStatus = (statusParam as HitlStatus | undefined) ?? 'pending'

  const tasks = await prisma.hitlQueue.findMany({
    where: { status },
    include: {
      recoveryJob: {
        include: {
          failedPayment: true,
          decisions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return c.json({ tasks })
})

// GET /hitl/:id — get specific HITL task by task ID or recovery job ID
app.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_REGEX.test(id)) {
    return c.json({ error: 'not_found', message: 'HITL task not found' }, 404)
  }

  const task = await prisma.hitlQueue.findFirst({
    where: {
      OR: [{ id }, { recoveryJobId: id }],
    },
    include: {
      recoveryJob: {
        include: {
          failedPayment: true,
          decisions: {
            orderBy: { createdAt: 'desc' },
          },
          messages: {
            orderBy: { createdAt: 'desc' },
          },
        },
      },
    },
  })

  if (!task) {
    return c.json({ error: 'not_found', message: 'HITL task not found' }, 404)
  }

  return c.json({ task })
})

// POST /hitl/:id/approve — approve recovery outreach / action
app.post('/:id/approve', async (c) => {
  const id = c.req.param('id')
  if (!UUID_REGEX.test(id)) {
    return c.json({ error: 'not_found', message: 'HITL task not found' }, 404)
  }

  const task = await prisma.hitlQueue.findFirst({
    where: {
      OR: [{ id }, { recoveryJobId: id }],
    },
    include: {
      recoveryJob: {
        include: {
          failedPayment: true,
          decisions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  })

  if (!task) {
    return c.json({ error: 'not_found', message: 'HITL task not found' }, 404)
  }

  // Idempotent approve: if already approved, return current state
  if (task.status === 'approved') {
    return c.json({
      success: true,
      status: 'approved',
      task,
      alreadyProcessed: true,
    })
  }

  // Reject conflicting transition if task was already rejected
  if (task.status === 'rejected') {
    return c.json(
      {
        error: 'conflict',
        message: 'Task has already been rejected and cannot be approved',
        task,
      },
      409,
    )
  }

  const reviewer =
    c.req.header('x-reviewer') ||
    c.req.header('x-reviewed-by') ||
    c.req.header('x-user') ||
    'demo-reviewer'

  let body: { notes?: string; reviewedBy?: string; messageBody?: string } = {}
  try {
    body = await c.req.json()
  } catch {}

  const finalReviewer = body.reviewedBy || reviewer
  const finalNotes = body.notes || task.notes
  const now = new Date()

  // If decision had customer message (e.g. one_click) and a channel recipient
  // exists, enqueue to the message queue BEFORE committing approval. If dispatch
  // fails (BullMQ/Redis down), the approval is NOT committed and the task stays
  // pending — the reviewer can retry. Committing first would permanently lose
  // approved-but-undelivered outreach, because a later attempt short-circuits
  // via alreadyProcessed. The deterministic jobId keeps retries duplicate-safe.
  const latestDecision = task.recoveryJob.decisions[0]
  const actionPayload = latestDecision?.actionPayload as Record<string, unknown> | null
  const customerMessage =
    body.messageBody ||
    (typeof actionPayload?.customer_message === 'string' ? actionPayload.customer_message : '')

  const payment = task.recoveryJob.failedPayment
  // Channel-aware recipient: email channel needs customer_email, WhatsApp needs phone.
  const recipient = config.messageChannel === 'email' ? payment?.customerEmail : payment?.customerPhone

  let messageEnqueued = false
  let enqueuedMessageJob: { remove(): Promise<void> } | null = null
  if (recipient && customerMessage) {
    try {
      const messageQueue = getQueue('message')
      enqueuedMessageJob = await messageQueue.add(
        'send-recovery-message',
        {
          recoveryJobId: task.recoveryJobId,
          followUpCount: task.recoveryJob.followUpCount,
          toPhone: payment?.customerPhone ?? undefined,
          toEmail: payment?.customerEmail ?? undefined,
          messageBody: customerMessage,
          paymentLinkId: typeof actionPayload?.payment_link_id === 'string' ? actionPayload.payment_link_id : undefined,
          paymentLinkUrl: typeof actionPayload?.payment_link_url === 'string' ? actionPayload.payment_link_url : undefined,
          templateVars: {
            1: payment?.customerName ?? 'there',
            2: `₹${payment?.amount?.toString() ?? ''}`,
            3: payment?.razorpayOrderId ?? 'your order',
            4: payment?.failureReason ?? 'the payment could not be processed',
            5: 'try again using the payment link',
          },
        },
        // Deterministic jobId: a retried approval re-enqueues the same job instead
        // of sending the customer the same message twice.
        { jobId: `hitl-approve-${task.recoveryJobId}` },
      )
      messageEnqueued = true
    } catch (queueErr) {
      console.error('[hitl] message dispatch failed; approval NOT committed:', queueErr)
      return c.json(
        {
          error: 'dispatch_failed',
          message: 'Message dispatch failed; approval not committed. Retry the request.',
        },
        502,
      )
    }
  }

  let updatedTask
  try {
    ;[updatedTask] = await prisma.$transaction([
    prisma.hitlQueue.update({
      where: { id: task.id },
      data: {
        status: 'approved',
        reviewedBy: finalReviewer,
        reviewedAt: now,
        notes: finalNotes,
      },
      include: {
        recoveryJob: {
          include: {
            failedPayment: true,
            decisions: {
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    }),
    prisma.recoveryJob.update({
      where: { id: task.recoveryJobId },
      data: {
        status: 'processing',
        assignedTo: finalReviewer,
      },
    }),
    prisma.auditLog.create({
      data: {
        entityType: 'hitl_queue',
        entityId: task.id,
        action: 'hitl_approved',
        oldValue: { status: task.status, reviewedBy: task.reviewedBy },
        newValue: {
          status: 'approved',
          reviewedBy: finalReviewer,
          reviewedAt: now.toISOString(),
          notes: finalNotes,
        },
        performedBy: finalReviewer,
      },
    }),
    prisma.auditLog.create({
      data: {
        entityType: 'recovery_jobs',
        entityId: task.recoveryJobId,
        action: 'hitl_approved',
        oldValue: { status: task.recoveryJob.status },
        newValue: { status: 'processing', reviewedBy: finalReviewer },
        performedBy: finalReviewer,
      },
    }),
  ])
  } catch (transactionError) {
    // The queue already accepted the message job — remove it so a still-pending
    // task never sends outreach. A retried approval re-enqueues the same
    // deterministic jobId. If removal fails, the review stays pending and the
    // worker-side message idempotency still prevents duplicate sends.
    if (enqueuedMessageJob) {
      await enqueuedMessageJob.remove().catch((removeErr) =>
        console.error('[hitl] failed to remove queued message after approval rollback:', removeErr),
      )
    }
    throw transactionError
  }

  // Resume the pipeline: when there was no drafted customer message to
  // enqueue, the approved job would otherwise sit in `processing` limbo with
  // nothing scheduled. Re-evaluate it now — the stopping rules skip HITL
  // gates for approved tasks (see stopping-rules hitl_cleared) and the AI
  // decides the next real action (draft + send, delay, stop…), which also
  // advances the job out of `processing`.
  if (!messageEnqueued) {
    try {
      await getQueue('recovery').add(
        'evaluate-recovery',
        { recoveryJobId: task.recoveryJobId },
        { jobId: `hitl-approved-${task.recoveryJobId}`, removeOnComplete: true, removeOnFail: 100 },
      )
    } catch (queueErr) {
      // Redis/BullMQ unavailable after the DB commit. The approval is durable
      // but the resume is not. Return a 502 so the caller knows to retry the
      // approve endpoint (idempotent: alreadyProcessed path) which will
      // re-enqueue the resume without flipping the status again.
      console.error('[hitl] failed to enqueue resume after approval; caller should retry:', queueErr)
      return c.json(
        {
          error: 'resume_enqueue_failed',
          message: 'Approval committed but the pipeline resume could not be queued — retry POST /hitl/:id/approve to re-enqueue.',
          status: 'approved',
          task: updatedTask,
          messageEnqueued: false,
        },
        502,
      )
    }
  }

  return c.json({
    success: true,
    status: 'approved',
    task: updatedTask,
    messageEnqueued,
  })
})

// POST /hitl/:id/reject — reject recovery case and stop further outreach
app.post('/:id/reject', async (c) => {
  const id = c.req.param('id')
  if (!UUID_REGEX.test(id)) {
    return c.json({ error: 'not_found', message: 'HITL task not found' }, 404)
  }

  const task = await prisma.hitlQueue.findFirst({
    where: {
      OR: [{ id }, { recoveryJobId: id }],
    },
    include: {
      recoveryJob: {
        include: {
          failedPayment: true,
        },
      },
    },
  })

  if (!task) {
    return c.json({ error: 'not_found', message: 'HITL task not found' }, 404)
  }

  // Idempotent reject: if already rejected, return current state
  if (task.status === 'rejected') {
    return c.json({
      success: true,
      status: 'rejected',
      task,
      alreadyProcessed: true,
    })
  }

  // Reject conflicting transition if task was already approved
  if (task.status === 'approved') {
    return c.json(
      {
        error: 'conflict',
        message: 'Task has already been approved and cannot be rejected',
        task,
      },
      409,
    )
  }

  const reviewer =
    c.req.header('x-reviewer') ||
    c.req.header('x-reviewed-by') ||
    c.req.header('x-user') ||
    'demo-reviewer'

  let body: { notes?: string; reviewedBy?: string } = {}
  try {
    body = await c.req.json()
  } catch {}

  const finalReviewer = body.reviewedBy || reviewer
  const finalNotes = body.notes || task.notes
  const now = new Date()

  const [updatedTask] = await prisma.$transaction([
    prisma.hitlQueue.update({
      where: { id: task.id },
      data: {
        status: 'rejected',
        reviewedBy: finalReviewer,
        reviewedAt: now,
        notes: finalNotes,
      },
      include: {
        recoveryJob: {
          include: {
            failedPayment: true,
          },
        },
      },
    }),
    prisma.recoveryJob.update({
      where: { id: task.recoveryJobId },
      data: {
        status: 'rejected',
        assignedTo: finalReviewer,
      },
    }),
    prisma.auditLog.create({
      data: {
        entityType: 'hitl_queue',
        entityId: task.id,
        action: 'hitl_rejected',
        oldValue: { status: task.status, reviewedBy: task.reviewedBy },
        newValue: {
          status: 'rejected',
          reviewedBy: finalReviewer,
          reviewedAt: now.toISOString(),
          notes: finalNotes,
        },
        performedBy: finalReviewer,
      },
    }),
    prisma.auditLog.create({
      data: {
        entityType: 'recovery_jobs',
        entityId: task.recoveryJobId,
        action: 'stop_rejected',
        oldValue: { status: task.recoveryJob.status },
        newValue: {
          status: 'rejected',
          reason: finalNotes || 'Rejected by HITL reviewer',
        },
        performedBy: finalReviewer,
      },
    }),
  ])

  return c.json({
    success: true,
    status: 'rejected',
    task: updatedTask,
  })
})

export default app

