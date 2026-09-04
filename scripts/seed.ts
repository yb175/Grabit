// Grabit demo seed — `pnpm db:seed`
//
// Idempotent demo data for an EMPTY database (local dev / buildathon judges):
//   - 1 recovered case via one-click link (₹1,499) + ledger + message + audit
//   - 1 hard failure stopped with no message (ledger = unrecovered)
//   - 1 HITL pending high-value case (₹42,000 > ₹10k threshold)
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

const LOCAL_HOST = /localhost|127\.0\.0\.1|0\.0\.0\.0/
function assertLocalDb(): void {
  const url = process.env.DATABASE_URL ?? 'postgresql://grabit:grabit@localhost:5433/grabit'
  if (!LOCAL_HOST.test(url)) {
    console.error('[db:seed] Refusing to seed: DATABASE_URL does not point at a local database.')
    process.exit(1)
  }
}

const now = new Date()

// ---------------------------------------------------------------------------
// 1. Recovered via one-click: ₹1,499, soft UPI decline
// ---------------------------------------------------------------------------
async function seedRecoveredOneClick() {
  const paymentId = 'pay_demo_recovered_1499'
  const payment = await prisma.failedPayment.upsert({
    where: { razorpayPaymentId: paymentId },
    update: {
      amount: new Prisma.Decimal(1499),
      isPaid: false,
    },
    create: {
      razorpayPaymentId: paymentId,
      razorpayOrderId: 'order_demo_recovered_1499',
      amount: new Prisma.Decimal(1499),
      currency: 'INR',
      isPaid: false,
      failureCode: 'insufficient_funds',
      failureReason: 'Insufficient balance in account',
      failureSource: 'payment',
      paymentMethod: 'upi',
      customerPhone: '+919876000111',
      customerEmail: 'demo.customer@example.com',
      customerName: 'Aarav Sharma',
      rawPayload: { entity: { id: paymentId, amount: 149900 } },
    },
  })

  const jobId = stableUuid('seed:job:recovered-1499')
  const recoveredAt = new Date(now.getTime() - 26 * 60 * 60 * 1000) // recovered yesterday

  await prisma.recoveryJob.upsert({
    where: { id: jobId },
    update: { status: 'recovered', failureType: 'soft' },
    create: {
      id: jobId,
      failedPaymentId: payment.id,
      status: 'recovered',
      failureType: 'soft',
      followUpCount: 1,
      maxFollowUps: 2,
      priority: 75,
    },
  })

  await prisma.agentDecision.upsert({
    where: { id: stableUuid('seed:decision:recovered-1499') },
    update: {},
    create: {
      id: stableUuid('seed:decision:recovered-1499'),
      recoveryJobId: jobId,
      decisionType: 'one_click',
      explanation: 'Soft decline with salary-window timing — send one-click recovery link.',
      confidence: 0.94,
      modelVersion: 'seed',
      actionPayload: { template: 'recovery_link_v1', urgency: 'medium' },
    },
  })

  await prisma.message.upsert({
    where: { id: stableUuid('seed:message:recovered-1499') },
    update: {},
    create: {
      id: stableUuid('seed:message:recovered-1499'),
      recoveryJobId: jobId,
      channel: 'whatsapp',
      toPhone: '+919876000111',
      messageBody:
        'Hi Aarav! Your payment of ₹1,499 failed due to low balance. Tap here to complete it safely — the link expires in 24h: https://rzp.io/l/demo1499',
      status: 'delivered',
      sentAt: new Date(now.getTime() - 28 * 60 * 60 * 1000),
    },
  })

  await prisma.recoveryLedger.upsert({
    where: { id: stableUuid('seed:ledger:recovered-1499') },
    update: {},
    create: {
      id: stableUuid('seed:ledger:recovered-1499'),
      recoveryJobId: jobId,
      failedPaymentId: payment.id,
      amount: payment.amount,
      status: 'recovered',
      recoveryMethod: 'one_click',
      recoveredAt,
    },
  })

  await prisma.auditLog.upsert({
    where: { id: stableUuid('seed:audit:recovered-1499') },
    update: {},
    create: {
      id: stableUuid('seed:audit:recovered-1499'),
      entityType: 'recovery_jobs',
      entityId: jobId,
      action: 'stop_recovered',
      oldValue: { status: 'waiting' },
      newValue: { status: 'recovered', reason: 'Customer completed one-click recovery link' },
      performedBy: 'recovery_worker',
    },
  })

  return { jobId, amount: 1499 }
}

// ---------------------------------------------------------------------------
// 2. Hard failure stopped, no message sent (ledger = unrecovered)
// ---------------------------------------------------------------------------
async function seedHardStopped() {
  const paymentId = 'pay_demo_hard_stopped'
  const payment = await prisma.failedPayment.upsert({
    where: { razorpayPaymentId: paymentId },
    update: { isPaid: false },
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
    },
  })

  const jobId = stableUuid('seed:job:hard-stopped')
  await prisma.recoveryJob.upsert({
    where: { id: jobId },
    update: { status: 'unrecovered', failureType: 'hard' },
    create: {
      id: jobId,
      failedPaymentId: payment.id,
      status: 'unrecovered',
      failureType: 'hard',
      followUpCount: 0,
      maxFollowUps: 2,
      priority: 60,
    },
  })

  // NO message — hard failures are never contacted.
  await prisma.recoveryLedger.upsert({
    where: { id: stableUuid('seed:ledger:hard-stopped') },
    update: {},
    create: {
      id: stableUuid('seed:ledger:hard-stopped'),
      recoveryJobId: jobId,
      failedPaymentId: payment.id,
      amount: payment.amount,
      status: 'unrecovered',
    },
  })

  await prisma.auditLog.upsert({
    where: { id: stableUuid('seed:audit:hard-stopped') },
    update: {},
    create: {
      id: stableUuid('seed:audit:hard-stopped'),
      entityType: 'recovery_jobs',
      entityId: jobId,
      action: 'stop_unrecovered',
      oldValue: { status: 'pending' },
      newValue: { status: 'unrecovered', reason: 'Hard failure — card blocked, retry will not help. No message sent.' },
      performedBy: 'stopping_rules',
    },
  })

  return { jobId, amount: 7499 }
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
    update: {},
    create: {
      id: stableUuid('seed:hitl:high'),
      recoveryJobId: jobId,
      reason: 'High-value case (₹42,000) exceeds HITL threshold of ₹10,000 — mandates revoked need human decision.',
      status: 'pending',
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
  const waiting = await seedWaitingFollowUp()

  const after = {
    payments: await prisma.failedPayment.count(),
    jobs: await prisma.recoveryJob.count(),
    ledger: await prisma.recoveryLedger.count(),
    messages: await prisma.message.count(),
    hitl: await prisma.hitlQueue.count(),
  }

  const rows = [
    ['recovered one-click', recovered.jobId, `₹${recovered.amount}`],
    ['hard stopped (no message)', hard.jobId, `₹${hard.amount}`],
    ['HITL pending high value', hitl.jobId, `₹${hitl.amount}`],
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