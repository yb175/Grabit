# Grabit — Engineering & System Documentation

Welcome to the comprehensive engineering documentation for **Grabit**, an AI-powered Payment Revenue Recovery System.

---

## Documentation Structure

```text
documentation/
├── README.md                  # Overview, tech stack, and module directory
├── ARCHITECTURE.md            # High-level architecture, event flows, and lifecycle diagrams
├── STOPPING_RULES_ENGINE.md   # Deterministic rules, IST smart-timing, quiet hours, salary windows
├── WORKERS_PIPELINE.md        # Webhook ingestion, BullMQ queues, recovery worker & idempotency
└── DATABASE_SCHEMA.md         # Prisma schema, PostgreSQL models, Decimal money handling, audit logs
```

---

## System Overview

Grabit automatically intercepts failed payments (cards, UPI Autopay, netbanking), assesses whether recovery outreach is safe and compliant with business/regulatory stopping rules, schedules intelligent timing windows (salary cycles, quiet hours), and drives recovery workflows while recording an audit log and recovery ledger.

### High-Level Summary of Implemented Modules

| Package / App | Core Responsibilities |
| :--- | :--- |
| **`apps/api`** | Hono HTTP Gateway: Webhook ingestion (`/webhooks/razorpay`), sub-50ms HMAC-SHA256 signature verification, BullMQ enqueueing. |
| **`apps/worker`** | BullMQ workers: `IngestWorker` (normalization, P2002 deduplication) and `RecoveryWorker` (state-machine transactions, delayed scheduling, HITL task creation). |
| **`packages/core`** | Zero-dependency domain engine: Razorpay event classification, deterministic stopping rules (`evaluateStoppingRules`), and IST date/time calculations. |
| **`packages/db`** | PostgreSQL + Prisma ORM: Idempotent models (`failed_payments`, `recovery_jobs`, `hitl_queue`, `recovery_ledger`, `audit_logs`). |
| **`packages/queue`** | Redis + BullMQ queue singleton manager and graceful worker connection lifecycle. |

---

## Quick Navigation

1. [System Architecture & Event Flow](./ARCHITECTURE.md)
2. [Stopping Rules & Smart-Timing Engine](./STOPPING_RULES_ENGINE.md)
3. [Worker Pipeline & Queue Processing](./WORKERS_PIPELINE.md)
4. [Database Models & Ledger Schema](./DATABASE_SCHEMA.md)
