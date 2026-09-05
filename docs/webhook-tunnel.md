# Razorpay Webhook Tunnel (Local Dev)

Razorpay can only push webhooks to public HTTPS URLs. To test the full
capture→recovered flow locally you need a tunnel.

## ngrok setup (one-time)

```bash
# 1. Install
brew install ngrok/ngrok/ngrok   # macOS; or https://ngrok.com/download

# 2. Authenticate (free account)
ngrok config add-authtoken <YOUR_NGROK_TOKEN>

# 3. Start tunnel (API runs on 3100 by default)
ngrok http 3100
# → Forwarding  https://xxxx-xx-xx-xx-xx.ngrok-free.app -> http://localhost:3100
```

## Razorpay Dashboard configuration

1. Open **Settings → Webhooks** in the Razorpay test-mode dashboard.
2. Add a new webhook:
   - **Webhook URL:** `https://xxxx.ngrok-free.app/webhooks/razorpay`
   - **Secret:** paste the value of `RAZORPAY_WEBHOOK_SECRET` from your `.env`
   - **Active events** (enable all of these):
     - `payment.failed`
     - `payment.captured`
     - `order.paid`
     - `subscription.halted`
     - `subscription.cancelled`
     - `mandate.revoked`

## End-to-end test: fail → pay link → webhook → recovered

```bash
# Terminal 1 — API
pnpm --filter @grabit/api dev

# Terminal 2 — Worker
pnpm --filter @grabit/worker dev

# Terminal 3 — ngrok (keep this running while testing)
ngrok http 3100

# Terminal 4 — fire a soft failure and get a recovery job
pnpm fire:webhook fail 1499 your@email.com
# → check worker logs for: [recovery] job <id> decision: action=continue
# → message worker logs: [message:email] sent / [message:mock] sent recovery message

# Pay the Razorpay test payment link sent to your email (or use test card
# success@razorpay / domestic MC 4111111111111111 / any future expiry / CVV 123)
# → Razorpay fires payment.captured to ngrok URL → API → ingest worker → recovery worker

# Worker logs should show:
# [ingest] payment.captured marked payment <fp_id> (pay_xxx) as paid
# [ingest] payment.captured pay_xxx — job <job_id> found, enqueuing recovery re-evaluation
# [recovery] job <job_id> decision: action=stop_recovered rule=already_recovered

# Dashboard (http://localhost:5173) should show on next 3s poll:
# • Recovered ₹ card increments
# • Recovered cases card increments
# • Job row status → RECOVERED (green pill)
```

## Matching key: how capture finds the right job

The ingest worker looks up the failed payment by `razorpayPaymentId`
(`failed_payments.razorpay_payment_id`), which is the `pay_xxx` id on
both the `payment.captured` and `order.paid` webhook payloads. The
payment link created by Grabit uses the same `pay_xxx` id as the original
failed payment's `razorpay_payment_id` (Razorpay reuses the payment ID on
the re-attempted checkout). If the customer pays via a fresh Razorpay order
the webhook carries the new `pay_yyy` id — that is an untracked payment and
is safely ignored (logged: `id … ignored`).
