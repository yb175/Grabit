# Grabit — Payment Recovery Engine Technical Documentation

This document outlines the architecture, data models, queue pipelines, stopping rules engine, and implementation snippets across the Grabit platform.

---

## Table of Contents
1. [System Architecture](#1-system-architecture)
2. [End-to-End System Flow](#2-end-to-end-system-flow)
3. [Database & Persistence Layer](#3-database--persistence-layer)
4. [Queue & Worker Architecture](#4-queue--worker-architecture)
5. [Core Domain Logic & Stopping Rules](#5-core-domain-logic--stopping-rules)
6. [API Ingestion Gateway](#6-api-ingestion-gateway)
7. [Worker Pipeline Implementation](#7-worker-pipeline-implementation)
8. [Testing & Verification](#8-testing--verification)

---

## 1. System Architecture

Grabit is built on a decoupled, asynchronous, event-driven architecture designed to process high-volume payment failure webhooks with zero loss, sub-50ms HTTP ingestion, deterministic rule gating, and recovery ledgering with audit logging.

```
+---------------------------------------------------------------------------------------------------+
|                                      EXTERNAL ACTORS & APIS                                       |
|  +--------------------+         +-----------------------+         +----------------------------+  |
|  |  Razorpay Webhooks |         | Customer (WhatsApp)   |         | Merchant Ops (Dashboard)   |  |
|  +---------+----------+         +-----------^-----------+         +-------------^--------------+  |
+------------|--------------------------------|-----------------------------------|-----------------+
             | (HMAC-SHA256 Signed)           | (One-click Link / Re-auth)        | (REST / Review)
             v                                |                                   v
+---------------------------------------------------------------------------------------------------+
| INGESTION & API GATEWAY (Hono + TypeScript)                                                       |
|   /webhooks/razorpay  •  /api/hitl  •  /api/ledger  •  /api/dashboard  •  /health                 |
|   - Signature verification + payload parsing/casting                                             |
|   - Currency normalization (Paise -> INR Decimal)                                                 |
|   - Enqueue to BullMQ Ingest Queue                                                                |
+---------------------------------------------+-----------------------------------------------------+
                                              |
                                              v
+---------------------------------------------------------------------------------------------------+
| ASYNCHRONOUS PROCESSING PIPELINE (BullMQ + Redis 6380)                                            |
|                                                                                                   |
|  +-----------------------+      +--------------------------+      +----------------------------+  |
|  |   1. Ingest Worker    | ---> |    2. Recovery Worker    | ---> |    3. AI Agent Service (planned) |  |
|  |   - Dedupe & Normalize|      |   - Stopping Rules Gate  |      |   (Python/Agno/FastAPI)    |  |
|  |   - Create Failure &  |      |   - Quiet Hours (IST)    |      |   - Failure Diagnosis      |  |
|  |     Recovery Job      |      |   - Salary Window Check  |      |   - Hinglish Copy Gen      |  |
|  +-----------------------+      +-------------+------------+      +-------------+--------------+  |
|                                               |                                 |                 |
|                                 +-------------+------------+                    v                 |
|                                 |                          |      +----------------------------+  |
|                                 v                          v      |     4. Message Worker      |  |
|                     +-----------------------+  +----------------+ |   - WhatsApp Dispatch      |  |
|                     |     5. HITL Worker    |  | Followup Worker| |   - Delivery Tracking      |  |
|                     |  - High Value (>=10k) |  | - Smart Delays | +----------------------------+  |
|                     |  - Low Confidence     |  | - Backoff Loop |                                 |
|                     +-----------------------+  +----------------+                                 |
+---------------------------------------------+-----------------------------------------------------+
                                              |
                                              v
+---------------------------------------------------------------------------------------------------+
| PERSISTENCE & DATA LAYER (PostgreSQL 5433 + Prisma ORM)                                           |
|   • failed_payments   • recovery_jobs    • recovery_messages                                      |
|   • hitl_tasks        • recovery_ledger  • audit_logs                                             |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. End-to-End System Flow

```
[ Razorpay Failure Event ]
           |
           v
+----------------------+
| 1. Ingest & Verify   | ---> Validate Signature -> Paise-to-INR Conversion -> Idempotently create `failed_payments`; ignore duplicate webhooks
+----------+-----------+
           |
           v
+----------------------+
| 2. Stopping Rules &  | ---> Checks: Already paid? Max follow-ups? Hard decline? Stale (>24h)?
|    Timing Filter     |
+----------+-----------+
           |
     +-----+----------------------------------+
     | Passes Rules                           | Rule Triggered
     v                                        v
+----------------------+             +----------------------------------------------------------+
| 3. AI Agent Decision |             | - High Value (>=10k) / Low Confidence -> HITL Escalation |
|    & Copy Generation |             | - Quiet Hours (21:00-08:00 IST) / Salary Gap -> Delay    |
+----------+-----------+             | - Hard Decline / Max Follow-ups -> Mark Unrecovered      |
           |                         +----------------------------------------------------------+
           v
+----------------------+
| 4. WhatsApp Outreach | ---> Sends personalized one-click recovery message via WhatsApp API
+----------+-----------+
           |
           v
+----------------------+
| 5. Customer Action   | ---> Customer clicks one-click link or updates mandate via Razorpay
+----------+-----------+
           |
           v
+----------------------+
| 6. Reconciliation    | ---> Payment Webhook -> Mark `recovered` -> Record in `recovery_ledger`
+----------------------+
```

---

## 3. Database & Persistence Layer

Located in `packages/db/prisma/schema.prisma`.

```
+---------------------------+             +---------------------------+
|      failed_payments      | 1         1 |       recovery_jobs       |
+---------------------------+-------------+---------------------------+
| id (PK, UUID)             |             | id (PK, UUID)             |
| razorpay_payment_id (UQ)  |             | failed_payment_id (FK)    |
| razorpay_order_id         |             | status (enum)             |
| amount (Decimal, INR)     |             | failure_type (enum)       |
| currency (default: 'INR') |             | follow_up_count (int)     |
| failure_code / reason     |             | max_follow_ups (default 2)|
| failure_source (enum)     |             | next_attempt_at (tz)      |
| customer_phone / email    |             | created_at / updated_at   |
| raw_payload (jsonb)       |             +-------------+-------------+
+---------------------------+                           |
                                      +-----------------+-----------------+
                                    1 |                                 1 |
                                      v                                   v
                        +---------------------------+       +---------------------------+
                        |     recovery_messages     |       |        hitl_tasks         |
                        +---------------------------+       +---------------------------+
                        | id (PK, UUID)             |       | id (PK, UUID)             |
                        | recovery_job_id (FK)      |       | recovery_job_id (FK)      |
                        | template_name             |       | status (enum)             |
                        | rendered_body (text)      |       | priority (enum)           |
                        | recovery_url (text)       |       | reason (text)             |
                        | status (enum)             |       | reviewer_notes (text)     |
                        | sent_at / delivered_at    |       | assigned_to / resolved_at |
                        +---------------------------+       +---------------------------+
                                                                          |
                                      +-----------------------------------+
                                    1 |
                                      v
                        +---------------------------+       +---------------------------+
                        |      recovery_ledger      |       |        audit_logs         |
                        +---------------------------+       +---------------------------+
                        | id (PK, UUID)             |       | id (PK, UUID)             |
                        | recovery_job_id (FK, UQ)  |       | entity_type (text)        |
                        | failed_payment_id (FK)    |       | entity_id (UUID)          |
                        | amount (Decimal, INR)     |       | action (text)             |
                        | status (enum)             |       | actor_type / actor_id     |
                        | recovery_method (enum)    |       | old_state / new_state(jb) |
                        | recovered_at (tz)         |       | created_at (tz)           |
                        +---------------------------+       +---------------------------+
```

### Schema Snippet: `packages/db/prisma/schema.prisma`

```prisma
enum RecoveryJobStatus {
  pending
  processing
  waiting
  hitl
  recovered
  unrecovered
  rejected
  stale
}

enum FailureType {
  hard
  soft
  autopay_failed
  autopay_cancelled
}

model FailedPayment {
  id                String          @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  razorpayPaymentId String          @unique @map("razorpay_payment_id")
  razorpayOrderId   String?         @map("razorpay_order_id")
  amount            Decimal         @db.Decimal(12, 2) // Stored in INR Rupees
  currency          String          @default("INR")
  failureCode       String?         @map("failure_code")
  failureReason     String?         @map("failure_reason")
  failureSource     FailureSource   @default(payment) @map("failure_source")
  paymentMethod     String?         @map("payment_method")
  customerPhone     String?         @map("customer_phone")
  customerEmail     String?         @map("customer_email")
  customerName      String?         @map("customer_name")
  rawPayload        Json            @map("raw_payload")
  createdAt         DateTime        @default(now()) @map("created_at") @db.Timestamptz

  recoveryJob       RecoveryJob?
  ledgerEntries     RecoveryLedger[]

  @@map("failed_payments")
}

model RecoveryJob {
  id             String            @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  failedPaymentId String           @unique @map("failed_payment_id") @db.Uuid
  status         RecoveryJobStatus @default(pending)
  failureType    FailureType       @map("failure_type")
  followUpCount  Int               @default(0) @map("follow_up_count")
  maxFollowUps   Int               @default(2) @map("max_follow_ups")
  nextAttemptAt  DateTime?         @map("next_attempt_at") @db.Timestamptz
  createdAt      DateTime          @default(now()) @map("created_at") @db.Timestamptz
  updatedAt      DateTime          @updatedAt @map("updated_at") @db.Timestamptz

  failedPayment  FailedPayment     @relation(fields: [failedPaymentId], references: [id], onDelete: Cascade)
  messages       RecoveryMessage[]
  hitlTasks      HitlTask[]
  ledgerEntry    RecoveryLedger?

  @@map("recovery_jobs")
}
```

---

## 4. Queue & Worker Architecture

Located in `packages/queue/src/index.ts`.

### Queue Singleton & Lifecycle Snippet

```typescript
import { Queue } from 'bullmq'
import { config } from '@grabit/config'

export const QUEUES = {
  ingest: 'grabit:ingest',
  recovery: 'grabit:recovery',
  message: 'grabit:message',
  followup: 'grabit:followup',
  hitl: 'grabit:hitl',
} as const

export type QueueName = keyof typeof QUEUES

const queueCache = new Map<QueueName, Queue>()

export function getQueue(name: QueueName): Queue {
  let q = queueCache.get(name)
  if (!q) {
    q = new Queue(QUEUES[name], {
      connection: { url: config.redisUrl },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    })
    queueCache.set(name, q)
  }
  return q
}

export async function closeAllQueues(): Promise<void> {
  for (const q of queueCache.values()) {
    await q.close()
  }
  queueCache.clear()
}
```

---

## 5. Core Domain Logic & Stopping Rules

Located in `packages/core/src/stopping-rules.ts` and `packages/core/src/razorpay.ts`.

### 5.1. Stopping Rules Engine (Implementation Summary / Pseudocode)

*The complete executable contract lives in `packages/core/src/stopping-rules.ts`.*

```typescript
export function evaluateStoppingRules(input: StoppingRulesInput): StoppingRuleDecision {
  const { job, payment, now = new Date(), lastMessageAt, aiConfidence, hitlStatus, isAmbiguous } = input
  const cfg: StoppingRulesConfig = { ...DEFAULT_STOPPING_RULES_CONFIG, ...input.config }

  // 1. Terminal State: Already Recovered or Paid
  if (payment.isPaid === true || job.status === 'recovered') {
    return { action: 'stop_recovered', rule: 'already_recovered', reason: 'Payment already recovered/paid', shouldCallAi: false }
  }

  // 2. HITL Reviewer Decision
  if (hitlStatus === 'rejected' || job.status === 'rejected') {
    return { action: 'stop_rejected', rule: 'hitl_rejected', reason: 'Case rejected by reviewer', shouldCallAi: false }
  }

  // 3. Stale Status or Outreach Timeout (> 24h inactivity)
  if (job.status === 'stale') {
    return { action: 'stale', rule: 'stale_status', reason: 'Job already marked stale', shouldCallAi: false }
  }
  if (lastMessageAt) {
    const elapsedHours = (now.getTime() - new Date(lastMessageAt).getTime()) / (1000 * 60 * 60)
    if (elapsedHours >= cfg.staleThresholdHours) {
      return { action: 'stale', rule: 'stale_timeout', reason: `No response within ${cfg.staleThresholdHours}h`, shouldCallAi: false }
    }
  }

  // 4. Max Follow-ups Exceeded
  const currentCount = job.followUpCount ?? 0
  const maxAllowed = job.maxFollowUps ?? cfg.maxFollowUps
  if (currentCount >= maxAllowed) {
    return { action: 'stop_unrecovered', rule: 'max_followups_exceeded', reason: `Max follow-up attempts (${maxAllowed}) reached`, shouldCallAi: false }
  }

  // 5. Human Escalation: High Value, Low AI Confidence, or Ambiguous Detail
  const amount = parseAmount(payment.amount)
  if (amount >= cfg.hitlAmountThresholdRupees) {
    return { action: 'hitl', rule: 'hitl_high_value', reason: `Payment amount (₹${amount}) >= threshold`, shouldCallAi: false }
  }
  if (aiConfidence !== undefined && aiConfidence < cfg.minAiConfidence) {
    return { action: 'hitl', rule: 'hitl_low_confidence', reason: `AI confidence below threshold (${cfg.minAiConfidence})`, shouldCallAi: false }
  }
  if (isAmbiguous === true) {
    return { action: 'hitl', rule: 'hitl_ambiguous', reason: 'Ambiguous payment failure requires human review', shouldCallAi: false }
  }

  // 6. Hard Decline (Unrecoverable)
  const isHardDecline = Boolean(payment.failureCode && HARD_DECLINE_CODES.has(payment.failureCode))
  if (job.failureType === 'hard' || isHardDecline) {
    return { action: 'stop_unrecovered', rule: 'hard_failure', reason: 'Hard failure cannot be retried', shouldCallAi: false }
  }

  // 7. Smart Timing: Repeat Gap, Salary Window, Quiet Hours (21:00 - 08:00 IST)
  // ... (calculates nextAllowed date and returns action: 'delay' with nextAttemptAt if in the future)

  // 8. Default: Pass to AI Agent
  return { action: 'continue', rule: 'all_passed', reason: 'All stopping rules and timing gates passed', shouldCallAi: true }
}
```

---

## 6. API Ingestion Gateway

Located in `apps/api/src/routes/webhooks.ts`.

### Webhook Route Snippet

```typescript
app.post('/razorpay', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('x-razorpay-signature')

  // Signature verification (sub-millisecond HMAC SHA256)
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

  // Filter non-recovery events
  if (!isAllowedEvent(event)) {
    return c.json({ accepted: true, enqueued: false, reason: 'event_ignored' })
  }

  // Push to BullMQ ingest queue for async processing
  const data: IngestJobData = {
    event,
    payload: (parsed as { payload?: unknown }).payload ?? {},
    receivedAt: new Date().toISOString(),
  }
  await getQueue('ingest').add('razorpay-event', data)

  return c.json({ accepted: true, enqueued: true })
})
```

---

## 7. Worker Pipeline Implementation

### 7.1. Ingest Worker (`apps/worker/src/workers/ingest.worker.ts`)

```typescript
export async function processIngestEvent(data: IngestJobData): Promise<IngestResult> {
  const { event } = data
  const payload = (data.payload as RazorpayWebhookEvent['payload']) ?? {}
  const payment = payload.payment?.entity
  const razorpayPaymentId = extractPaymentId(payload)

  if (!razorpayPaymentId) {
    throw new Error(`ingest: no payment/subscription entity in ${event} event`)
  }

  // Normalize paise to rupees decimal
  const amount = payment
    ? new Prisma.Decimal(payment.amount).div(100)
    : new Prisma.Decimal(0)

  const failureCode = payment?.error_code ?? null
  const failureType = classifyFailure(event, failureCode)

  // 1. Idempotently insert FailedPayment
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
        rawPayload: (data.payload ?? {}) as object,
      },
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { outcome: 'duplicate', failedPaymentId: null, recoveryJobId: null, failureType: null }
    }
    throw err
  }

  // 2. Spawn recovery job record (recovery queue dispatch is wired in a later slice)
  const recoveryJob = await prisma.recoveryJob.create({
    data: {
      failedPaymentId: failedPayment.id,
      status: 'pending',
      failureType,
      maxFollowUps: 2,
    },
  })

  return {
    outcome: 'created',
    failedPaymentId: failedPayment.id,
    recoveryJobId: recoveryJob.id,
    failureType,
  }
}
```

### 7.2. Recovery Worker (`apps/worker/src/workers/recovery.worker.ts`)

*Implementation excerpt showing idempotent state transitions and queue handoffs.*

```typescript
export async function processRecoveryJob(
  data: RecoveryJobData,
  now = new Date(),
): Promise<RecoveryProcessResult> {
  const { recoveryJobId } = data
  const job = await prisma.recoveryJob.findUnique({
    where: { id: recoveryJobId },
    include: {
      failedPayment: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      hitlTasks: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  })

  if (!job) return { outcome: 'not_found', recoveryJobId }

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

  switch (decision.action) {
    case 'stop_recovered': {
      await prisma.$transaction([
        prisma.recoveryJob.update({ where: { id: job.id }, data: { status: 'recovered' } }),
        prisma.recoveryLedger.upsert({
          where: { id: stableUuid(`recovery-ledger:recovered:${job.id}`) },
          create: {
            id: stableUuid(`recovery-ledger:recovered:${job.id}`),
            recoveryJobId: job.id,
            failedPaymentId: job.failedPayment.id,
            amount: job.failedPayment.amount,
            status: 'recovered',
            recoveryMethod: 'retry',
            recoveredAt: now,
          },
          update: {},
        }),
      ])
      break
    }
    case 'stop_unrecovered': {
      await prisma.$transaction([
        prisma.recoveryJob.update({ where: { id: job.id }, data: { status: 'unrecovered' } }),
        prisma.recoveryLedger.upsert({
          where: { id: stableUuid(`recovery-ledger:unrecovered:${job.id}`) },
          create: {
            id: stableUuid(`recovery-ledger:unrecovered:${job.id}`),
            recoveryJobId: job.id,
            failedPaymentId: job.failedPayment.id,
            amount: job.failedPayment.amount,
            status: 'unrecovered',
          },
          update: {},
        }),
      ])
      break
    }
    case 'stop_rejected': {
      await prisma.recoveryJob.update({ where: { id: job.id }, data: { status: 'rejected' } })
      break
    }
    case 'stale': {
      await prisma.recoveryJob.update({ where: { id: job.id }, data: { status: 'stale' } })
      break
    }
    case 'hitl': {
      await prisma.$transaction(async (tx) => {
        await tx.recoveryJob.update({ where: { id: job.id }, data: { status: 'hitl' } })
        await tx.hitlQueue.upsert({
          where: { id: stableUuid(`hitl-task:${job.id}`) },
          create: { id: stableUuid(`hitl-task:${job.id}`), recoveryJobId: job.id, reason: decision.reason, status: 'pending' },
          update: {},
        })
      })
      await getQueue('hitl').add('review', { recoveryJobId: job.id, reason: decision.reason })
      break
    }
    case 'delay': {
      await prisma.recoveryJob.update({
        where: { id: job.id },
        data: { status: 'waiting', nextAttemptAt: decision.nextAttemptAt },
      })
      if (decision.nextAttemptAt) {
        const delayMs = Math.max(decision.nextAttemptAt.getTime() - now.getTime(), 0)
        await getQueue('recovery').add('evaluate-recovery', { recoveryJobId: job.id }, { delay: delayMs })
      }
      break
    }
    case 'continue': {
      await prisma.recoveryJob.update({ where: { id: job.id }, data: { status: 'processing' } })
      break
    }
  }

  return { outcome: 'completed', recoveryJobId: job.id, decision }
}
```

---

## 8. Testing & Verification

The suite covers API, domain rules, and worker database transactions:

1. **`packages/core/test/stopping-rules.test.ts`**:
   - Validates all stopping rules deterministically without DB or network overhead.
   - Tests IST Quiet Hours (`21:00-08:00`), salary windows (`1st-5th`, `25th-28th`), and follow-up gap backoff.
2. **`apps/api/test/webhook.test.ts`**:
   - Verifies HMAC signature authentication and queue enqueuing.
3. **`apps/worker/test/ingest.test.ts`**:
   - Tests idempotent ingestion, paise-to-rupee precision, and duplicate detection via `P2002`.
4. **`apps/worker/test/recovery.test.ts`**:
   - Tests end-to-end database transactions for `RecoveryWorker`, ledger writing, and HITL tasks.
