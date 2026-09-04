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
    prisma.hitlQueue.count({
      where: { status: 'pending', createdAt: { gte: since } },
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