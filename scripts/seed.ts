// Grabit demo seed — `pnpm db:seed`
//
// Idempotent demo data for an EMPTY database (local dev / buildathon judges):
//   - 1 recovered case via one-click link (₹1,499) + ledger + message + audit
//   - 1 hard failure stopped with no message (ledger = unrecovered)
//   - 5 HITL pending cases for the reviewer inbox (high value, low
//     confidence, mandate cancelled, ambiguous intent, timing delay)
//     — each with an AI decision
//   - 1 active waiting follow-up (message sent, next attempt in the future)
//
// Every row uses a deterministic UUID derived from its semantic key (same
// scheme as the recovery worker's stableUuid) with upserts, so re-running
// updates in place and NEVER duplicates rows. FailedPayments upsert on their
// razorpay_payment_id (unique) — also idempotent.
//
// LOCAL ONLY: refuses to run against a non-local DATABASE_URL so it can never
// touch production.

import { createHash } from 'node:crypto'
import { prisma, Prisma } from '@grabit/db'

// Deterministic UUIDv5-style id, identical scheme to apps/worker recovery.worker.
function stableUuid(key: string): string {
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

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])
function assertLocalDb(): void {
  const url = process.env.DATABASE_URL ?? 'postgresql://grabit:grabit@localhost:5433/grabit'
  // Parse and allowlist the hostname — a full-URL substring regex would accept
  // e.g. postgresql://localhost@prod-db.example/grabit and write to prod.
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    console.error('[db:seed] Refusing to seed: DATABASE_URL is not a valid URL.')
    process.exit(1)
  }
  if (!LOCAL_HOSTS.has(host)) {
    console.error(
      `[db:seed] Refusing to seed: DATABASE_URL host "${host}" is not a local database.`,
    )
    process.exit(1)
  }
}

const now = new Date()

// ---------------------------------------------------------------------------
// 1. Recovered via one-click: ₹1,499, soft UPI decline
// ---------------------------------------------------------------------------
async function seedRecoveredOneClick() {
  const paymentId = 'pay_demo_recovered_1499'
  const failedAt = new Date(now.getTime() - 30 * 60 * 1000)
  const jobCreatedAt = new Date(now.getTime() - 29 * 60 * 1000)
  const decisionAt = new Date(now.getTime() - 28 * 60 * 1000)
  const messageAt = new Date(now.getTime() - 27 * 60 * 1000)
  const capturedAt = new Date(now.getTime() - 26 * 60 * 1000)
  const ledgerAt = new Date(capturedAt.getTime() + 1000)
  const payment = await prisma.failedPayment.upsert({
    where: { razorpayPaymentId: paymentId },
    update: {
      amount: new Prisma.Decimal(1499),
      isPaid: true,
      paidAt: capturedAt,
      createdAt: failedAt,
    },
    create: {
      razorpayPaymentId: paymentId,
      razorpayOrderId: 'order_demo_recovered_1499',
      amount: new Prisma.Decimal(1499),
      currency: 'INR',
      isPaid: true,
      paidAt: capturedAt,
      failureCode: 'insufficient_funds',
      failureReason: 'Insufficient balance in account',
      failureSource: 'payment',
      paymentMethod: 'upi',
      customerPhone: '+919876000111',
      customerEmail: 'demo.customer@example.com',
      customerName: 'Aarav Sharma',
      rawPayload: { entity: { id: paymentId, amount: 149900 } },
      createdAt: failedAt,
    },
  })

  const jobId = stableUuid('seed:job:recovered-1499')
  const recoveredAt = capturedAt

  await prisma.recoveryJob.upsert({
    where: { id: jobId },
    update: {
      status: 'recovered',
      failureType: 'soft',
      createdAt: jobCreatedAt,
      paymentLinkId: 'plink_demo_recovered_1499',
      paymentLinkUrl: 'https://rzp.io/l/demo1499',
    },
    create: {
      id: jobId,
      failedPaymentId: payment.id,
      status: 'recovered',
      failureType: 'soft',
      followUpCount: 1,
      maxFollowUps: 2,
      priority: 75,
      paymentLinkId: 'plink_demo_recovered_1499',
      paymentLinkUrl: 'https://rzp.io/l/demo1499',
      createdAt: jobCreatedAt,
    },
  })

  await prisma.agentDecision.upsert({
    where: { id: stableUuid('seed:decision:recovered-1499') },
    update: { createdAt: decisionAt },
    create: {
      id: stableUuid('seed:decision:recovered-1499'),
      recoveryJobId: jobId,
      decisionType: 'one_click',
      explanation: 'Soft decline with salary-window timing — send one-click recovery link.',
      confidence: 0.94,
      modelVersion: 'seed',
      actionPayload: { template: 'recovery_link_v1', urgency: 'medium' },
      createdAt: decisionAt,
    },
  })

  await prisma.message.upsert({
    where: { id: stableUuid('seed:message:recovered-1499') },
    update: { templateName: 'payment_recovery_v2', status: 'delivered', sentAt: messageAt, createdAt: messageAt },
    create: {
      id: stableUuid('seed:message:recovered-1499'),
      recoveryJobId: jobId,
      channel: 'whatsapp',
      toPhone: '+919876000111',
      messageBody:
        'Hi Aarav! Your payment of ₹1,499 failed due to low balance. Tap here to complete it safely — the link expires in 24h: https://rzp.io/l/demo1499',
      templateName: 'payment_recovery_v2',
      status: 'delivered',
      sentAt: messageAt,
      createdAt: messageAt,
    },
  })

  await prisma.recoveryLedger.upsert({
    where: { id: stableUuid('seed:ledger:recovered-1499') },
    update: { amount: payment.amount, status: 'recovered', recoveryMethod: 'one_click', recoveredAt: recoveredAt, createdAt: ledgerAt },
    create: {
      id: stableUuid('seed:ledger:recovered-1499'),
      recoveryJobId: jobId,
      failedPaymentId: payment.id,
      amount: payment.amount,
      status: 'recovered',
      recoveryMethod: 'one_click',
      recoveredAt,
      createdAt: ledgerAt,
    },
  })

  await prisma.auditLog.upsert({
    where: { id: stableUuid('seed:audit:recovered-1499') },
    update: { createdAt: new Date(ledgerAt.getTime() + 1000) },
    create: {
      id: stableUuid('seed:audit:recovered-1499'),
      entityType: 'recovery_jobs',
      entityId: jobId,
      action: 'stop_recovered',
      oldValue: { status: 'waiting' },
      newValue: { status: 'recovered', reason: 'Customer completed one-click recovery link' },
      performedBy: 'recovery_worker',
      createdAt: new Date(ledgerAt.getTime() + 1000),
    },
  })

  return { jobId, publicId: 'job_8f91a2', amount: 1499 }
}

// ---------------------------------------------------------------------------
// 2. Hard failure stopped, no message sent (ledger = unrecovered)
// ---------------------------------------------------------------------------
async function seedHardStopped() {
  const paymentId = 'pay_demo_hard_stopped'
  const failedAt = new Date(now.getTime() - 20 * 60 * 1000)
  const jobCreatedAt = new Date(now.getTime() - 19 * 60 * 1000)
  const stoppedAt = new Date(now.getTime() - 18 * 60 * 1000)
  const payment = await prisma.failedPayment.upsert({
    where: { razorpayPaymentId: paymentId },
    update: { isPaid: false, paidAt: null, createdAt: failedAt },
    create: {
      razorpayPaymentId: paymentId,
      razorpayOrderId: 'order_demo_hard_stopped',
      amount: new Prisma.Decimal(7499),
      currency: 'INR',
      isPaid: false,
      failureCode: 'card_blocked',
      failureReason: 'Card blocked by issuing bank',
      failureSource: 'payment',
      paymentMethod: 'card',
      customerPhone: '+919876000222',
      customerEmail: 'demo.customer2@example.com',
      customerName: 'Priya Nair',
      rawPayload: { entity: { id: paymentId, amount: 749900 } },
      createdAt: failedAt,
    },
  })

  const jobId = stableUuid('seed:job:hard-stopped')
  await prisma.recoveryJob.upsert({
    where: { id: jobId },
    update: { status: 'unrecovered', failureType: 'hard', createdAt: jobCreatedAt },
    create: {
      id: jobId,
      failedPaymentId: payment.id,
      status: 'unrecovered',
      failureType: 'hard',
      followUpCount: 0,
      maxFollowUps: 2,
      priority: 60,
      createdAt: jobCreatedAt,
    },
  })

  // NO message — hard failures are never contacted.
  await prisma.recoveryLedger.upsert({
    where: { id: stableUuid('seed:ledger:hard-stopped') },
    update: { amount: payment.amount, status: 'unrecovered', recoveryMethod: null, createdAt: stoppedAt },
    create: {
      id: stableUuid('seed:ledger:hard-stopped'),
      recoveryJobId: jobId,
      failedPaymentId: payment.id,
      amount: payment.amount,
      status: 'unrecovered',
      createdAt: stoppedAt,
    },
  })

  await prisma.auditLog.upsert({
    where: { id: stableUuid('seed:audit:hard-stopped') },
    update: {
      createdAt: stoppedAt,
      newValue: { status: 'unrecovered', reason: 'Hard failure — card blocked, retry will not help. No outreach.' },
    },
    create: {
      id: stableUuid('seed:audit:hard-stopped'),
      entityType: 'recovery_jobs',
      entityId: jobId,
      action: 'stop_unrecovered',
      oldValue: { status: 'pending' },
      newValue: { status: 'unrecovered', reason: 'Hard failure — card blocked, retry will not help. No outreach.' },
      performedBy: 'stopping_rules',
      createdAt: stoppedAt,
    },
  })

  return { jobId, publicId: 'job_3c72b1', amount: 7499 }
}

// ---------------------------------------------------------------------------
// 3. HITL pending high value: ₹42,000 (threshold ₹10k)
// ---------------------------------------------------------------------------
async function seedHitlHighValue() {
  const paymentId = 'pay_demo_hitl_high'
  const payment = await prisma.failedPayment.upsert({
    where: { razorpayPaymentId: paymentId },
    update: { isPaid: false },
    create: {
      razorpayPaymentId: paymentId,
      razorpayOrderId: 'order_demo_hitl_high',
      amount: new Prisma.Decimal(42000),
      currency: 'INR',
      isPaid: false,
      failureCode: 'mandate_revoked',
      failureReason: 'UPI Autopay mandate revoked by customer',
      failureSource: 'mandate',
      paymentMethod: 'mandate',
      customerPhone: '+919876000333',
      customerEmail: 'demo.customer3@example.com',
      customerName: 'Rohan Verma',
      rawPayload: { entity: { id: paymentId, amount: 4200000 } },
    },
  })

  const jobId = stableUuid('seed:job:hitl-high')
  await prisma.recoveryJob.upsert({
    where: { id: jobId },
    update: { status: 'hitl', failureType: 'autopay_cancelled' },
    create: {
      id: jobId,
      failedPaymentId: payment.id,
      status: 'hitl',
      failureType: 'autopay_cancelled',
      followUpCount: 0,
      maxFollowUps: 2,
      priority: 100,
    },
  })

  await prisma.hitlQueue.upsert({
    where: { id: stableUuid('seed:hitl:high') },
    // Reset review fields too: if a reviewer already approved/rejected the
    // task, a re-run must restore it to a genuinely pending state — otherwise
    // the job is `hitl` but the queue row is terminal and invisible.
    update: { status: 'pending', reviewedBy: null, reviewedAt: null, notes: null },
    create: {
      id: stableUuid('seed:hitl:high'),
      recoveryJobId: jobId,
      reason: 'High-value case (₹42,000) exceeds HITL threshold of ₹10,000 — mandates revoked need human decision.',
      status: 'pending',
    },
  })

  // AI decision that triggered the escalation — powers the inbox's
  // "AI Decision / Confidence" columns (GET /hitl returns latest decision).
  await prisma.agentDecision.upsert({
    where: { id: stableUuid('seed:decision:hitl-high') },
    update: { createdAt: now, confidence: 0.82 },
    create: {
      id: stableUuid('seed:decision:hitl-high'),
      recoveryJobId: jobId,
      decisionType: 'escalate_hitl',
      explanation: "High-value case (₹42,000) exceeds HITL threshold of ₹10,000 — mandates revoked need human decision.",
      confidence: 0.82,
      modelVersion: 'seed',
      actionPayload: { template: 'hitl_review_v1', urgency: 'high' },
      createdAt: now,
    },
  })

  await prisma.auditLog.upsert({
    where: { id: stableUuid('seed:audit:hitl-high') },
    update: {},
    create: {
      id: stableUuid('seed:audit:hitl-high'),
      entityType: 'recovery_jobs',
      entityId: jobId,
      action: 'escalated_hitl',
      oldValue: { status: 'pending' },
      newValue: { status: 'hitl', reason: 'Amount exceeds HITL threshold' },
      performedBy: 'stopping_rules',
    },
  })

  return { jobId, amount: 42000 }
}

// ---------------------------------------------------------------------------
// 3b. HITL pending low confidence: ₹3,400, AI said retry at only 0.58
// ---------------------------------------------------------------------------
async function seedHitlLowConfidence() {
  const paymentId = 'pay_demo_hitl_lowconf'
  const payment = await prisma.failedPayment.upsert({
    where: { razorpayPaymentId: paymentId },
    update: { isPaid: false },
    create: {
      razorpayPaymentId: paymentId,
      razorpayOrderId: 'order_demo_hitl_lowconf',
      amount: new Prisma.Decimal(3400),
      currency: 'INR',
      isPaid: false,
      failureCode: 'debit_failed',
      failureReason: 'Debit failed, insufficient funds at bank',
      failureSource: 'payment',
      paymentMethod: 'upi',
      customerPhone: '+919876000555',
      customerEmail: 'demo.customer5@example.com',
      customerName: 'Ananya Iyer',
      rawPayload: { entity: { id: paymentId, amount: 340000 } },
    },
  })

  const jobId = stableUuid('seed:job:hitl-lowconf')
  await prisma.recoveryJob.upsert({
    where: { id: jobId },
    update: { status: 'hitl', failureType: 'soft' },
    create: {
      id: jobId,
      failedPaymentId: payment.id,
      status: 'hitl',
      failureType: 'soft',
      followUpCount: 0,
      maxFollowUps: 2,
      priority: 60,
    },
  })

  await prisma.hitlQueue.upsert({
    where: { id: stableUuid('seed:hitl:lowconf') },
    update: { status: 'pending', reviewedBy: null, reviewedAt: null, notes: null },
    create: {
      id: stableUuid('seed:hitl:lowconf'),
      recoveryJobId: jobId,
      reason: 'Low-confidence decision (AI confidence 0.58 < 0.70 threshold) — retry plan needs human check.',
      status: 'pending',
    },
  })

  await prisma.agentDecision.upsert({
    where: { id: stableUuid('seed:decision:hitl-lowconf') },
    update: {},
    create: {
      id: stableUuid('seed:decision:hitl-lowconf'),
      recoveryJobId: jobId,
      decisionType: 'retry',
      explanation: 'Soft decline, low balance — retry recommended, but model confidence too low to act alone.',
      confidence: 0.58,
      modelVersion: 'seed',
      actionPayload: { template: 'retry_v1', urgency: 'medium' },
      createdAt: now,
    },
  })

  return { jobId, amount: 3400 }
}

// ---------------------------------------------------------------------------
// 3c. HITL pending mandate cancelled: ₹8,900, one-click link, high confidence
// ---------------------------------------------------------------------------
async function seedHitlMandateCancelled() {
  const paymentId = 'pay_demo_hitl_mandate'
  const payment = await prisma.failedPayment.upsert({
    where: { razorpayPaymentId: paymentId },
    update: { isPaid: false },
    create: {
      razorpayPaymentId: paymentId,
      razorpayOrderId: 'order_demo_hitl_mandate',
      amount: new Prisma.Decimal(8900),
      currency: 'INR',
      isPaid: false,
      failureCode: 'mandate_revoked',
      failureReason: 'UPI Autopay mandate revoked by customer',
      failureSource: 'mandate',
      paymentMethod: 'mandate',
      customerPhone: '+919876000666',
      customerEmail: 'demo.customer6@example.com',
      customerName: 'Kiran Rao',
      rawPayload: { entity: { id: paymentId, amount: 890000 } },
    },
  })

  const jobId = stableUuid('seed:job:hitl-mandate')
  await prisma.recoveryJob.upsert({
    where: { id: jobId },
    update: { status: 'hitl', failureType: 'autopay_cancelled' },
    create: {
      id: jobId,
      failedPaymentId: payment.id,
      status: 'hitl',
      failureType: 'autopay_cancelled',
      followUpCount: 0,
      maxFollowUps: 2,
      priority: 70,
    },
  })

  await prisma.hitlQueue.upsert({
    where: { id: stableUuid('seed:hitl:mandate') },
    update: { status: 'pending', reviewedBy: null, reviewedAt: null, notes: null },
    create: {
      id: stableUuid('seed:hitl:mandate'),
      recoveryJobId: jobId,
      reason: 'Mandate cancelled by customer — sending a one-click recovery link needs human sign-off (policy).',
      status: 'pending',
    },
  })

  await prisma.agentDecision.upsert({
    where: { id: stableUuid('seed:decision:hitl-mandate') },
    update: {},
    create: {
      id: stableUuid('seed:decision:hitl-mandate'),
      recoveryJobId: jobId,
      decisionType: 'one_click',
      explanation: 'Mandate cancelled — one-click recovery link re-establishes payment intent; send after human approval.',
      confidence: 0.88,
      modelVersion: 'seed',
      actionPayload: { template: 'recovery_link_v2', urgency: 'high' },
      createdAt: now,
    },
  })

  return { jobId, amount: 8900 }
}

// ---------------------------------------------------------------------------
// 3d. HITL pending ambiguous customer intent: ₹6,200, AI said stop at 0.79
// ---------------------------------------------------------------------------
async function seedHitlAmbiguousIntent() {
  const paymentId = 'pay_demo_hitl_ambiguous'
  const payment = await prisma.failedPayment.upsert({
    where: { razorpayPaymentId: paymentId },
    update: { isPaid: false },
    create: {
      razorpayPaymentId: paymentId,
      razorpayOrderId: 'order_demo_hitl_ambiguous',
      amount: new Prisma.Decimal(6200),
      currency: 'INR',
      isPaid: false,
      failureCode: 'payment_disputed',
      failureReason: 'Customer disputed the charge — intent unclear',
      failureSource: 'payment',
      paymentMethod: 'card',
      customerPhone: '+919876000777',
      customerEmail: 'demo.customer7@example.com',
      customerName: 'Farhan Ali',
      rawPayload: { entity: { id: paymentId, amount: 620000 } },
    },
  })

  const jobId = stableUuid('seed:job:hitl-ambiguous')
  await prisma.recoveryJob.upsert({
    where: { id: jobId },
    update: { status: 'hitl', failureType: 'hard' },
    create: {
      id: jobId,
      failedPaymentId: payment.id,
      status: 'hitl',
      failureType: 'hard',
      followUpCount: 0,
      maxFollowUps: 2,
      priority: 40,
    },
  })

  await prisma.hitlQueue.upsert({
    where: { id: stableUuid('seed:hitl:ambiguous') },
    update: { status: 'pending', reviewedBy: null, reviewedAt: null, notes: null },
    create: {
      id: stableUuid('seed:hitl:ambiguous'),
      recoveryJobId: jobId,
      reason: 'Ambiguous customer intent — charge disputed; recommend stopping outreach until a human confirms.',
      status: 'pending',
    },
  })

  await prisma.agentDecision.upsert({
    where: { id: stableUuid('seed:decision:hitl-ambiguous') },
    update: {},
    create: {
      id: stableUuid('seed:decision:hitl-ambiguous'),
      recoveryJobId: jobId,
      decisionType: 'stop',
      explanation: 'Customer disputed the charge — sending recovery outreach could escalate; recommend human review before contacting.',
      confidence: 0.79,
      modelVersion: 'seed',
      actionPayload: { template: 'no_outreach', urgency: 'low' },
      createdAt: now,
    },
  })

  return { jobId, amount: 6200 }
}

// ---------------------------------------------------------------------------
// 3e. HITL pending timing delay: ₹2,200, AI wants salary-window resend
// ---------------------------------------------------------------------------
async function seedHitlTimingDelay() {
  const paymentId = 'pay_demo_hitl_timing'
  const payment = await prisma.failedPayment.upsert({
    where: { razorpayPaymentId: paymentId },
    update: { isPaid: false },
    create: {
      razorpayPaymentId: paymentId,
      razorpayOrderId: 'order_demo_hitl_timing',
      amount: new Prisma.Decimal(2200),
      currency: 'INR',
      isPaid: false,
      failureCode: 'autopay_charge_failed',
      failureReason: 'Autopay charge failed, transient bank issue',
      failureSource: 'mandate',
      paymentMethod: 'mandate',
      customerPhone: '+919876000888',
      customerEmail: 'demo.customer8@example.com',
      customerName: 'Meera Nair',
      rawPayload: { entity: { id: paymentId, amount: 220000 } },
    },
  })

  const jobId = stableUuid('seed:job:hitl-timing')
  await prisma.recoveryJob.upsert({
    where: { id: jobId },
    update: { status: 'hitl', failureType: 'autopay_failed' },
    create: {
      id: jobId,
      failedPaymentId: payment.id,
      status: 'hitl',
      failureType: 'autopay_failed',
      followUpCount: 0,
      maxFollowUps: 2,
      priority: 30,
    },
  })

  await prisma.hitlQueue.upsert({
    where: { id: stableUuid('seed:hitl:timing') },
    update: { status: 'pending', reviewedBy: null, reviewedAt: null, notes: null },
    create: {
      id: stableUuid('seed:hitl:timing'),
      recoveryJobId: jobId,
      reason: 'Timing decision needs human sign-off — AI wants to resend during the salary window (next attempt at 10:00 tomorrow).',
      status: 'pending',
    },
  })

  await prisma.agentDecision.upsert({
    where: { id: stableUuid('seed:decision:hitl-timing') },
    update: {},
    create: {
      id: stableUuid('seed:decision:hitl-timing'),
      recoveryJobId: jobId,
      decisionType: 'delay',
      explanation: 'Transient autopay failure near payroll cycle — delay outreach to salary window for higher success odds.',
      confidence: 0.71,
      modelVersion: 'seed',
      actionPayload: { template: 'delayed_retry_v1', urgency: 'low' },
      createdAt: now,
    },
  })

  return { jobId, amount: 2200 }
}

// ---------------------------------------------------------------------------
// 4. Active waiting follow-up: ₹599, message sent, next attempt tomorrow
// ---------------------------------------------------------------------------
async function seedWaitingFollowUp() {
  const paymentId = 'pay_demo_waiting_fu'
  const payment = await prisma.failedPayment.upsert({
    where: { razorpayPaymentId: paymentId },
    update: { isPaid: false },
    create: {
      razorpayPaymentId: paymentId,
      razorpayOrderId: 'order_demo_waiting_fu',
      amount: new Prisma.Decimal(599),
      currency: 'INR',
      isPaid: false,
      failureCode: 'debit_failed',
      failureReason: 'Debit failed, insufficient funds at bank',
      failureSource: 'payment',
      paymentMethod: 'upi',
      customerPhone: '+919876000444',
      customerEmail: 'demo.customer4@example.com',
      customerName: 'Sana Khan',
      rawPayload: { entity: { id: paymentId, amount: 59900 } },
    },
  })

  const jobId = stableUuid('seed:job:waiting-fu')
  const nextAttemptAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  await prisma.recoveryJob.upsert({
    where: { id: jobId },
    update: { status: 'waiting', nextAttemptAt },
    create: {
      id: jobId,
      failedPaymentId: payment.id,
      status: 'waiting',
      failureType: 'soft',
      followUpCount: 1,
      maxFollowUps: 2,
      nextAttemptAt,
      priority: 50,
    },
  })

  await prisma.message.upsert({
    where: { id: stableUuid('seed:message:waiting-fu') },
    update: {},
    create: {
      id: stableUuid('seed:message:waiting-fu'),
      recoveryJobId: jobId,
      channel: 'whatsapp',
      toPhone: '+919876000444',
      messageBody:
        'Hi Sana! Your payment of ₹599 could not be completed. No action needed now — we will retry this evening. Reply HELP if you need anything.',
      status: 'delivered',
      sentAt: new Date(now.getTime() - 30 * 60 * 1000),
    },
  })

  await prisma.auditLog.upsert({
    where: { id: stableUuid('seed:audit:waiting-fu') },
    update: {},
    create: {
      id: stableUuid('seed:audit:waiting-fu'),
      entityType: 'recovery_jobs',
      entityId: jobId,
      action: 'scheduled_delay',
      oldValue: { status: 'processing' },
      newValue: { status: 'waiting', nextAttemptAt: nextAttemptAt.toISOString(), reason: 'Follow-up 1 sent; wait 24h before follow-up 2.' },
      performedBy: 'stopping_rules',
    },
  })

  return { jobId, amount: 599 }
}

async function main() {
  assertLocalDb()

  const before = {
    payments: await prisma.failedPayment.count(),
    jobs: await prisma.recoveryJob.count(),
    ledger: await prisma.recoveryLedger.count(),
    messages: await prisma.message.count(),
    hitl: await prisma.hitlQueue.count(),
  }

  const recovered = await seedRecoveredOneClick()
  const hard = await seedHardStopped()
  const hitl = await seedHitlHighValue()
  const hitlLowConf = await seedHitlLowConfidence()
  const hitlMandate = await seedHitlMandateCancelled()
  const hitlAmbiguous = await seedHitlAmbiguousIntent()
  const hitlTiming = await seedHitlTimingDelay()
  const waiting = await seedWaitingFollowUp()

  const after = {
    payments: await prisma.failedPayment.count(),
    jobs: await prisma.recoveryJob.count(),
    ledger: await prisma.recoveryLedger.count(),
    messages: await prisma.message.count(),
    hitl: await prisma.hitlQueue.count(),
  }

  const rows = [
    ['recovered one-click', recovered.publicId, `₹${recovered.amount}`],
    ['hard stopped (no message)', hard.publicId, `₹${hard.amount}`],
    ['HITL high value', hitl.jobId, `₹${hitl.amount}`],
    ['HITL low confidence', hitlLowConf.jobId, `₹${hitlLowConf.amount}`],
    ['HITL mandate cancelled', hitlMandate.jobId, `₹${hitlMandate.amount}`],
    ['HITL ambiguous intent', hitlAmbiguous.jobId, `₹${hitlAmbiguous.amount}`],
    ['HITL timing delay', hitlTiming.jobId, `₹${hitlTiming.amount}`],
    ['waiting follow-up', waiting.jobId, `₹${waiting.amount}`],
  ]
  const width = Math.max(...rows.map((r) => r[0].length))
  console.log('\n[db:seed] seeded demo cases:')
  for (const [name, id, amount] of rows) {
    console.log(`  ${name.padEnd(width)}  ${amount.padStart(10)}  ${id}`)
  }
  console.log(`\n[db:seed] rows before -> after:`)
  for (const key of Object.keys(before) as Array<keyof typeof before>) {
    const delta = after[key] - before[key]
    console.log(`  ${key.padEnd(9)} ${before[key]} -> ${after[key]} (${delta >= 0 ? '+' : ''}${delta})`)
  }
  console.log('\n[db:seed] done. Idempotent — re-running updates in place, no duplicates.')
}

main()
  .catch((err) => {
    console.error('[db:seed] failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })