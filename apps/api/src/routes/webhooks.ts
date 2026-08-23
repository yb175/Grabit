// Grabit API — /webhooks routes.
//
// Receives Razorpay webhooks (payment.failed, subscription.charged /
// subscription.halted, mandate revoked, etc.). Eventually each webhook is
// verified (signature), persisted, and an `ingest` job is enqueued to BullMQ
// so the recovery pipeline can pick it up asynchronously.
//
// Chunk 1: stub routes so the mount point exists.
import { Hono } from 'hono'

const app = new Hono()

// POST /webhooks/razorpay — main ingestion endpoint (stub)
app.post('/razorpay', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  // TODO: verify signature, persist PaymentFailure, enqueue ingest job
  return c.json({ received: true, events: 0 })
})

export default app
