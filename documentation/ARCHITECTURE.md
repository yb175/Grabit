# System Architecture & Event Flow

This document details the high-level architecture, component topology, and end-to-end event flow of Grabit.

---

## 1. High-Level Component Topology

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
|  |   1. Ingest Worker    | ---> |    2. Recovery Worker    | ---> |    3. AI Agent Service     |  |
|  |   - Dedupe & Normalize|      |   - Stopping Rules Gate  |      |   (Python/Agno/FastAPI)    |  |
|  |   - Create Failure &  |      |   - Quiet Hours (IST)    |      |   - Failure Diagnosis      |  |
|  |     Recovery Job      |      |   - Salary Window Check  |      |   - Hinglish Copy Gen      |  |
|  +-----------------------+      +-------------+------------+      +-------------+--------------+  |
|                                               |                                 | (Planned)       |
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

The lifecycle of every payment failure flows through six distinct stages:

```
[ Razorpay Failure Event ]
           |
           v
+----------------------+
| 1. Ingest & Verify   | ---> Validate Signature -> Paise-to-INR Conversion -> Idempotently create `failed_payments`
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
           | (Planned)               +----------------------------------------------------------+
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

## 3. Detailed Component Interaction

```
[Merchant / Razorpay]
        │
        │ POST /webhooks/razorpay (HMAC SHA-256)
        ▼
┌──────────────────┐
│   apps/api       │ ──> Sub-millisecond verify, return HTTP 202 Accepted
└────────┬─────────┘
         │ Enqueue raw event
         ▼
┌──────────────────┐
│  grabit:ingest   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Ingest Worker   │ ──> Idempotent DB insert: `failed_payments` & `recovery_jobs` (pending)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ grabit:recovery  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐     Evaluate Stopping Rules
│ Recovery Worker  │ ──────────────────────────────────┐
└────────┬─────────┘                                   │
         │                                             ▼
         │                              ┌─────────────────────────────┐
         │                              │    @grabit/core             │
         │                              │    evaluateStoppingRules()  │
         │                              └──────────────┬──────────────┘
         │                                             │
         ├─────────────────────────────────────────────┘
         │
         ├── Action: 'stop_recovered'   ──> Status: 'recovered'   + RecoveryLedger insert
         ├── Action: 'stop_unrecovered' ──> Status: 'unrecovered' + RecoveryLedger insert
         ├── Action: 'stop_rejected'    ──> Status: 'rejected'    + AuditLog entry
         ├── Action: 'stale'            ──> Status: 'stale'       + AuditLog entry
         ├── Action: 'delay'            ──> Status: 'waiting'     + BullMQ Delayed Job (nextAttemptAt)
         ├── Action: 'hitl'             ──> Status: 'hitl'        + HitlQueue task + grabit:hitl queue
         └── Action: 'continue'         ──> Status: 'processing'  + Handoff to AI Agent (planned)
```
