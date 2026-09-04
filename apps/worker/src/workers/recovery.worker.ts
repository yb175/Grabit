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
//   - All clear -> status=processing -> hand off to AI Agent (planned)

import { createHash } from 'node:crypto'
import { Worker } from 'bullmq'
import { prisma, Prisma } from '@grabit/db'
import { config } from '@grabit/config'
import {
  evaluateStoppingRules,
  fetchRazorpayPaymentStatus,
  type ResolvedPaymentStatus,
  type StoppingRuleDecision,
  type StoppingRulesConfig,
  paymentLinkService,
  PaymentLinkService,
} from '@grabit/core'
import { QUEUES, getQueue } from '@grabit/queue'

interface AgentResponse {
  decision_type: 'stop' | 'delay' | 'one_click' | 'escalate_hitl'
  failure_type: 'hard' | 'soft' | 'autopay_failed' | 'autopay_cancelled'
  explanation: string
  customer_message: string
  action_payload: Record<string, unknown>
  confidence: number
  model_version: string
  should_escalate_hitl: boolean
  taxonomy_match: string | null
  tools_used: string[]
}

export interface AgentDecidePayload {
  job_id: string
  failed_payment: {
    razorpay_payment_id: string
    amount: number
    currency: string
    failure_code: string | null
    failure_reason: string | null
    failure_source: string | null
    payment_method: string
  }
  job: {
    follow_up_count: number
    max_follow_ups: number
    status: string
  }
}

export function buildAgentPayload(job: {
  id: string
  followUpCount: number
  maxFollowUps: number
  status: string
  failedPayment: {
    razorpayPaymentId: string
    amount: number | { toString(): string }
    currency: string
    failureCode?: string | null
    failureReason?: string | null
    failureSource?: string | null
    paymentMethod?: string | null
    [key: string]: any
  }
}): AgentDecidePayload {
  return {
    job_id: job.id,
    failed_payment: {
      razorpay_payment_id: job.failedPayment.razorpayPaymentId,
      amount: Number(job.failedPayment.amount),
      currency: job.failedPayment.currency,
      failure_code: job.failedPayment.failureCode ?? null,
      failure_reason: job.failedPayment.failureReason ?? null,
      failure_source: job.failedPayment.failureSource ?? null,
      payment_method: job.failedPayment.paymentMethod ?? 'upi',
    },
    job: {
      follow_up_count: job.followUpCount,
      max_follow_ups: job.maxFollowUps,
      status: job.status,
    },
  }
}

async function callAgent(job: any): Promise<AgentResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${config.aiAgentUrl}/v1/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(buildAgentPayload(job)),
    })
    if (!response.ok) throw new Error(`agent HTTP ${response.status}`)
    const result = await response.json() as AgentResponse
    if (!['stop', 'delay', 'one_click', 'escalate_hitl'].includes(result.decision_type)) throw new Error('invalid agent decision')
    return result
  } finally { clearTimeout(timer) }
}

export interface RecoveryJobData {
  recoveryJobId: string
  aiConfidence?: number
  isAmbiguous?: boolean
  preferSalaryWindow?: boolean
  config?: Partial<StoppingRulesConfig>
  paymentStatusResolver?: (razorpayPaymentId: string) => Promise<ResolvedPaymentStatus>
  paymentLinkService?: PaymentLinkService
  agentOverride?: AgentResponse
}

export interface RecoveryProcessResult {
  outcome: 'completed' | 'not_found'
  recoveryJobId: string
  decision?: StoppingRuleDecision
}

/**
 * Generate a deterministic UUID from a given key string.
 */
export function stableUuid(key: string): string {
  const bytes = createHash('sha1').update(key).digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex').slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
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
      decisions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  if (!job) {
    console.warn(`[recovery] job ${recoveryJobId} not found in DB`)
    return { outcome: 'not_found', recoveryJobId }
  }

  // Resolve latest payment status if not already known to be paid
  if (!job.failedPayment.isPaid) {
    const statusResolver =
      data.paymentStatusResolver ??
      ((id: string) =>
        fetchRazorpayPaymentStatus(id, {
          keyId: config.razorpayKeyId,
          keySecret: config.razorpayKeySecret,
          baseUrl: config.razorpayApiUrl,
        }))
    try {
      const status = await statusResolver(job.failedPayment.razorpayPaymentId)
      if (status === 'paid') {
        await prisma.failedPayment.update({
          where: { id: job.failedPayment.id },
          data: {
            isPaid: true,
            paidAt: now,
          },
        })
        job.failedPayment.isPaid = true
      }
    } catch (err) {
      console.warn(`[recovery] payment status lookup error for ${job.failedPayment.razorpayPaymentId}:`, err)
    }
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
      const ledgerId = stableUuid(`recovery-ledger:recovered:${job.id}`)
      const auditId = stableUuid(`audit:stop_recovered:${job.id}`)
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'recovered' },
        }),
        prisma.recoveryLedger.upsert({
          where: { id: ledgerId },
          create: {
            id: ledgerId,
            recoveryJobId: job.id,
            failedPaymentId: job.failedPayment.id,
            amount: job.failedPayment.amount,
            status: 'recovered',
            recoveryMethod: 'retry',
            recoveredAt: now,
          },
          update: {},
        }),
        prisma.auditLog.upsert({
          where: { id: auditId },
          create: {
            id: auditId,
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'stop_recovered',
            oldValue: { status: job.status },
            newValue: { status: 'recovered', reason: decision.reason },
            performedBy: 'stopping_rules',
          },
          update: {},
        }),
      ])
      break
    }

    case 'stop_unrecovered': {
      const ledgerId = stableUuid(`recovery-ledger:unrecovered:${job.id}`)
      const auditId = stableUuid(`audit:stop_unrecovered:${job.id}`)
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'unrecovered' },
        }),
        prisma.recoveryLedger.upsert({
          where: { id: ledgerId },
          create: {
            id: ledgerId,
            recoveryJobId: job.id,
            failedPaymentId: job.failedPayment.id,
            amount: job.failedPayment.amount,
            status: 'unrecovered',
          },
          update: {},
        }),
        prisma.auditLog.upsert({
          where: { id: auditId },
          create: {
            id: auditId,
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'stop_unrecovered',
            oldValue: { status: job.status },
            newValue: { status: 'unrecovered', reason: decision.reason },
            performedBy: 'stopping_rules',
          },
          update: {},
        }),
      ])
      break
    }

    case 'stop_rejected': {
      const auditId = stableUuid(`audit:stop_rejected:${job.id}`)
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'rejected' },
        }),
        prisma.auditLog.upsert({
          where: { id: auditId },
          create: {
            id: auditId,
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'stop_rejected',
            oldValue: { status: job.status },
            newValue: { status: 'rejected', reason: decision.reason },
            performedBy: 'stopping_rules',
          },
          update: {},
        }),
      ])
      break
    }

    case 'stale': {
      const auditId = stableUuid(`audit:marked_stale:${job.id}`)
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'stale' },
        }),
        prisma.auditLog.upsert({
          where: { id: auditId },
          create: {
            id: auditId,
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'marked_stale',
            oldValue: { status: job.status },
            newValue: { status: 'stale', reason: decision.reason },
            performedBy: 'stopping_rules',
          },
          update: {},
        }),
      ])
      break
    }

    case 'delay': {
      const auditId = stableUuid(
        `audit:scheduled_delay:${job.id}:${decision.nextAttemptAt?.toISOString() ?? 'none'}`,
      )
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: {
            status: 'waiting',
            nextAttemptAt: decision.nextAttemptAt,
          },
        }),
        prisma.auditLog.upsert({
          where: { id: auditId },
          create: {
            id: auditId,
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
          update: {},
        }),
      ])

      if (decision.nextAttemptAt) {
        const delayMs = Math.max(decision.nextAttemptAt.getTime() - now.getTime(), 0)
        await getQueue('recovery').add(
          'evaluate-recovery',
          { recoveryJobId: job.id },
          {
            delay: delayMs,
            jobId: stableUuid(`recovery-delay:${job.id}:${decision.nextAttemptAt.toISOString()}`),
          },
        )
      }
      break
    }

    case 'hitl': {
      const hitlTaskId = stableUuid(`hitl-task:${job.id}`)
      const auditId = stableUuid(`audit:escalated_hitl:${job.id}`)
      await prisma.$transaction(async (tx) => {
        await tx.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'hitl' },
        })
        const hitlTask = await tx.hitlQueue.upsert({
          where: { id: hitlTaskId },
          create: {
            id: hitlTaskId,
            recoveryJobId: job.id,
            reason: decision.reason,
            status: 'pending',
          },
          update: {},
        })
        await tx.auditLog.upsert({
          where: { id: auditId },
          create: {
            id: auditId,
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'escalated_hitl',
            oldValue: { status: job.status },
            newValue: { status: 'hitl', hitlTaskId: hitlTask.id, reason: decision.reason },
            performedBy: 'stopping_rules',
          },
          update: {},
        })
      })

      // Enqueue to HITL queue for notifications/reviewers
      const hitlQueue = getQueue('hitl')
      await hitlQueue.add(
        'review',
        { recoveryJobId: job.id, reason: decision.reason },
        { jobId: stableUuid(`hitl-review:${job.id}`) },
      )
      break
    }

    case 'continue': {
      const auditId = stableUuid(`audit:stopping_rules_passed:${job.id}`)
      await prisma.$transaction([
        prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'processing' },
        }),
        prisma.auditLog.upsert({
          where: { id: auditId },
          create: {
            id: auditId,
            entityType: 'recovery_jobs',
            entityId: job.id,
            action: 'stopping_rules_passed',
            oldValue: { status: job.status },
            newValue: { status: 'processing', reason: decision.reason },
            performedBy: 'stopping_rules',
          },
          update: {},
        }),
      ])

      const decisionId = stableUuid(`agent-decision:${job.id}`)
      const existingDecision =
        job.decisions?.[0] ??
        (await prisma.agentDecision.findUnique({ where: { id: decisionId } }))
      let agent: AgentResponse
      let shouldPersistDecision = true

      if (data.agentOverride) {
        agent = data.agentOverride
      } else if (existingDecision && existingDecision.modelVersion !== 'in_progress') {
        const payload = (existingDecision.actionPayload as Record<string, unknown>) ?? {}
        agent = {
          decision_type: existingDecision.decisionType as AgentResponse['decision_type'],
          failure_type: job.failureType,
          explanation: existingDecision.explanation ?? '',
          customer_message: typeof payload.customer_message === 'string' ? payload.customer_message : '',
          action_payload: payload,
          confidence: existingDecision.confidence ?? 0,
          model_version: existingDecision.modelVersion ?? 'stored',
          should_escalate_hitl:
            Boolean(payload.should_escalate_hitl) || existingDecision.decisionType === 'escalate_hitl',
          taxonomy_match: typeof payload.taxonomy_match === 'string' ? payload.taxonomy_match : null,
          tools_used: Array.isArray(payload.tools_used) ? (payload.tools_used as string[]) : [],
        }
      } else {
        // Atomic claim: worker runs with concurrency 5, so two deliveries may
        // both see no stored decision. Exactly one wins the claim row and
        // calls the AI; the others wait and reuse that decision.
        let isOwner = false
        if (!existingDecision) {
          try {
            await prisma.agentDecision.create({
              data: {
                id: decisionId,
                recoveryJobId: job.id,
                decisionType: 'escalate_hitl',
                explanation: 'in_progress',
                confidence: 0,
                modelVersion: 'in_progress',
                actionPayload: {},
              },
            })
            isOwner = true
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              isOwner = false
            } else {
              throw err
            }
          }
        }

        if (isOwner) {
          try {
            agent = await callAgent(job)
          } catch (error) {
            // Bounded TS fallback: the worker must never crash because the agent is down.
            agent = {
              decision_type: 'escalate_hitl',
              failure_type: job.failureType,
              explanation: `AI unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
              customer_message: '',
              action_payload: {},
              confidence: 0,
              model_version: 'fallback',
              should_escalate_hitl: true,
              taxonomy_match: job.failedPayment.failureCode,
              tools_used: [],
            }
          }
        } else {
          // Lost the claim: wait for the owner's decision, then reuse it.
          shouldPersistDecision = false
          let finalDecision = await prisma.agentDecision.findUnique({ where: { id: decisionId } })
          const startWait = Date.now()
          while (finalDecision?.modelVersion === 'in_progress' && Date.now() - startWait < 10_000) {
            await new Promise((r) => setTimeout(r, 50))
            finalDecision = await prisma.agentDecision.findUnique({ where: { id: decisionId } })
          }
          const payload = (finalDecision?.actionPayload as Record<string, unknown>) ?? {}
          agent = {
            decision_type: (finalDecision?.decisionType ?? 'escalate_hitl') as AgentResponse['decision_type'],
            failure_type: job.failureType,
            explanation: finalDecision?.explanation ?? '',
            customer_message: typeof payload.customer_message === 'string' ? payload.customer_message : '',
            action_payload: payload,
            confidence: finalDecision?.confidence ?? 0,
            model_version: finalDecision?.modelVersion ?? 'stored',
            should_escalate_hitl:
              Boolean(payload.should_escalate_hitl) || finalDecision?.decisionType === 'escalate_hitl',
            taxonomy_match: typeof payload.taxonomy_match === 'string' ? payload.taxonomy_match : null,
            tools_used: Array.isArray(payload.tools_used) ? (payload.tools_used as string[]) : [],
          }
        }

      }

      const linkService = data.paymentLinkService ?? paymentLinkService
      let paymentLink: { id: string; shortUrl: string } | null = null

      if (agent.decision_type === 'one_click') {
        if (job.paymentLinkId && job.paymentLinkUrl) {
          paymentLink = { id: job.paymentLinkId, shortUrl: job.paymentLinkUrl }
        } else {
          // Mock links come from PaymentLinkService itself when Razorpay is
          // disabled/unconfigured. Any real API or persistence failure here
          // propagates so the recovery job is retried — never replaced with a
          // non-checkout example.test URL sent to a customer.
          const link = await linkService.create({
            amount: job.failedPayment.amount,
            currency: job.failedPayment.currency ?? 'INR',
            referenceId: job.id,
            description: job.failedPayment.failureReason ?? 'Payment recovery',
            customer: {
              name: job.failedPayment.customerName,
              contact: job.failedPayment.customerPhone,
              email: job.failedPayment.customerEmail,
            },
            notes: {
              recovery_job_id: job.id,
              failed_payment_id: job.failedPayment.id,
            },
          })
          paymentLink = { id: link.id, shortUrl: link.shortUrl }
          await prisma.recoveryJob.update({
            where: { id: job.id },
            data: {
              paymentLinkId: link.id,
              paymentLinkUrl: link.shortUrl,
            },
          })
        }
      }

      if (shouldPersistDecision) {
      const finalActionPayload = {
        ...agent.action_payload,
        customer_message: agent.customer_message,
        taxonomy_match: agent.taxonomy_match,
        model_version: agent.model_version,
        tools_used: agent.tools_used,
        should_escalate_hitl: agent.should_escalate_hitl,
        ...(paymentLink
          ? {
              payment_link_id: paymentLink.id,
              payment_link_url: paymentLink.shortUrl,
            }
          : {}),
      }
      await prisma.agentDecision.upsert({
        where: { id: decisionId },
        create: {
          id: decisionId,
          recoveryJobId: job.id,
          decisionType: agent.decision_type,
          explanation: agent.explanation,
          actionPayload: finalActionPayload,
          confidence: agent.confidence,
          modelVersion: agent.model_version,
        },
        update: {
          decisionType: agent.decision_type,
          explanation: agent.explanation,
          actionPayload: finalActionPayload,
          confidence: agent.confidence,
          modelVersion: agent.model_version,
        },
      })
      await prisma.auditLog.upsert({
        where: { id: stableUuid(`audit:agent_decision:${job.id}`) },
        create: {
          id: stableUuid(`audit:agent_decision:${job.id}`),
          entityType: 'recovery_jobs',
          entityId: job.id,
          action: 'agent_decision',
          oldValue: {},
          newValue: finalActionPayload,
          performedBy: 'agent',
        },
        update: {},
      })
      }
      if (agent.decision_type === 'one_click' && agent.customer_message &&
        (config.messageChannel === 'email' ? job.failedPayment.customerEmail : job.failedPayment.customerPhone)) {
        await getQueue('message').add(
          'send-recovery-message',
          {
            recoveryJobId: job.id,
            followUpCount: job.followUpCount,
            toPhone: job.failedPayment.customerPhone ?? undefined,
            toEmail: job.failedPayment.customerEmail ?? undefined,
            messageBody: agent.customer_message,
            paymentLinkId: paymentLink?.id,
            paymentLinkUrl: paymentLink?.shortUrl,
            templateVars: {
              1: job.failedPayment.customerName ?? 'there',
              2: `₹${job.failedPayment.amount.toString()}`,
              3: job.failedPayment.razorpayOrderId ?? 'your order',
              4: job.failedPayment.failureReason ?? 'the payment could not be processed',
              5: 'try again using the payment link',
            },
          },
          {
            jobId: stableUuid(`message:${job.id}:${job.followUpCount}`),
          },
        )

      } else if (agent.decision_type === 'escalate_hitl' || agent.should_escalate_hitl) {
        const hitlTaskId = stableUuid(`hitl-task:${job.id}`)
        await prisma.hitlQueue.upsert({
          where: { id: hitlTaskId },
          create: {
            id: hitlTaskId,
            recoveryJobId: job.id,
            reason: agent.explanation,
            status: 'pending',
          },
          update: {},
        })
        await prisma.recoveryJob.update({
          where: { id: job.id },
          data: { status: 'hitl' },
        })
        await getQueue('hitl').add(
          'review',
          { recoveryJobId: job.id, reason: agent.explanation },
          { jobId: stableUuid(`hitl-review:${job.id}`) },
        )
      }
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
