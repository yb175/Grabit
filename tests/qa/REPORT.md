# Grabit QA Report — Sections A, B, C

Date: 2026-09-03  
Branch: `feat/ai-agent-gemini-3.1-flash`  
Scope: webhook/ingest, stopping rules, and AI-agent contract only. Messaging and ledger/dashboard behavior were not tested.

## Environment and evidence

- PostgreSQL and Redis started with `docker compose -f infra/docker-compose.yml up -d postgres redis`.
- FastAPI agent ran on `127.0.0.1:8001` with the supplied key from `.env`.
- API ran on `127.0.0.1:3100`; worker ran from `apps/worker`.
- Active model: `gemini-3.1-flash-lite-preview`.
- Keys were never printed or stored in snapshots.
- Evidence snapshots: `tests/qa/snapshots/`.

## What is implemented vs stubbed

Implemented:

- Hono Razorpay webhook route with raw-body HMAC verification, event allowlist, malformed-JSON handling, and BullMQ ingest enqueue.
- IngestWorker normalization, rupees conversion, DB persistence, duplicate payment-id handling, payment capture/success idempotent status updates, and recovery enqueue.
- Deterministic stopping rules for recovered, max-follow-up, hard failure, quiet hours, salary window, stale, HITL, and rejected states.
- TS-side Razorpay status adapter and pre-AI paid check in RecoveryWorker (Scenario B6).
- FastAPI `POST /v1/decide`, strict Pydantic schema, deterministic taxonomy, Gemini provider, fallback, and guardrails.
- RecoveryWorker calls the agent only after `continue`; agent metadata is persisted to `agent_decisions` and `audit_logs`.

Stubbed or incomplete for this scope:

- The message worker is a stub; intentionally not tested.
- There is no dedicated automated QA suite under `tests/qa`; evidence below comes from the existing API/core/worker/Python tests and targeted black-box runs.

## A. Ingest / webhook

| Case | Input / evidence | Expected | Actual | Result |
|---|---|---|---|---|
| A1 Valid payment.failed + valid signature | Generated Razorpay-style UPI payload; valid HMAC; DB query | HTTP 200, one failed payment and recovery job | HTTP 200; payment `amount=1499.00` rupees; one job; initial worker processing observed as `waiting` because the live clock was in quiet hours | **PASS** |
| A2 Invalid signature | Same route, `x-razorpay-signature: bad` | 4xx, no DB row | `401 {"error":"invalid_signature"}` | **PASS** |
| A2 Missing signature | Same route without signature | 4xx, no DB row | `401 {"error":"invalid_signature"}` | **PASS** |
| A3 Duplicate payment id | Same signed payload submitted twice; DB count query | No second payment/job | Both HTTP responses were accepted; DB counts were `failed_payments=1`, `recovery_jobs=1` | **PASS** |
| A4 Irrelevant event | Signed `order.paid` payload | HTTP 200, ignored, no job | `200 {"accepted":true,"enqueued":false,"reason":"event_ignored"}` | **PASS** |
| A5 Malformed JSON | Valid HMAC over `not-json` | 4xx; worker remains alive | `400 {"error":"invalid_json"}`; API/worker remained running | **PASS** |

### A replay commands

```sh
docker compose -f infra/docker-compose.yml up -d postgres redis
pnpm --filter @grabit/worker start
pnpm --filter @grabit/api start
# In another shell, sign the exact raw body with RAZORPAY_WEBHOOK_SECRET:
curl -i -H "x-razorpay-signature: <hmac>" \
  -H 'content-type: application/json' \
  --data-binary @tests/fixtures/razorpay/payment.failed.insufficient_funds.json \
  http://127.0.0.1:3100/webhooks/razorpay
```

Reusable redacted fixtures are now available under `tests/fixtures/razorpay/`; replace `<unique>` with a fresh payment/subscription id before replaying. The live run used equivalent unique payloads.

## B. Stopping rules

The deterministic core suite covers the frozen-time cases. Commands:

```sh
pnpm --filter @grabit/core test
pnpm --filter @grabit/worker test
```

| Case | Expected | Actual / evidence | Result |
|---|---|---|---|
| B1 Hard decline / stolen_card / do_not_honor | stop or HITL, never one-click | Core hard-failure test stops unrecovered; live agent guardrails returned hard + `escalate_hitl`, never one-click | **PASS** |
| B2 follow_up_count >= 2 | unrecovered/stopped, no AI path | Worker test returned `stop_unrecovered`, rule `max_followups_exceeded`; `shouldCallAi=false` | **PASS** |
| B3 Quiet hours | delay to morning | Frozen core/worker test returned `delay`, next attempt `08:00 IST` | **PASS** |
| B4 Soft low balance outside salary window | delay toward 1–5 or 25–28 | Frozen core tests returned `delay`, rule `salary_window`, including next-month rollover | **PASS** |
| B5 24h no response | stale | Worker/core tests returned `stale`, rule `stale_timeout` | **PASS** |
| B6 Already paid | stop before AI | `FailedPayment.isPaid` persisted in schema; `payment.captured` webhooks update `isPaid` idempotently; `RecoveryWorker` resolves payment status before stopping rules; stopping rules return `stop_recovered` and call AI zero times | **PASS** |
| B7 HITL rejected | rejected/stopped | Frozen core test returned `stop_rejected`, rule `hitl_rejected` | **PASS** |
| B8 High amount / low confidence | HITL, no auto-send | High-value worker test returned `hitl`; Python guardrail escalates amounts `>=10000` and confidence `<0.55`; no message queue assertion was made because messaging is out of scope | **PASS** |

## C. AI agent contract

Live contract command:

```sh
set -a; . ./.env; set +a
export LLM_PROVIDER=gemini LLM_API_KEY="$GEMINI_API_KEY"
cd apps/ai-agent
python3 -m app.scripts.e2e_pipeline
python3 -m pytest -q tests
```

| Case | Expected | Actual | Result |
|---|---|---|---|
| C1 Soft UPI insufficient funds | soft; one-click/delay/HITL | `soft`, `one_click`, confidence `0.98`, taxonomy tool used | **PASS** |
| C2 Hard card decline | hard; stop/HITL, never one-click | `hard`, `escalate_hitl`; guardrail prevents one-click | **PASS** |
| C3 Autopay failed, mandate active | autopay_failed | `autopay_failed`; taxonomy match enforced | **PASS** |
| C4 Autopay cancelled/revoked | autopay_cancelled + stop | `autopay_cancelled`, `stop`; message empty | **PASS** |
| C5 Invented action | reject + fallback | Guardrail rejects extra keys such as `offer_discount`; fallback is bounded HITL | **PASS** |
| C6 Agent down/timeout/invalid JSON | fallback, no crash | No-key/agent-down tests return bounded fallback; worker catches fetch/JSON failures | **PASS** |
| C7 Prompt injection in failure reason | only allowlisted decision | Injection containing `give_discount` and `retry_5_times` returned `soft`, `one_click`; output contained neither invented action | **PASS** |

C snapshots from the live run are in `apps/ai-agent/tests/snapshots/`; QA-level redacted records are in `tests/qa/snapshots/`.

## Overall result

- PASS: 21 cases
- BLOCKED: 0 cases
- FAIL: 0 cases
