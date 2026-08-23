// @grabit/queue — BullMQ queue + worker helpers shared by apps/api and apps/worker.
//
// Grabit's recovery pipeline runs as async jobs:
//   ingest   (webhook -> persist failure)
//   -> recovery (AI diagnosis + timing decision)
//   -> message (send WhatsApp recovery message)
//   -> followup (retry on smart schedule, honour stopping rules)
//   -> hitl    (escalate to a human when needed)
//
// Eventually this file defines the queue names, event types and helper
// functions to enqueue/delay jobs. Chunk 1: names only.
export const QUEUES = {
  ingest: 'grabit.ingest',
  recovery: 'grabit.recovery',
  message: 'grabit.message',
  followup: 'grabit.followup',
  hitl: 'grabit.hitl',
} as const
