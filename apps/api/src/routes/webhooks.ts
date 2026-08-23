// Grabit API — /webhooks routes.
//
// The ONLY responsibility here: receive -> verify signature -> whitelist
// check -> enqueue to BullMQ -> 200. No DB access, no parsing beyond the
// event name. Heavy work (normalization, persistence) happens in the ingest
// worker so Razorpay gets a sub-50ms response and never retries on our
// processing latency.

import { Hono } from 'hono'
import { config } from '@grabit/config'
import { isAllowedEvent } from '@grabit/core'
import { getQueue } from '@grabit/queue'
import { verifyRazorpaySignature } from '../lib/razorpay.js'

const app = new Hono()

/// Job payload handed to the ingest worker. `payload` stays unknown — the
/// worker owns normalization; the API never interprets the event body.
export interface IngestJobData {
  event: string
  payload: unknown
  receivedAt: string
}

app.post('/razorpay', async (c) => {
  // Raw body is required — HMAC must be computed over the exact bytes sent.
  const rawBody = await c.req.text()

  const signature = c.req.header('x-razorpay-signature')
  if (!verifyRazorpaySignature(rawBody, signature, config.razorpayWebhookSecret)) {
    return c.json({ error: 'invalid_signature' }, 401)
  }

  let parsed: { event?: string }
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const event = parsed.event
  if (!event) {
    return c.json({ error: 'missing_event' }, 400)
  }

  // Unknown/unrelated events: ack with 200 so Razorpay doesn't retry junk.
  if (!isAllowedEvent(event)) {
    return c.json({ accepted: true, enqueued: false, reason: 'event_ignored' })
  }

  const data: IngestJobData = {
    event,
    // Only the payload subtree — the worker treats `payload` as the
    // RazorpayWebhookEvent['payload'] shape (payment/subscription entities).
    payload: (parsed as { payload?: unknown }).payload ?? {},
    receivedAt: new Date().toISOString(),
  }
  await getQueue('ingest').add('razorpay-event', data)

  return c.json({ accepted: true, enqueued: true })
})

export default app
