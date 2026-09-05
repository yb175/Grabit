// Grabit demo helper — fire signed Razorpay webhooks at the local API to
// exercise the real E2E pipeline (signature -> ingest -> rules -> AI ->
// message/ledger/HITL). Env loaded by the npm script (mirrors `demo:batch`).
//
// Usage:
//   pnpm fire:webhook -- [event] [amount] [email] [--pay pay_xxx]
//
// Events (alias -> Razorpay event -> what to expect):
//   fail       payment.failed       soft -> AI -> one_click -> EMAIL sent
//   hard       payment.failed       card_blocked -> stopping rule -> ledger unrecovered, no outreach
//   high       payment.failed       amount >= ₹10,000 -> HITL inbox (no AI)
//   mandate    mandate.revoked      autopay cancelled -> AI -> one-click reauth link -> EMAIL
//   halted     subscription.halted  autopay failed -> AI decision
//   cancelled  subscription.cancelled autopay cancelled -> AI decision
//   captured   payment.captured     fresh id -> ignored (webhook boundary); with --pay <id>
//                                    flips an earlier failed payment to paid
//   paid       order.paid           same as captured
//
// The signature is computed over the EXACT raw body sent (same HMAC-SHA256
// scheme as apps/api/src/lib/razorpay.ts), so a plain curl -d won't verify.

import { createHmac, randomUUID } from 'node:crypto'

const API_URL = process.env.GRABIT_API_URL ?? 'http://localhost:3100'
const WEBHOOK_PATH = '/webhooks/razorpay'
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET

const DEFAULT_EMAIL = 'demo.customer@example.com'
const DEFAULT_AMOUNTS: Record<string, number> = {
  fail: 1499, hard: 1499, high: 42000, mandate: 8900, halted: 2200, cancelled: 3400,
}

const args = process.argv.slice(2).filter((a) => a !== '--')
const payArg = args.findIndex((a) => a === '--pay') >= 0
  ? args[args.indexOf('--pay') + 1]
  : null
const [event = 'fail', amountArg = String(DEFAULT_AMOUNTS[event] ?? 1499), emailArg = DEFAULT_EMAIL] =
  args.filter((a) => a !== '--pay' && a !== payArg)

const rupees = Number(amountArg)
if (!Number.isFinite(rupees) || rupees <= 0) {
  console.error(`[fire:webhook] invalid amount: "${amountArg}" (expect rupees, e.g. 1499)`)
  process.exit(1)
}
if (!SECRET) {
  console.error('[fire:webhook] RAZORPAY_WEBHOOK_SECRET is not set in .env')
  process.exit(1)
}

const EVENT_MAP: Record<string, { event: string; code: string; why: string }> = {
  fail: { event: 'payment.failed', code: 'insufficient_funds', why: 'soft → AI (Gemini) → one_click + mock link → EMAIL sent' },
  'payment.failed': { event: 'payment.failed', code: 'insufficient_funds', why: 'soft → AI (Gemini) → one_click + mock link → EMAIL sent' },
  hard: { event: 'payment.failed', code: 'card_blocked', why: 'hard decline → stopping rule → ledger unrecovered, NO outreach' },
  high: { event: 'payment.failed', code: 'insufficient_funds', why: 'amount ≥ ₹10,000 → HITL inbox (rules, no AI) → approve/reject there' },
  mandate: { event: 'mandate.revoked', code: 'mandate_revoked', why: 'autopay_cancelled → AI → one-click re-auth link → EMAIL' },
  'mandate.revoked': { event: 'mandate.revoked', code: 'mandate_revoked', why: 'autopay_cancelled → AI → one-click re-auth link → EMAIL' },
  halted: { event: 'subscription.halted', code: 'autopay_charge_failed', why: 'autopay_failed → AI decision' },
  'subscription.halted': { event: 'subscription.halted', code: 'autopay_charge_failed', why: 'autopay_failed → AI decision' },
  cancelled: { event: 'subscription.cancelled', code: 'mandate_revoked', why: 'autopay_cancelled → AI decision' },
  'subscription.cancelled': { event: 'subscription.cancelled', code: 'mandate_revoked', why: 'autopay_cancelled → AI decision' },
  captured: { event: 'payment.captured', code: '', why: payArg ? `marks payment ${payArg} as paid` : 'fresh id → ignored (untracked payment)' },
  'payment.captured': { event: 'payment.captured', code: '', why: payArg ? `marks payment ${payArg} as paid` : 'fresh id → ignored (untracked payment)' },
  paid: { event: 'order.paid', code: '', why: 'same as captured' },
  'order.paid': { event: 'order.paid', code: '', why: 'same as captured' },
}

const spec = EVENT_MAP[event]
if (!spec) {
  console.error(`[fire:webhook] unknown event "${event}" — one of: ${Object.keys(EVENT_MAP).join(', ')}`)
  process.exit(1)
}

// Config honesty: email sends need a REAL Razorpay payment link, but mock
// links are refused by the message worker. Warn before firing instead of
// letting the first send fail with a confusing log line.
const SENDS_EMAIL = ['fail', 'payment.failed', 'mandate', 'mandate.revoked', 'halted', 'subscription.halted', 'cancelled', 'subscription.cancelled'].includes(event)
const channel = process.env.MESSAGE_CHANNEL ?? 'mock'
const linksEnabled = process.env.RAZORPAY_PAYMENT_LINK_ENABLED === 'true'
if (SENDS_EMAIL && channel === 'email' && !linksEnabled) {
  console.warn(
    '[fire:webhook] ⚠ MESSAGE_CHANNEL=email refuses mock (example.test) payment links — this send will fail.\n' +
    '  Fix: set MESSAGE_CHANNEL=mock for the log-based demo, or add a fresh test key ' +
    '(RAZORPAY_KEY_ID/KEY_SECRET) with RAZORPAY_PAYMENT_LINK_ENABLED=true for real mail.',
  )
} else if (SENDS_EMAIL && channel === 'mock') {
  console.warn(
    '[fire:webhook] NOTE: MESSAGE_CHANNEL=mock — the send is LOGGED to the worker console, not delivered.\n' +
    '  For real mail: MESSAGE_CHANNEL=email + fresh Razorpay test keys + RAZORPAY_PAYMENT_LINK_ENABLED=true.',
  )
}

const id = randomUUID().replace(/-/g, '')
const paymentId = payArg ?? `pay_${id.slice(0, 16)}`
const orderId = `order_${id.slice(16, 30)}`
const isSubscription = spec.event.startsWith('subscription') || spec.event === 'mandate.revoked'

const entity = {
  id: paymentId,
  entity: 'payment',
  amount: rupees * 100,
  currency: 'INR',
  order_id: orderId,
  status: spec.event.includes('captured') || spec.event === 'order.paid' ? 'captured' : 'failed',
  error_code: spec.code,
  error_description: spec.code === 'card_blocked'
    ? 'Card is blocked and cannot be used for this payment'
    : 'The bank could not process the payment: insufficient funds',
  error_source: 'bank',
  method: 'upi',
  email: emailArg,
  contact: '+919876000999',
  notes: { customer_name: 'Demo Customer' },
  description: 'Payment recovery demo',
}

// Razorpay sends subscription/mandate events with a subscription entity that
// carries payment_id — the ingest worker uses it for dedupe + classification.
// Include payment.entity alongside so processIngestEvent can read amount/email
// for the recovery message (mandate/halted/cancelled events need a recipient).
const payload = isSubscription
  ? {
      subscription: { entity: { id: `sub_${id.slice(0, 14)}`, payment_id: paymentId, status: 'halted', plan_id: 'plan_demo' } },
      payment: { entity },
    }
  : { payment: { entity } }

const body = JSON.stringify({
  entity: 'event',
  account_id: 'acc_test_demo',
  event: spec.event,
  contains: isSubscription ? ['subscription'] : ['payment'],
  payload,
})

const signature = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')

async function main() {
  console.log(`[fire:webhook] ${spec.event} · ${paymentId} · ₹${rupees} · ${emailArg}`)
  console.log(`[fire:webhook] expect: ${spec.why}`)
  console.log(`[fire:webhook] POST ${API_URL}${WEBHOOK_PATH}`)
  try {
    const res = await fetch(`${API_URL}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      body,
    })
    const data = (await res.json()) as Record<string, unknown>
    console.log(`[fire:webhook] -> ${res.status} ${JSON.stringify(data)}`)
    if (!res.ok || data.enqueued !== true) process.exitCode = 1
  } catch (err) {
    console.error(`[fire:webhook] request failed: ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  }
}

main()