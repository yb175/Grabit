// ingest.worker — first stage of Grabit's recovery pipeline.
//
// Consumes raw Razorpay webhook events enqueued by the API, normalizes them
// (paise -> rupees, error fields, customer info), and persists:
//   1. failed_payments row (idempotent: unique razorpay_payment_id,
//      P2002 conflict => duplicate => ack without throwing)
//   2. recovery_jobs row (status=pending, failure_type from rule-based
//      classification — the AI agent may reclassify in the recovery phase)
//
// The core logic lives in processIngestEvent, a plain async function with no
// BullMQ dependency, so tests exercise it directly against Postgres.

import { Worker } from 'bullmq'
import { prisma, Prisma } from '@grabit/db'
import { config } from '@grabit/config'
import { classifyFailure, failureSource, type RazorpayWebhookEvent } from '@grabit/core'
import { QUEUES, getQueue } from '@grabit/queue'

/// Shape the API puts on the queue (see apps/api/src/routes/webhooks.ts).
export interface IngestJobData {
  event: string
  payload: unknown
  receivedAt: string
}

export interface IngestResult {
  outcome: 'created' | 'duplicate'
  failedPaymentId: string | null
  recoveryJobId: string | null
  failureType: string | null
}

/// Extract the id we dedupe on. Payment events carry pay_xxx; subscription
/// events fall back to the subscription's last payment id, else the
/// subscription id itself (prefixed so it can't collide with payment ids).
function extractPaymentId(payload: RazorpayWebhookEvent['payload']): string | null {
  if (payload.payment?.entity?.id) return payload.payment.entity.id
  const sub = payload.subscription?.entity
  if (sub?.payment_id) return sub.payment_id
  if (sub?.id) return `sub_${sub.id}`
  return null
}

export async function processIngestEvent(data: IngestJobData): Promise<IngestResult> {
  const { event } = data
  const payload = (data.payload as RazorpayWebhookEvent['payload']) ?? {}

  const payment = payload.payment?.entity
  const razorpayPaymentId = extractPaymentId(payload)
  if (!razorpayPaymentId) {
    // Unrecognizable payload — throw so BullMQ retries, then dead-letters.
    throw new Error(`ingest: no payment/subscription entity in ${event} event`)
  }

  // Normalize: Razorpay amounts are paise, Grabit stores rupees.
  // Decimal division avoids float drift on the money column.
  const amount = payment
    ? new Prisma.Decimal(payment.amount).div(100)
    : new Prisma.Decimal(0)

  const failureCode = payment?.error_code ?? null
  const failureType = classifyFailure(event, failureCode)

  // --- 1. failed_payments (idempotent via unique constraint) ---
  let failedPayment
  try {
    failedPayment = await prisma.failedPayment.create({
      data: {
        razorpayPaymentId,
        razorpayOrderId: payment?.order_id ?? null,
        amount,
        currency: payment?.currency ?? 'INR',
        failureCode,
        failureReason: payment?.error_description ?? null,
        failureSource: failureSource(event),
        paymentMethod: payment?.method ?? null,
        customerPhone: payment?.contact ?? null,
        customerEmail: payment?.email ?? null,
        customerName: payment?.notes?.customer_name ?? null,
        // Verbatim payload — source of truth for replay & audit.
        rawPayload: (data.payload ?? {}) as object,
      },
    })
  } catch (err) {
    // P2002 = unique violation on razorpay_payment_id => webhook retry.
    // Ack as duplicate: never re-throw, a retry would hit the same wall.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      console.log(`[ingest] duplicate ${event} for ${razorpayPaymentId} — skipping`)
      return { outcome: 'duplicate', failedPaymentId: null, recoveryJobId: null, failureType: null }
    }
    throw err // transient (connection, etc.) -> let BullMQ retry
  }

  // --- 2. recovery_jobs (one per failure) ---
  const recoveryJob = await prisma.recoveryJob.create({
    data: {
      failedPaymentId: failedPayment.id,
      status: 'pending',
      failureType,
      maxFollowUps: 2,
    },
  })

  console.log(
    `[ingest] ${event} ${razorpayPaymentId} -> payment ${failedPayment.id}, ` +
    `job ${recoveryJob.id} (${failureType})`,
  )

  return {
    outcome: 'created',
    failedPaymentId: failedPayment.id,
    recoveryJobId: recoveryJob.id,
    failureType,
  }
}

/// BullMQ wiring. Non-P2002 errors propagate => 3 attempts with exp backoff,
/// then the job lands in the failed set for inspection.
export function startIngestWorker(): Worker<IngestJobData> {
  const worker = new Worker<IngestJobData>(
    QUEUES.ingest,
    async (job) => {
      const result = await processIngestEvent(job.data)
      if (result.recoveryJobId) {
        await getQueue('recovery').add('evaluate-recovery', {
          recoveryJobId: result.recoveryJobId,
        })
      }
      // Duplicates are a success from the queue's perspective.
      return result
    },
    { connection: { url: config.redisUrl }, concurrency: 5 },
  )
  worker.on('failed', (job, err) => {
    console.error(`[ingest] job ${job?.id} failed permanently:`, err.message)
  })
  console.log(`[ingest] worker listening on ${QUEUES.ingest}`)
  return worker
}
