// Grabit Worker — entrypoint.
//
// Runs the BullMQ workers that make up the recovery pipeline:
//   ingest   : webhook event -> persisted failed_payment + recovery_job
//   recovery : Stopping rules & smart timing -> AI diagnosis -> message queue
//   message  : send WhatsApp recovery message           (later)
//   followup : smart-scheduled retries                  (later)
//   hitl     : escalate to a human                      (later)
//
// Graceful shutdown on SIGINT/SIGTERM: stop taking jobs, let in-flight ones
// finish, close Prisma, exit.

import { prisma } from '@grabit/db'
import { config } from '@grabit/config'
import { startIngestWorker } from './workers/ingest.worker.js'
import { startRecoveryWorker } from './workers/recovery.worker.js'

console.log(`[grabit-worker] starting (redis: ${config.redisUrl})`)

const ingestWorker = startIngestWorker()
const recoveryWorker = startRecoveryWorker()

async function shutdown(signal: string) {
  console.log(`[grabit-worker] ${signal} received — shutting down`)
  await Promise.all([ingestWorker.close(), recoveryWorker.close()])
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
