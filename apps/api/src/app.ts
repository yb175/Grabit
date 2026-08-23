// Grabit API — Hono application wiring.
//
// Registers all route groups. Eventually the full route surface is:
//  - /webhooks/* : Razorpay payment + subscription webhook ingestion (enqueues ingest jobs)
//  - /jobs/*     : manual/inspection endpoints for the recovery pipeline
//  - /hitl/*     : human-in-the-loop review queue (list, approve, override)
//  - /dashboard/*: recovery metrics & stats for the merchant dashboard
//  - /ledger/*   : recovered-money ledger entries
//  - /audit/*    : audit trail of every automated decision
// plus GET /health (below) used by docker-compose, k8s and humans.
import { Hono } from 'hono'
import { prisma } from '@grabit/db'
import webhooks from './routes/webhooks.js'
import jobs from './routes/jobs.js'
import hitl from './routes/hitl.js'
import dashboard from './routes/dashboard.js'
import ledger from './routes/ledger.js'
import audit from './routes/audit.js'

export const app = new Hono()

// Health check: proves both the API and the Postgres connection are alive.
app.get('/health', async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    return c.json({ status: 'ok', service: 'grabit-api', database: 'connected' })
  } catch (err) {
    return c.json(
      { status: 'degraded', service: 'grabit-api', database: 'disconnected' },
      503,
    )
  }
})

app.route('/webhooks', webhooks)
app.route('/jobs', jobs)
app.route('/hitl', hitl)
app.route('/dashboard', dashboard)
app.route('/ledger', ledger)
app.route('/audit', audit)
