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

<!-- 
  PASTE ARCHITECTURE DIAGRAM HERE 
  (Main flow diagram)
-->

![Architecture Diagram](./docs/architecture.png)

---

## System Flow =

![System Flow](./docs/system_flow.png)

---

## Database Schema 
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