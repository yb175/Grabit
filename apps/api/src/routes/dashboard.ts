// Grabit API — /dashboard routes.
//
// Powers the merchant-facing Command View dashboard (issue #32): recovered
// money, recovered cases, active pipeline jobs, stopped cases, pending HITL
// reviews and one-click recovered money. All money numbers aggregate from
// the recovery_ledger (the single source of truth for "recovered ₹") —
// nothing else. Counts come from recovery_jobs + hitl_queue.
//
// "Last 30 days" window: the Command View header promises this, so every
// number is filtered to the trailing 30-day window (jobs/ledger by their
// money event timestamp).
import { Hono } from 'hono'
import { prisma } from '@grabit/db'
import { subscribeDashboardUpdates } from '@grabit/queue'

const app = new Hono()

const WINDOW_DAYS = 30

const TERMINAL_STOPPED = ['unrecovered', 'rejected', 'stale'] as const
const ACTIVE = ['pending', 'processing', 'waiting'] as const

// GET /dashboard/summary — headline Command View KPIs
app.get('/summary', async (c) => {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const [recovered, oneClick, activeJobs, stoppedJobs, hitlPending] = await Promise.all([
    // Recovered money: every rupee in the ledger with status=recovered.
    prisma.recoveryLedger.aggregate({
      where: { status: 'recovered', recoveredAt: { gte: since } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.recoveryLedger.aggregate({
      where: {
        status: 'recovered',
        recoveryMethod: 'one_click',
        recoveredAt: { gte: since },
      },
      _sum: { amount: true },
    }),
    // Active: in-flight pipeline states (HITL has its own card).
    prisma.recoveryJob.count({
      where: { status: { in: [...ACTIVE] }, createdAt: { gte: since } },
    }),
    // Stopped: terminal non-recovered outcomes.
    prisma.recoveryJob.count({
      where: { status: { in: [...TERMINAL_STOPPED] }, createdAt: { gte: since } },
    }),
    // HITL: reviews awaiting a human, not merely jobs in hitl state.
    // No createdAt window — a pending review older than 30 days is still
    // outstanding work and must appear in the "requires action" backlog.
    prisma.hitlQueue.count({
      where: { status: 'pending' },
    }),
  ])

  return c.json({
    windowDays: WINDOW_DAYS,
    recoveredAmount: Number(recovered._sum.amount ?? 0),
    recoveredCases: recovered._count,
    activeJobs,
    stopped: stoppedJobs,
    hitlPending,
    oneClickRecoveredAmount: Number(oneClick._sum.amount ?? 0),
  })
})

export default app

// GET /dashboard/events — SSE stream for instant dashboard updates.
// The browser opens one long-lived connection; the worker publishes to
// Redis Pub/Sub after every recovery status change, and this endpoint
// forwards it as an SSE event so the frontend can refetch immediately
// instead of waiting for the next 3s poll.
app.get('/events', async (c) => {
  const { sub, channel } = subscribeDashboardUpdates()
  await sub.connect()
  await sub.subscribe(channel)

  const stream = new ReadableStream({
    start(controller) {
      // Send a heartbeat comment immediately so the browser knows the
      // connection is alive.
      controller.enqueue(': connected\n\n')

      const onMessage = (_ch: string, message: string) => {
        controller.enqueue(`data: ${message}\n\n`)
      }
      sub.on('message', onMessage)

      // Heartbeat every 15s to keep proxies from closing idle connections.
      const heartbeat = setInterval(() => {
        try { controller.enqueue(': heartbeat\n\n') } catch {}
      }, 15_000)

      // Cleanup when the client disconnects.
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(heartbeat)
        sub.unsubscribe(channel).catch(() => {})
        sub.quit().catch(() => {})
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})