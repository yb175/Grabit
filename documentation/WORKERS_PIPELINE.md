# Worker Pipeline & Queue Processing

Located in: `apps/worker`  
Shared Queue Library: `packages/queue`  
Tests: `apps/worker/test/ingest.test.ts`, `apps/worker/test/recovery.test.ts`

---

## 1. Queue Architecture & Workers Topology

Grabit uses **BullMQ** on **Redis (Port 6380)** with deterministic queue definitions:

```
                  ┌───────────────────────────────┐
                  │      BullMQ / Redis Queues    │
                  ├───────────────────────────────┤
                  │ grabit:ingest                 │
                  │ grabit:recovery               │
                  │ grabit:hitl                   │
                  │ grabit:message (planned)      │
                  │ grabit:followup (planned)     │
                  └──────────────┬────────────────┘
                                 │
          ┌──────────────────────┴──────────────────────┐
          ▼                                             ▼
┌──────────────────┐                          ┌──────────────────┐
│  Ingest Worker   │                          │ Recovery Worker  │
│  (Concurrency 5) │                          │ (Concurrency 5)  │
└──────────────────┘                          └──────────────────┘
```

---

## 2. Ingest Worker (`apps/worker/src/workers/ingest.worker.ts`)

The Ingest Worker transforms raw Razorpay webhook events into normalized database entities.

```
[ Ingest Job Data ]
        │
        ▼
[ Extract razorpay_payment_id / sub_id ]
        │
        ▼
[ Normalize: Amount in Paise / 100 -> INR Decimal ]
        │
        ▼
[ Classify Failure Source & Failure Type ]
        │
        ▼
[ Upsert FailedPayment ] ──(P2002 Conflict)──> [ Duplicate Webhook Ignored ]
        │
        ▼
[ Create RecoveryJob (status: 'pending', maxFollowUps: 2) ]
```

### Ingestion Details:
- **Paise to Rupees Normalization**: Razorpay amounts in paise (e.g. `100000`) are divided by 100 into exact `Prisma.Decimal` instances (`1000.00`) to avoid floating-point errors.
- **Idempotent Webhook Replay**: If Razorpay delivers the same webhook twice, the database unique constraint on `razorpay_payment_id` throws a `P2002` error, which the worker catches and gracefully acknowledges without failing or duplicating.

---

## 3. Recovery Worker (`apps/worker/src/workers/recovery.worker.ts`)

The Recovery Worker orchestrates state-machine transitions based on the domain stopping rules.

```
[ Recovery Job Received ]
           │
           ▼
[ Load Job, FailedPayment, Last Message, HITL Status ]
           │
           ▼
[ Evaluate @grabit/core Stopping Rules ]
           │
     ┌─────┴──────────────────────────────────────────────────────┐
     ▼                                                            ▼
[ Terminal Actions ]                                     [ Active / Delayed Actions ]
• stop_recovered   ──> status: 'recovered'   + Ledger     • delay    ──> status: 'waiting'    + Delayed Queue
• stop_unrecovered ──> status: 'unrecovered' + Ledger     • hitl     ──> status: 'hitl'       + HITL Queue Task
• stop_rejected    ──> status: 'rejected'    + Audit      • continue ──> status: 'processing' + AI Stage (planned)
• stale            ──> status: 'stale'       + Audit
```

### Idempotency Strategy:
All database mutations inside the Recovery Worker use deterministic UUIDs derived via SHA-1 hashing (`stableUuid`):
- `stableUuid('recovery-ledger:recovered:' + jobId)`
- `stableUuid('recovery-ledger:unrecovered:' + jobId)`
- `stableUuid('hitl-task:' + jobId)`
- `stableUuid('audit:<action>:' + jobId)`

This ensures that replaying a recovery job produces **zero duplicate ledger entries**, **zero duplicate HITL review tasks**, and **zero duplicate audit logs**.

---

## 4. BullMQ Delayed Queue Dispatch

When `decision.action === 'delay'`, the recovery worker schedules a delayed job directly on `grabit:recovery`:

```typescript
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
```

---

## 5. Worker Lifecycle & Graceful Shutdown

Workers register signal handlers on startup (`SIGINT`, `SIGTERM`):
1. Pauses receiving new jobs.
2. Waits for active transactions to complete (`worker.close()`).
3. Closes cached BullMQ queue instances (`closeAllQueues()`).
4. Disconnects Prisma client pool (`prisma.$disconnect()`).
