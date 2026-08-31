import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateStoppingRules,
  toISTComponents,
  fromISTComponents,
  isInsideQuietHours,
  getNextQuietHoursEnd,
  isInsideSalaryWindow,
  getNextSalaryWindowDate,
  formatISTDate,
  parseAmount,
  DEFAULT_STOPPING_RULES_CONFIG,
} from '../src/stopping-rules.js'

// Helper to create a base job & payment for testing
function createBaseFixture() {
  return {
    job: {
      id: 'job-123',
      status: 'pending',
      failureType: 'soft',
      followUpCount: 0,
      maxFollowUps: 2,
      createdAt: fromISTComponents(2025, 5, 10, 10, 0, 0), // May 10, 2025 10:00 IST
    },
    payment: {
      id: 'pay-123',
      razorpayPaymentId: 'pay_test_001',
      amount: 1500, // ₹1,500
      currency: 'INR',
      failureCode: 'insufficient_funds',
      failureReason: 'Insufficient balance',
      failureSource: 'payment',
      createdAt: fromISTComponents(2025, 5, 10, 10, 0, 0),
    },
    now: fromISTComponents(2025, 5, 10, 11, 0, 0), // May 10, 2025 11:00 IST (Daytime)
  }
}

// ---------------------------------------------------------------------------
// 1. Hard Failure Stop
// ---------------------------------------------------------------------------
test('Rule 1: Hard failure (failureType=hard) stops unrecovered without retries', () => {
  const { job, payment, now } = createBaseFixture()
  job.failureType = 'hard'
  payment.failureCode = 'card_blocked'

  const decision = evaluateStoppingRules({ job, payment, now })
  assert.equal(decision.action, 'stop_unrecovered')
  assert.equal(decision.rule, 'hard_failure')
  assert.equal(decision.shouldCallAi, false)
  assert.match(decision.reason, /Hard payment failure/)
})

test('Rule 1: Known hard decline codes (card_blocked, fraudulent, invalid_card, invalid_vpa, authorization_denied) stop immediately', () => {
  const hardCodes = ['card_blocked', 'fraudulent', 'invalid_card', 'invalid_vpa', 'authorization_denied']
  for (const code of hardCodes) {
    const { job, payment, now } = createBaseFixture()
    job.failureType = 'soft' // even if job classifier had soft
    payment.failureCode = code

    const decision = evaluateStoppingRules({ job, payment, now })
    assert.equal(decision.action, 'stop_unrecovered')
    assert.equal(decision.rule, 'hard_failure')
    assert.equal(decision.shouldCallAi, false)
  }
})

// ---------------------------------------------------------------------------
// 2. Max Follow-ups
// ---------------------------------------------------------------------------
test('Rule 2: follow_up_count >= max_follow_ups stops unrecovered', () => {
  const { job, payment, now } = createBaseFixture()
  job.followUpCount = 2
  job.maxFollowUps = 2

  const decision = evaluateStoppingRules({ job, payment, now })
  assert.equal(decision.action, 'stop_unrecovered')
  assert.equal(decision.rule, 'max_followups_exceeded')
  assert.equal(decision.shouldCallAi, false)
  assert.match(decision.reason, /Maximum follow-up attempts \(2\) reached/)
})

test('Rule 2: follow_up_count >= 3 with default maxFollowUps stops unrecovered', () => {
  const { job, payment, now } = createBaseFixture()
  job.followUpCount = 3
  delete (job as any).maxFollowUps

  const decision = evaluateStoppingRules({ job, payment, now })
  assert.equal(decision.action, 'stop_unrecovered')
  assert.equal(decision.rule, 'max_followups_exceeded')
})

// ---------------------------------------------------------------------------
// 3. Quiet Hours (21:00 to 08:00 IST)
// ---------------------------------------------------------------------------
test('Rule 3: Message attempt during quiet hours (22:30 IST) is delayed to 08:00 IST next morning', () => {
  const { job, payment } = createBaseFixture()
  const nightTime = fromISTComponents(2025, 5, 10, 22, 30, 0) // 10:30 PM IST

  const decision = evaluateStoppingRules({ job, payment, now: nightTime })
  assert.equal(decision.action, 'delay')
  assert.equal(decision.rule, 'night_failure')
  assert.equal(decision.shouldCallAi, false)
  assert.ok(decision.nextAttemptAt)

  // Verify next attempt is next day May 11 at 08:00 IST
  const istNext = toISTComponents(decision.nextAttemptAt)
  assert.equal(istNext.year, 2025)
  assert.equal(istNext.month, 5)
  assert.equal(istNext.day, 11)
  assert.equal(istNext.hours, 8)
  assert.equal(istNext.minutes, 0)
})

test('Rule 3: Message attempt in early morning quiet hours (03:15 IST) is delayed to 08:00 IST today', () => {
  const { job, payment } = createBaseFixture()
  const earlyMorning = fromISTComponents(2025, 5, 10, 3, 15, 0) // 3:15 AM IST

  const decision = evaluateStoppingRules({ job, payment, now: earlyMorning })
  assert.equal(decision.action, 'delay')
  assert.equal(decision.shouldCallAi, false)
  assert.ok(decision.nextAttemptAt)

  const istNext = toISTComponents(decision.nextAttemptAt)
  assert.equal(istNext.day, 10)
  assert.equal(istNext.hours, 8)
  assert.equal(istNext.minutes, 0)
})

// ---------------------------------------------------------------------------
// 4. Night-time Failure
// ---------------------------------------------------------------------------
test('Rule 4: Night-time failure created at 23:00 IST delays first outreach to morning', () => {
  const failureTime = fromISTComponents(2025, 5, 10, 23, 0, 0)
  const { job, payment } = createBaseFixture()
  job.createdAt = failureTime
  payment.createdAt = failureTime

  const decision = evaluateStoppingRules({ job, payment, now: failureTime })
  assert.equal(decision.action, 'delay')
  assert.equal(decision.rule, 'night_failure')
  assert.equal(decision.shouldCallAi, false)

  const istNext = toISTComponents(decision.nextAttemptAt!)
  assert.equal(istNext.day, 11)
  assert.equal(istNext.hours, 8)
})

// ---------------------------------------------------------------------------
// 5. Salary Window (Soft / Low Balance)
// ---------------------------------------------------------------------------
test('Rule 5: Outside salary window (10th of month) delays to 25th when preferSalaryWindow is true', () => {
  const { job, payment } = createBaseFixture()
  const tenthOfMonth = fromISTComponents(2025, 5, 10, 14, 0, 0) // May 10, 14:00 IST

  const decision = evaluateStoppingRules({
    job,
    payment,
    now: tenthOfMonth,
    preferSalaryWindow: true,
  })

  assert.equal(decision.action, 'delay')
  assert.equal(decision.rule, 'salary_window')
  assert.ok(decision.nextAttemptAt)

  const istNext = toISTComponents(decision.nextAttemptAt)
  assert.equal(istNext.year, 2025)
  assert.equal(istNext.month, 5)
  assert.equal(istNext.day, 25)
  assert.equal(istNext.hours, 8)
})

test('Rule 5: Outside salary window (29th of month) delays to 1st of next month', () => {
  const { job, payment } = createBaseFixture()
  const twentyNinth = fromISTComponents(2025, 5, 29, 14, 0, 0) // May 29

  const decision = evaluateStoppingRules({
    job,
    payment,
    now: twentyNinth,
    preferSalaryWindow: true,
  })

  assert.equal(decision.action, 'delay')
  assert.equal(decision.rule, 'salary_window')

  const istNext = toISTComponents(decision.nextAttemptAt!)
  assert.equal(istNext.year, 2025)
  assert.equal(istNext.month, 6)
  assert.equal(istNext.day, 1)
  assert.equal(istNext.hours, 8)
})

test('Rule 5: Inside salary window (3rd of month or 26th of month) allows send immediately', () => {
  const { job, payment } = createBaseFixture()

  // 3rd of month
  const thirdOfMonth = fromISTComponents(2025, 5, 3, 14, 0, 0)
  const dec1 = evaluateStoppingRules({
    job,
    payment,
    now: thirdOfMonth,
    preferSalaryWindow: true,
  })
  assert.equal(dec1.action, 'continue')
  assert.equal(dec1.shouldCallAi, true)

  // 26th of month
  const twentySixth = fromISTComponents(2025, 5, 26, 14, 0, 0)
  const dec2 = evaluateStoppingRules({
    job,
    payment,
    now: twentySixth,
    preferSalaryWindow: true,
  })
  assert.equal(dec2.action, 'continue')
  assert.equal(dec2.shouldCallAi, true)
})

// ---------------------------------------------------------------------------
// 6. Repeat Failure Gap
// ---------------------------------------------------------------------------
test('Rule 6: Follow-up 1 must wait at least 4 hours after initial message', () => {
  const { job, payment } = createBaseFixture()
  job.followUpCount = 1
  const lastMsgAt = fromISTComponents(2025, 5, 10, 10, 0, 0) // sent at 10:00 IST
  const twoHoursLater = fromISTComponents(2025, 5, 10, 12, 0, 0) // now is 12:00 IST (only 2h gap)

  const decision = evaluateStoppingRules({
    job,
    payment,
    now: twoHoursLater,
    lastMessageAt: lastMsgAt,
  })

  assert.equal(decision.action, 'delay')
  assert.equal(decision.rule, 'repeat_failure_gap')
  assert.ok(decision.nextAttemptAt)

  // Should be delayed until 14:00 IST (10:00 + 4h)
  const istNext = toISTComponents(decision.nextAttemptAt)
  assert.equal(istNext.hours, 14)
  assert.equal(istNext.minutes, 0)
})

test('Rule 6: Follow-up 1 after 4h gap continues to AI', () => {
  const { job, payment } = createBaseFixture()
  job.followUpCount = 1
  const lastMsgAt = fromISTComponents(2025, 5, 10, 10, 0, 0)
  const fiveHoursLater = fromISTComponents(2025, 5, 10, 15, 0, 0) // 5h gap

  const decision = evaluateStoppingRules({
    job,
    payment,
    now: fiveHoursLater,
    lastMessageAt: lastMsgAt,
  })

  assert.equal(decision.action, 'continue')
  assert.equal(decision.shouldCallAi, true)
})

test('Rule 6: Follow-up 2 requires longer gap (24h default)', () => {
  const { job, payment } = createBaseFixture()
  job.followUpCount = 2
  job.maxFollowUps = 3 // allow 3 max for this test
  const lastMsgAt = fromISTComponents(2025, 5, 10, 10, 0, 0)
  const sixHoursLater = fromISTComponents(2025, 5, 10, 16, 0, 0) // only 6h gap

  const decision = evaluateStoppingRules({
    job,
    payment,
    now: sixHoursLater,
    lastMessageAt: lastMsgAt,
  })

  assert.equal(decision.action, 'delay')
  assert.equal(decision.rule, 'repeat_failure_gap')

  const istNext = toISTComponents(decision.nextAttemptAt!)
  assert.equal(istNext.day, 11)
  assert.equal(istNext.hours, 10)
})

// ---------------------------------------------------------------------------
// 7. Stale Rule
// ---------------------------------------------------------------------------
test('Rule 7: Customer inactive for >= 24h after last message marks job stale', () => {
  const { job, payment } = createBaseFixture()
  job.followUpCount = 1
  const lastMsgAt = fromISTComponents(2025, 5, 10, 10, 0, 0)
  const twentyFiveHoursLater = fromISTComponents(2025, 5, 11, 11, 0, 0) // 25h later

  const decision = evaluateStoppingRules({
    job,
    payment,
    now: twentyFiveHoursLater,
    lastMessageAt: lastMsgAt,
  })

  assert.equal(decision.action, 'stale')
  assert.equal(decision.rule, 'stale_timeout')
  assert.equal(decision.shouldCallAi, false)
  assert.match(decision.reason, /within 24 hours of last message/)
})

// ---------------------------------------------------------------------------
// 8. HITL Thresholds (Amount >= 10,000, AI confidence < 0.70, Ambiguous)
// ---------------------------------------------------------------------------
test('Rule 8: Amount >= ₹10,000 escalates to HITL', () => {
  const { job, payment, now } = createBaseFixture()
  payment.amount = 12500 // ₹12,500

  const decision = evaluateStoppingRules({ job, payment, now })
  assert.equal(decision.action, 'hitl')
  assert.equal(decision.rule, 'hitl_high_value')
  assert.equal(decision.shouldCallAi, false)
  assert.match(decision.reason, /exceeds HITL threshold/)
})

test('Rule 8: High amount on hard failure routes to HITL rather than raw discard', () => {
  const { job, payment, now } = createBaseFixture()
  job.failureType = 'hard'
  payment.amount = 50000 // ₹50,000 VIP customer hard failure

  const decision = evaluateStoppingRules({ job, payment, now })
  assert.equal(decision.action, 'hitl')
  assert.equal(decision.rule, 'hitl_high_value')
})

test('Rule 8: AI confidence below threshold (0.55 < 0.70) escalates to HITL', () => {
  const { job, payment, now } = createBaseFixture()

  const decision = evaluateStoppingRules({
    job,
    payment,
    now,
    aiConfidence: 0.55,
  })

  assert.equal(decision.action, 'hitl')
  assert.equal(decision.rule, 'hitl_low_confidence')
  assert.equal(decision.shouldCallAi, false)
  assert.match(decision.reason, /below minimum threshold/)
})

test('Rule 8: AI confidence at or above threshold (0.85) passes to AI', () => {
  const { job, payment, now } = createBaseFixture()

  const decision = evaluateStoppingRules({
    job,
    payment,
    now,
    aiConfidence: 0.85,
  })

  assert.equal(decision.action, 'continue')
  assert.equal(decision.shouldCallAi, true)
})

test('Rule 8: Ambiguous case flags to HITL', () => {
  const { job, payment, now } = createBaseFixture()

  const decision = evaluateStoppingRules({
    job,
    payment,
    now,
    isAmbiguous: true,
  })

  assert.equal(decision.action, 'hitl')
  assert.equal(decision.rule, 'hitl_ambiguous')
  assert.equal(decision.shouldCallAi, false)
})

// ---------------------------------------------------------------------------
// 9. HITL Reject
// ---------------------------------------------------------------------------
test('Rule 9: HITL status rejected stops recovery', () => {
  const { job, payment, now } = createBaseFixture()

  const decision = evaluateStoppingRules({
    job,
    payment,
    now,
    hitlStatus: 'rejected',
  })

  assert.equal(decision.action, 'stop_rejected')
  assert.equal(decision.rule, 'hitl_rejected')
  assert.equal(decision.shouldCallAi, false)
})

// ---------------------------------------------------------------------------
// 10. Already Recovered
// ---------------------------------------------------------------------------
test('Rule 10: Already paid payment stops recovered', () => {
  const { job, payment, now } = createBaseFixture()
  payment.isPaid = true

  const decision = evaluateStoppingRules({ job, payment, now })
  assert.equal(decision.action, 'stop_recovered')
  assert.equal(decision.rule, 'already_recovered')
  assert.equal(decision.shouldCallAi, false)
})

test('Rule 10: Job status already recovered stops recovered', () => {
  const { job, payment, now } = createBaseFixture()
  job.status = 'recovered'

  const decision = evaluateStoppingRules({ job, payment, now })
  assert.equal(decision.action, 'stop_recovered')
  assert.equal(decision.rule, 'already_recovered')
})

// ---------------------------------------------------------------------------
// 11. Normal Happy Path (Continue to AI)
// ---------------------------------------------------------------------------
test('Rule 11: Normal daytime soft failure with valid params continues to AI Agent', () => {
  const { job, payment, now } = createBaseFixture()

  const decision = evaluateStoppingRules({ job, payment, now })
  assert.equal(decision.action, 'continue')
  assert.equal(decision.rule, 'all_passed')
  assert.equal(decision.shouldCallAi, true)
})

// ---------------------------------------------------------------------------
// IST and Timezone Unit Tests
// ---------------------------------------------------------------------------
test('IST conversion handles month and year rollovers accurately', () => {
  // Dec 31, 2025 at 23:00 IST -> next morning 08:00 IST on Jan 1, 2026
  const newYearsEve = fromISTComponents(2025, 12, 31, 23, 0, 0)
  const nextMorning = getNextQuietHoursEnd(newYearsEve, 21, 8)
  const istNext = toISTComponents(nextMorning)

  assert.equal(istNext.year, 2026)
  assert.equal(istNext.month, 1)
  assert.equal(istNext.day, 1)
  assert.equal(istNext.hours, 8)
  assert.equal(istNext.minutes, 0)
})

test('isInsideQuietHours accurately detects 21:00 to 08:00 IST window', () => {
  // 20:59 IST -> false
  assert.equal(isInsideQuietHours(fromISTComponents(2025, 5, 10, 20, 59, 0)), false)
  // 21:00 IST -> true
  assert.equal(isInsideQuietHours(fromISTComponents(2025, 5, 10, 21, 0, 0)), true)
  // 00:00 IST -> true
  assert.equal(isInsideQuietHours(fromISTComponents(2025, 5, 10, 0, 0, 0)), true)
  // 07:59 IST -> true
  assert.equal(isInsideQuietHours(fromISTComponents(2025, 5, 10, 7, 59, 0)), true)
  // 08:00 IST -> false
  assert.equal(isInsideQuietHours(fromISTComponents(2025, 5, 10, 8, 0, 0)), false)
})

test('formatISTDate formats date nicely in IST', () => {
  const date = fromISTComponents(2025, 5, 15, 14, 30, 0)
  assert.equal(formatISTDate(date), '2025-05-15 14:30 IST')
})

test('parseAmount parses number, string, and Decimal-like objects', () => {
  assert.equal(parseAmount(150), 150)
  assert.equal(parseAmount('250.50'), 250.5)
  assert.equal(parseAmount({ toString: () => '999.99' }), 999.99)
  assert.equal(parseAmount({ toNumber: () => 1234.56 }), 1234.56)
  assert.equal(parseAmount(null), 0)
})
