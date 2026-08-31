// recovery.worker — Recovery decision pipeline stage in Grabit.
//
// Consumes jobs from QUEUES.recovery, applies Stopping Rules & Smart-Timing
// BEFORE calling the AI Agent:
//   - Already recovered / Paid -> mark recovered + ledger -> stop
//   - Max follow-ups exceeded -> mark unrecovered + ledger -> stop
//   - Hard failure -> mark unrecovered (or HITL if VIP/high value) -> stop
//   - Inactivity >= 24h -> mark stale -> stop
//   - HITL criteria met (amount >= 10k, low AI confidence, ambiguous) -> escalate to HITL
//   - Timing constraint (quiet hours 21:00-08:00 IST, repeat gap, salary window) -> delay to next window
//   - All clear -> status=processing -> hand off to AI Agent

import { Worker } from 'bullmq'
import { prisma } from '@grabit/db'
import { config } from '@grabit/config'
import {
  evaluateStoppingRules,
  type StoppingRuleDecision,
  type StoppingRulesConfig,
} from '@grabit/core'
import { QUEUES, getQueue } from '@grabit/queue'

export interface RecoveryJobData {
  recoveryJobId: string
  aiConfidence?: number
  isAmbiguous?: boolean
  preferSalaryWindow?: boolean
  config?: Partial<StoppingRulesConfig>
}

export interface RecoveryProcessResult {
  outcome: 'completed' | 'not_found'
  recoveryJobId: string
  decision?: StoppingRuleDecision
}

/**
 * Core business logic for recovery job evaluation against stopping rules.
 * Pure async function with no BullMQ dependency for deterministic testing.
 */
export async function processRecoveryJob(
  data: RecoveryJobData,
  now = new Date(),
): Promise<RecoveryProcessResult> {
  const { recoveryJobId } = data

  const job = await prisma.recoveryJob.findUnique({
    where: { id: recoveryJobId },
    include: {
      failedPayment: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      hitlTasks: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  if (!job) {
    console.warn(`[recovery] job ${recoveryJobId} not found in DB`)
    return { outcome: 'not_found', recoveryJobId }
  }

  const lastMessage = job.messages[0]
  const lastMessageAt = lastMessage?.sentAt ?? lastMessage?.createdAt ?? null
  const hitlStatus = job.hitlTasks[0]?.status ?? null

  const decision = evaluateStoppingRules({
    job,
    payment: job.failedPayment,
    now,
    lastMessageAt,
    aiConfidence: data.aiConfidence,
    hitlStatus,
    isAmbiguous: data.isAmbiguous,
    preferSalaryWindow: data.preferSalaryWindow,
    config: data.config,
  })

  console.log(
    `[recovery] job ${job.id} decision: action=${decision.action} rule=${decision.rule} reason="${decision.reason}"`,
  )

  // Execute the decision against the database
  switch (decision.action) {
    case 'stop_recovered': {
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'recovered' },
        }),
        prisma.recoveryLedger.create({
          data: {
            recoveryJobId: job.id,
            failedPaymentId: job.failedPayment.id,
            amount: job.failedPayment.amount,
            status: 'recovered',
            recoveryMethod: 'retry',
            recoveredAt: now,
          },
        }),
        prisma.auditLog.create({
          data: {
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'stop_recovered',
            oldValue: { status: job.status },
            newValue: { status: 'recovered', reason: decision.reason },
            performedBy: 'stopping_rules',
          },
        }),
      ])
      break
    }

    case 'stop_unrecovered': {
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'unrecovered' },
        }),
        prisma.recoveryLedger.create({
          data: {
            recoveryJobId: job.id,
            failedPaymentId: job.failedPayment.id,
            amount: job.failedPayment.amount,
            status: 'unrecovered',
          },
        }),
        prisma.auditLog.create({
          data: {
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'stop_unrecovered',
            oldValue: { status: job.status },
            newValue: { status: 'unrecovered', reason: decision.reason },
            performedBy: 'stopping_rules',
          },
        }),
      ])
      break
    }

    case 'stop_rejected': {
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'rejected' },
        }),
        prisma.auditLog.create({
          data: {
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'stop_rejected',
            oldValue: { status: job.status },
            newValue: { status: 'rejected', reason: decision.reason },
            performedBy: 'stopping_rules',
          },
        }),
      ])
      break
    }

    case 'stale': {
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'stale' },
        }),
        prisma.auditLog.create({
          data: {
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'marked_stale',
            oldValue: { status: job.status },
            newValue: { status: 'stale', reason: decision.reason },
            performedBy: 'stopping_rules',
          },
        }),
      ])
      break
    }

    case 'delay': {
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: {
            status: 'waiting',
            nextAttemptAt: decision.nextAttemptAt,
          },
        }),
        prisma.auditLog.create({
          data: {
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'scheduled_delay',
            oldValue: { status: job.status, nextAttemptAt: job.nextAttemptAt },
            newValue: {
              status: 'waiting',
              nextAttemptAt: decision.nextAttemptAt?.toISOString(),
              reason: decision.reason,
            },
            performedBy: 'stopping_rules',
          },
        }),
      ])
      break
    }

    case 'hitl': {
      await prisma.$transaction(async (tx) => {
        await tx.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'hitl' },
        })
        const hitlTask = await tx.hitlQueue.create({
          data: {
            recoveryJobId: job.id,
            reason: decision.reason,
            status: 'pending',
          },
        })
        await tx.auditLog.create({
          data: {
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'escalated_hitl',
            oldValue: { status: job.status },
            newValue: { status: 'hitl', hitlTaskId: hitlTask.id, reason: decision.reason },
            performedBy: 'stopping_rules',
          },
        })
      })

      // Enqueue to HITL queue for notifications/reviewers
      const hitlQueue = getQueue('hitl')
      await hitlQueue.add('review', { recoveryJobId: job.id, reason: decision.reason })
      break
    }

    case 'continue': {
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'processing' },
        }),
        prisma.auditLog.create({
          data: {
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'stopping_rules_passed',
            oldValue: { status: job.status },
            newValue: { status: 'processing', reason: decision.reason },
            performedBy: 'stopping_rules',
          },
        }),
      ])
      // Next stage: Call Python AI Agent for failure explanation & message copy
      break
    }
  }

  return {
    outcome: 'completed',
    recoveryJobId: job.id,
    decision,
  }
}

/**
 * BullMQ Worker instance for the recovery pipeline.
 * Configured with max 3 attempts + exponential backoff, without separate DLQ.
 */
export function startRecoveryWorker(): Worker<RecoveryJobData> {
  const worker = new Worker<RecoveryJobData>(
    QUEUES.recovery,
    async (job) => {
      const result = await processRecoveryJob(job.data)
      return result
    },
    {
      connection: { url: config.redisUrl },
      concurrency: 5,
    },
  )

  worker.on('failed', (job, err) => {
    console.error(`[recovery] job ${job?.id} failed after retries:`, err.message)
  })

  console.log(`[recovery] worker listening on ${QUEUES.recovery}`)
  return worker
}
