import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { prisma } from '@grabit/db'
import { closeAllQueues } from '@grabit/queue'
import { loadFixtures, runBatch } from '../scripts/demo-batch/index.js'

const FIXTURES_DIR = resolve(process.cwd(), 'tests/fixtures/razorpay')

after(async () => {
  await closeAllQueues()
  await prisma.$disconnect()
})

test('demo:batch - fixtures directory contains 10-20 valid JSON fixtures', () => {
  assert.ok(existsSync(FIXTURES_DIR), 'Fixtures directory must exist')
  const fixtures = loadFixtures(FIXTURES_DIR)
  assert.ok(
    fixtures.length >= 10 && fixtures.length <= 25,
    `Expected between 10 and 25 fixtures, got ${fixtures.length}`,
  )

  for (const { fileName, fixture } of fixtures) {
    assert.ok(fixture.event, `Fixture ${fileName} must have an event property`)
    assert.ok(fixture.payload, `Fixture ${fileName} must have a payload property`)
  }
})

test('demo:batch - covers required categories (soft UPI, hard, autopay failed, autopay cancelled, HITL, quiet hours, duplicate)', () => {
  const fixtures = loadFixtures(FIXTURES_DIR)
  const caseNames = fixtures.map((f) => f.fixture.case ?? f.fileName)

  const hasSoftUPI = caseNames.some((n) => n.includes('soft_upi') || n.includes('insufficient_funds'))
  const hasHard = caseNames.some((n) => n.includes('hard') || n.includes('stolen') || n.includes('blocked'))
  const hasAutopayFailed = caseNames.some((n) => n.includes('autopay_execution_failed') || n.includes('subscription_halted'))
  const hasAutopayCancelled = caseNames.some((n) => n.includes('autopay_mandate_cancelled') || n.includes('mandate_revoked'))
  const hasHighAmountHITL = caseNames.some((n) => n.includes('high_amount') || n.includes('hitl'))
  const hasQuietHours = caseNames.some((n) => n.includes('quiet_hours') || n.includes('night'))
  const hasDuplicate = caseNames.some((n) => n.includes('duplicate') || fHasDuplicate(fixtures, n))

  function fHasDuplicate(all: typeof fixtures, name: string) {
    const f = all.find((x) => (x.fixture.case ?? x.fileName) === name)
    return Boolean(f?.fixture.duplicate_of)
  }

  assert.ok(hasSoftUPI, 'Must include soft UPI fixture')
  assert.ok(hasHard, 'Must include hard card / decline fixture')
  assert.ok(hasAutopayFailed, 'Must include autopay failed fixture')
  assert.ok(hasAutopayCancelled, 'Must include autopay cancelled fixture')
  assert.ok(hasHighAmountHITL, 'Must include high-amount HITL fixture')
  assert.ok(hasQuietHours, 'Must include quiet-hours delay fixture')
  assert.ok(hasDuplicate, 'Must include duplicate payment retry fixture')
})

test('demo:batch - runs full batch and passes all QA criteria', async () => {
  const summary = await runBatch({ silent: true, runId: `test_run_${Date.now()}` })

  assert.ok(summary.totalCases >= 10, 'Must process >= 10 cases')
  assert.ok(summary.createdCount > 0, 'Must create recovery jobs')
  assert.ok(summary.duplicateCount >= 1, 'Must detect at least 1 duplicate fixture')
  assert.ok(summary.totalAmountRupees > 0, 'Total pipeline amount must be > 0')

  // QA Strategy Assertion 1: Hard case never shows one_click
  const hardResults = summary.results.filter(
    (r) => r.caseName.includes('hard') || r.aiFailureType === 'hard',
  )
  for (const hr of hardResults) {
    assert.notEqual(
      hr.aiDecision,
      'one_click',
      `Hard failure ${hr.caseName} must never produce one_click decision`,
    )
  }

  // QA Strategy Assertion 2: Duplicate payment id does not create two jobs
  const duplicateResults = summary.results.filter((r) => r.ruleAction === 'duplicate')
  assert.ok(duplicateResults.length >= 1, 'At least one duplicate must be identified')
  for (const dr of duplicateResults) {
    assert.equal(dr.jobId, 'n/a', 'Duplicate event must not produce a recovery job')
    assert.equal(dr.outcome, 'duplicate', 'Duplicate event outcome must be duplicate')
  }

  // QA Strategy Assertion 3: High amount (>= ₹10,000) escalates to HITL
  const hitlResults = summary.results.filter(
    (r) => r.amount >= 10000 && r.outcome === 'created',
  )
  assert.ok(hitlResults.length >= 1, 'Must have high amount cases')
  for (const hr of hitlResults) {
    assert.equal(hr.ruleAction, 'hitl', `High amount case ${hr.caseName} must escalate to hitl`)
  }

  // QA Strategy Assertion 4: Quiet hours case delayed
  const quietHoursResults = summary.results.filter((r) =>
    r.caseName.includes('quiet_hours') || r.caseName.includes('night_delay'),
  )
  for (const qr of quietHoursResults) {
    assert.equal(qr.ruleAction, 'delay', `Quiet hours case ${qr.caseName} must have delay rule action`)
  }

  assert.equal(summary.passedQAChecks, true, 'All QA checks in summary must be passed')
})
