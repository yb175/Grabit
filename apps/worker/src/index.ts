// Grabit Worker — entrypoint.
//
// Grabit is an AI Payment Revenue Recovery system. This service runs the
// BullMQ workers that make up the recovery pipeline:
//
//   ingest.worker   : webhook event -> persisted PaymentFailure record
//   recovery.worker : AI diagnosis (Hard/Soft/Autopay Failed/Cancelled) + action + timing decision
//   message.worker  : send personalized WhatsApp one-click recovery message
//   followup.worker : smart-scheduled retries, enforcing stopping rules
//   hitl.worker     : escalate ambiguous/high-value cases to a human
//
// Chunk 1: boots and reports Redis connectivity only. Workers get wired in
// Chunk 2 once Redis + queues are live.
import { config } from '@grabit/config'

console.log(`[grabit-worker] starting (redis: ${config.redisUrl})`)
console.log('[grabit-worker] skeleton mode — no workers registered yet')

// Keep the process alive.
setInterval(() => {}, 1 << 30)
