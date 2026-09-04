// Grabit API — /hitl routes (Human-in-the-Loop).
//
// When the AI agent flags a case as high-value, unclear, or risky (e.g. angry
// customer, dispute, mandate cancellation), it creates a HITL task instead of
// auto-messaging. These endpoints let a human reviewer list open tasks,
// see the details / recommendation, and approve or reject the next action.

import { Hono } from 'hono'
import { prisma, type HitlStatus } from '@grabit/db'
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

  const [updatedTask] = await prisma.$transaction([
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

  // If decision had customer message (e.g. one_click) and phone exists, enqueue to message queue
  const latestDecision = task.recoveryJob.decisions[0]
  const actionPayload = latestDecision?.actionPayload as Record<string, unknown> | null
  const customerMessage =
    body.messageBody ||
    (typeof actionPayload?.customer_message === 'string' ? actionPayload.customer_message : '')

  const customerPhone = task.recoveryJob.failedPayment?.customerPhone

  let messageEnqueued = false
  if (customerPhone && customerMessage) {
    try {
      const messageQueue = getQueue('message')
      await messageQueue.add('send-recovery-message', {
        recoveryJobId: task.recoveryJobId,
        toPhone: customerPhone,
        messageBody: customerMessage,
      })
      messageEnqueued = true
    } catch (queueErr) {
      console.error('[hitl] message queue enqueue skipped/failed:', queueErr)
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

