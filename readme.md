# Grabit

> Recover payments. Reconnect trust. Grow revenue.

Grabit is an AI-powered **Revenue Recovery Agent**.

It automatically detects failed payments and Autopay failures, diagnoses why they failed, and takes the smartest next action to recover the money — with personalized messages, perfect timing, and clear stopping rules.

---

## The Problem

Every day, merchants lose revenue because of:

- Soft declines (low balance, temporary issues)
- Hard declines
- UPI Autopay failures
- Mandate cancellations

Most systems just send a generic “Payment failed” message and stop.  
Customers get confused, merchants lose money, and recovery rates stay low.

---

## What Grabit Does

Grabit closes the loop:

1. **Detects** payment & Autopay failures in real time
2. **Diagnoses** the failure type (Hard / Soft / Autopay Failed / Autopay Cancelled)
3. **Decides** the right action using AI + business rules
4. **Acts** with personalized one-click recovery messages
5. **Times** the message intelligently (salary windows, quiet hours, retry gaps)
6. **Stops** cleanly when it should (max attempts, human escalation, etc.)
7. **Measures** everything in a Recovery Ledger + Dashboard

---

## Key Features

- Smart failure classification
- Personalized GenZ/Hinglish explanations + one-click recovery
- Smart Timing Intelligence (salary cycle aware)
- Human-in-the-Loop (HITL) for high-value or unclear cases
- Strict Stopping Rules
- Full audit trail
- Clear recovery metrics for merchants

---

## High Level Architecture

The architecture is built around an event-driven, decoupled pipeline designed for high-throughput webhook ingestion, deterministic rule evaluation, AI-driven recovery messaging, and double-entry financial ledgering.

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
|   - Signature verification & payload sanitization                                                 |
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

![Architecture Diagram](./docs/architecture.png)

---

## System Flow

The end-to-end recovery lifecycle follows an automated 6-step state transition:

```
[ Razorpay Failure Event ]
           |
           v
+----------------------+
| 1. Ingest & Verify   | ---> Validate Signature -> Paise-to-INR Conversion -> Upsert `failed_payments`
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

![System Flow](./docs/system_flow.png)

---

## Database Schema

The database model is strictly relational with foreign key integrity, double-entry audit logging, and normalized Decimal money handling (stored in INR Rupees).

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

![Db Schema](./docs/db_schema.png)

## Tech Stack

| Layer              | Choice                          |
|--------------------|---------------------------------|
| Main API           | TypeScript + Hono               |
| Background Jobs    | BullMQ + Redis                  |
| Database           | PostgreSQL + Prisma             |
| AI Agent           | Python + Agno + FastAPI         |
| Monorepo           | pnpm workspaces                 |

---

## Project Structure

```text
grabit/
├── apps/
│   ├── api/            # Hono API
│   ├── worker/         # BullMQ workers
│   └── ai-agent/       # Python + Agno service
├── packages/
│   ├── db/             # Prisma schema & client
│   ├── queue/          # BullMQ helpers
│   ├── core/           # Shared business logic
│   └── config/
├── infra/
└── docs/               # Architecture diagrams & screenshots
```

---

## Screenshots & Demo

<!-- 
  Add screenshots / demo gifs here later
-->

- Dashboard  
- Recovery Ledger  
- Sample recovery message  
- HITL queue  

---

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm (`npm i -g pnpm`)
- Docker (for Postgres + Redis)

### 1. Start the infrastructure

```bash
docker compose -f infra/docker-compose.yml up -d
```

Brings up:

| Service   | Port |
|-----------|------|
| Postgres  | 5433 |
| Redis     | 6380 |
| AI Agent  | 8001 |

> Ports differ from the usual 5432/6379 to avoid conflicts with other local projects.

### 2. Install dependencies & generate the Prisma client

```bash
pnpm install
pnpm --filter @grabit/db exec prisma generate
```

### 3. Push the schema to the database

```bash
DATABASE_URL="postgresql://grabit:grabit@localhost:5433/grabit" \
  pnpm --filter @grabit/db exec prisma db push
```

(Or copy `.env.example` to `.env` and skip the inline `DATABASE_URL`.)

### 4. Start the API

```bash
DATABASE_URL="postgresql://grabit:grabit@localhost:5433/grabit" pnpm dev:api
```

### 5. Test it

```bash
curl http://localhost:3100/health
```

Expected:

```json
{"status":"ok","service":"grabit-api","database":"connected"}
```

### Stopping

```bash
# API: Ctrl+C in its terminal

docker compose -f infra/docker-compose.yml down     # stop containers
docker compose -f infra/docker-compose.yml down -v  # also wipe Postgres data
```

---

## Status

Currently in active development 