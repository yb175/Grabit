// @grabit/queue — BullMQ queue + connection helpers shared by apps/api and apps/worker.
//
// Grabit's recovery pipeline runs as async jobs:
//   ingest   (webhook -> persist failure)         <- built in this slice
//   recovery (AI diagnosis + timing decision)
//   message  (send WhatsApp recovery message)
//   followup (retry on smart schedule)
//   hitl     (escalate to a human)
//
// The API enqueues; the workers consume. Neither opens a connection until
// getQueue/getWorkerConnection is actually called, so importing this module
// from tests is side-effect free.

import { Queue } from 'bullmq'
import { config } from '@grabit/config'

export const QUEUES = {
  ingest: 'grabit.ingest',
  recovery: 'grabit.recovery',
  message: 'grabit.message',
  followup: 'grabit.followup',
  hitl: 'grabit.hitl',
} as const

export type QueueName = keyof typeof QUEUES

/// Shared job options: 3 attempts with exponential backoff, bounded history.
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 } as const,
  removeOnComplete: 500,
  removeOnFail: 1000,
} as const

/// Module-level cache so the API/worker process opens ONE Redis connection
/// per queue name, no matter how often getQueue is called.
const queueCache = new Map<string, Queue>()

export function getQueue(name: QueueName): Queue {
  const key = QUEUES[name]
  let q = queueCache.get(key)
  if (!q) {
    q = new Queue(key, {
      connection: { url: config.redisUrl },
      defaultJobOptions: { ...DEFAULT_JOB_OPTIONS },
    })
    queueCache.set(key, q)
  }
  return q
}
