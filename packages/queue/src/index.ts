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
import { Redis } from 'ioredis'
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

export async function closeAllQueues(): Promise<void> {
  for (const q of queueCache.values()) {
    await q.close()
  }
  queueCache.clear()
}

// ---------------------------------------------------------------------------
// Redis Pub/Sub for real-time dashboard push (SSE)
// ---------------------------------------------------------------------------

const DASHBOARD_CHANNEL = 'grabit:dashboard:update'

let pubClient: Redis | null = null

function getPubClient(): Redis {
  if (!pubClient) {
    pubClient = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true })
    pubClient.on('error', () => {}) // swallow — pub is best-effort
  }
  return pubClient
}

/** Worker calls this after a status/ledger change. Best-effort, never throws. */
export async function publishDashboardUpdate(payload: {
  recoveryJobId: string
  status: string
  action?: string
}): Promise<void> {
  try {
    await getPubClient().publish(DASHBOARD_CHANNEL, JSON.stringify(payload))
  } catch {
    // Best-effort: if Redis pub fails the 3s poll still works.
  }
}

/** API calls this to get a subscriber that emits dashboard update messages. */
export function subscribeDashboardUpdates(): { sub: Redis; channel: string } {
  const sub = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true })
  sub.on('error', () => {}) // swallow reconnect noise
  return { sub, channel: DASHBOARD_CHANNEL }
}

