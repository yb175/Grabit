// HITL (Human-in-the-Loop) Route Tests.
// Run: pnpm --filter @grabit/api test
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@grabit/db'
import { getQueue, closeAllQueues } from '@grabit/queue'
import { app } from '../src/app.js'

describe('HITL API (/hitl)', () => {
  const testRunId = Date.now().toString()
  let testPaymentId: string
  let testJobId: string
  let testHitlTaskId: string
  const originalApiKey = process.env.GRABIT_API_KEY

  before(async () => {
    process.env.GRABIT_API_KEY = 'test-key'

    // Seed a failed payment and recovery job that tripped HITL (e.g. high value)
    const payment = await prisma.failedPayment.create({
      data: {
        razorpayPaymentId: `pay_hitl_test_${testRunId}`,
        razorpayOrderId: `order_hitl_test_${testRunId}`,
        amount: 15000.0, // ₹15,000 trips HITL threshold
        currency: 'INR',
        failureCode: 'insufficient_funds',
        failureReason: 'Account has insufficient funds',
        failureSource: 'payment',
        paymentMethod: 'upi',
        customerName: 'Aarav Patel',
        customerPhone: '+919876543210',
        customerEmail: 'aarav@example.com',
        rawPayload: { id: `pay_hitl_test_${testRunId}`, amount: 1500000 },
      },
    })
    testPaymentId = payment.id

    const job = await prisma.recoveryJob.create({
      data: {
        failedPaymentId: testPaymentId,
        status: 'hitl',
        failureType: 'soft',
        priority: 10,
      },
    })
    testJobId = job.id

    await prisma.agentDecision.create({
      data: {
        recoveryJobId: testJobId,
        decisionType: 'one_click',
        explanation: 'High value payment soft failure. Customer likely has alternate accounts.',
        actionPayload: {
          customer_message: 'Hi Aarav, your payment of ₹15,000 for your order could not be processed. Tap here to complete it securely: https://rzp.io/l/demo123',
        },
        confidence: 0.92,
        modelVersion: 'gemini-2.0-flash',
      },
    })

    const hitlTask = await prisma.hitlQueue.create({
      data: {
        recoveryJobId: testJobId,
        reason: 'Payment amount ₹15,000 exceeds HITL threshold of ₹10,000. Escalate to human reviewer.',
        status: 'pending',
      },
    })
    testHitlTaskId = hitlTask.id
  })

  after(async () => {
    // Restore env var
    if (originalApiKey === undefined) {
      delete process.env.GRABIT_API_KEY
    } else {
      process.env.GRABIT_API_KEY = originalApiKey
    }

    // Cleanup created records and test queue jobs
    try {
      if (testJobId) {
        await prisma.auditLog.deleteMany({
          where: {
            OR: [
              { entityId: testJobId },
              { entityId: testHitlTaskId },
            ],
          },
        })
        await prisma.hitlQueue.deleteMany({ where: { recoveryJobId: testJobId } })
        await prisma.agentDecision.deleteMany({ where: { recoveryJobId: testJobId } })
        await prisma.recoveryJob.deleteMany({ where: { id: testJobId } })
      }
      if (testPaymentId) {
        await prisma.failedPayment.deleteMany({ where: { id: testPaymentId } })
      }

      // Clean enqueued messages in test
      try {
        const msgQueue = getQueue('message')
        await msgQueue.drain()
      } catch {}

      await closeAllQueues()
    } catch (err) {
      console.warn('Cleanup error in HITL test:', err)
    }
  })

  test('v0 Auth: missing x-api-key returns 401', async () => {
    const res = await app.request('/hitl')
    assert.equal(res.status, 401)
    const data = await res.json() as { error: string }
    assert.equal(data.error, 'unauthorized')
  })

  test('v0 Auth: invalid x-api-key returns 401 when key does not match', async () => {
    const res = await app.request('/hitl', {
      headers: { 'x-api-key': 'wrong-key' },
    })
    assert.equal(res.status, 401)
    const data = await res.json() as { error: string }
    assert.equal(data.error, 'unauthorized')
  })

  test('v0 Auth: fails closed if API key is not configured in env', async () => {
    const currentKey = process.env.GRABIT_API_KEY
    delete process.env.GRABIT_API_KEY
    delete process.env.API_KEY
    try {
      const res = await app.request('/hitl', {
        headers: { 'x-api-key': 'some-random-key' },
      })
      assert.equal(res.status, 401)
      const data = await res.json() as { error: string }
      assert.equal(data.error, 'unauthorized')
    } finally {
      process.env.GRABIT_API_KEY = currentKey
    }
  })

  test('GET /hitl: returns 400 for invalid status filter', async () => {
    const res = await app.request('/hitl?status=invalid_status', {
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(res.status, 400)
    const data = await res.json() as { error: string }
    assert.equal(data.error, 'invalid_status')
  })

  test('GET /hitl: filters by status query parameter', async () => {
    const resPending = await app.request('/hitl?status=pending', {
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(resPending.status, 200)
    const pendingData = await resPending.json() as { tasks: Array<{ id: string; status: string }> }
    for (const t of pendingData.tasks) {
      assert.equal(t.status, 'pending')
    }

    const resApproved = await app.request('/hitl?status=approved', {
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(resApproved.status, 200)
    const approvedData = await resApproved.json() as { tasks: Array<{ id: string; status: string }> }
    for (const t of approvedData.tasks) {
      assert.equal(t.status, 'approved')
    }
  })

  test('POST /hitl/:id/reject: ensures no message is enqueued and job is stopped', async () => {
    const payId = `pay_reject_stop_${testRunId}`
    const payment = await prisma.failedPayment.create({
      data: {
        razorpayPaymentId: payId,
        amount: 12000.0,
        currency: 'INR',
        failureCode: 'insufficient_funds',
        customerPhone: '+919812345678',
        rawPayload: {},
      },
    })
    const job = await prisma.recoveryJob.create({
      data: {
        failedPaymentId: payment.id,
        status: 'hitl',
        failureType: 'soft',
      },
    })
    const task = await prisma.hitlQueue.create({
      data: {
        recoveryJobId: job.id,
        reason: 'Payment amount ₹12,000 exceeds threshold.',
        status: 'pending',
      },
    })

    const res = await app.request(`/hitl/${task.id}/reject`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key', 'x-reviewer': 'ops-manager' },
      body: JSON.stringify({ notes: 'Do not pursue' }),
    })
    assert.equal(res.status, 200)

    // Assert the recovery job status is marked rejected
    const updatedJob = await prisma.recoveryJob.findUnique({ where: { id: job.id } })
    assert.equal(updatedJob?.status, 'rejected')
    assert.equal(updatedJob?.assignedTo, 'ops-manager')

    // Verify messages table has NO messages for this job
    const messages = await prisma.message.findMany({
      where: { recoveryJobId: job.id },
    })
    assert.equal(messages.length, 0)

    // Cleanup
    await prisma.auditLog.deleteMany({
      where: { OR: [{ entityId: job.id }, { entityId: task.id }] },
    })
    await prisma.hitlQueue.deleteMany({ where: { id: task.id } })
    await prisma.recoveryJob.deleteMany({ where: { id: job.id } })
    await prisma.failedPayment.deleteMany({ where: { id: payment.id } })
  })

  test('GET /hitl: lists pending HITL tasks', async () => {
    const res = await app.request('/hitl', {
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(res.status, 200)
    const data = await res.json() as { tasks: Array<{ id: string; status: string; recoveryJob?: { id: string } }> }
    assert.ok(Array.isArray(data.tasks))
    const found = data.tasks.find((t) => t.id === testHitlTaskId)
    assert.ok(found, 'Created HITL task should be in pending list')
    assert.equal(found.status, 'pending')
    assert.equal(found.recoveryJob?.id, testJobId)
  })

  test('GET /hitl/:id: gets task details by ID or recoveryJobId', async () => {
    // Fetch by task ID
    const res = await app.request(`/hitl/${testHitlTaskId}`, {
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(res.status, 200)
    const data = await res.json() as { task: { id: string; reason: string; recoveryJob: { failedPayment: { amount: string } } } }
    assert.equal(data.task.id, testHitlTaskId)
    assert.ok(data.task.reason.includes('₹15,000'))
    assert.equal(data.task.recoveryJob.failedPayment.amount, '15000')

    // Fetch by recovery job ID
    const resJob = await app.request(`/hitl/${testJobId}`, {
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(resJob.status, 200)
    const dataJob = await resJob.json() as { task: { id: string } }
    assert.equal(dataJob.task.id, testHitlTaskId)
  })

  test('GET /hitl/:id: returns 404 for invalid ID or non-existent task', async () => {
    const resInvalid = await app.request('/hitl/not-a-uuid', {
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(resInvalid.status, 404)

    const resNonExistent = await app.request('/hitl/00000000-0000-0000-0000-000000000000', {
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(resNonExistent.status, 404)
  })

  test('POST /hitl/:id/approve: approves task, updates job, and logs audit', async () => {
    const res = await app.request(`/hitl/${testHitlTaskId}/approve`, {
      method: 'POST',
      headers: {
        'x-api-key': 'test-key',
        'x-reviewer': 'reviewer@grabit.ai',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        notes: 'Verified high value customer. Safe to proceed with one-click recovery.',
      }),
    })

    assert.equal(res.status, 200)
    const data = await res.json() as { success: boolean; status: string; task: { status: string; reviewedBy: string; notes: string } }
    assert.equal(data.success, true)
    assert.equal(data.status, 'approved')
    assert.equal(data.task.reviewedBy, 'reviewer@grabit.ai')
    assert.equal(data.task.notes, 'Verified high value customer. Safe to proceed with one-click recovery.')

    // Verify DB state for task and recoveryJob
    const updatedTask = await prisma.hitlQueue.findUnique({ where: { id: testHitlTaskId } })
    assert.equal(updatedTask?.status, 'approved')
    assert.equal(updatedTask?.reviewedBy, 'reviewer@grabit.ai')
    assert.ok(updatedTask?.reviewedAt !== null)

    const updatedJob = await prisma.recoveryJob.findUnique({ where: { id: testJobId } })
    assert.equal(updatedJob?.status, 'processing')
    assert.equal(updatedJob?.assignedTo, 'reviewer@grabit.ai')

    // Verify audit logs were written
    const taskAudit = await prisma.auditLog.findFirst({
      where: { entityId: testHitlTaskId, action: 'hitl_approved' },
    })
    assert.ok(taskAudit, 'Audit log for hitl_queue approval should exist')
    assert.equal(taskAudit.performedBy, 'reviewer@grabit.ai')

    const jobAudit = await prisma.auditLog.findFirst({
      where: { entityId: testJobId, action: 'hitl_approved' },
    })
    assert.ok(jobAudit, 'Audit log for recovery_jobs approval should exist')
  })

  test('POST /hitl/:id/approve: double approve is idempotent (returns 200, not 500)', async () => {
    const res = await app.request(`/hitl/${testHitlTaskId}/approve`, {
      method: 'POST',
      headers: {
        'x-api-key': 'test-key',
        'x-reviewer': 'reviewer@grabit.ai',
      },
    })
    assert.equal(res.status, 200)
    const data = await res.json() as { success: boolean; status: string; alreadyProcessed: boolean }
    assert.equal(data.success, true)
    assert.equal(data.status, 'approved')
    assert.equal(data.alreadyProcessed, true)
  })

  test('Conflicting transitions return 409 Conflict', async () => {
    // Attempting to reject the already-approved task should return 409
    const rejectRes = await app.request(`/hitl/${testHitlTaskId}/reject`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(rejectRes.status, 409)
    const rejectData = await rejectRes.json() as { error: string }
    assert.equal(rejectData.error, 'conflict')
  })

  test('POST /hitl/:id/reject: rejects task, marks job status=rejected, and writes audit log', async () => {
    // Create a new task to test reject flow
    const rejectPayment = await prisma.failedPayment.create({
      data: {
        razorpayPaymentId: `pay_reject_test_${testRunId}`,
        amount: 25000.0,
        currency: 'INR',
        failureCode: 'fraudulent',
        failureReason: 'Fraudulent transaction detected',
        customerName: 'Risk User',
        customerPhone: '+919999999999',
        rawPayload: {},
      },
    })

    const rejectJob = await prisma.recoveryJob.create({
      data: {
        failedPaymentId: rejectPayment.id,
        status: 'hitl',
        failureType: 'hard',
      },
    })

    const rejectTask = await prisma.hitlQueue.create({
      data: {
        recoveryJobId: rejectJob.id,
        reason: 'Flagged as high fraud risk.',
        status: 'pending',
      },
    })

    const res = await app.request(`/hitl/${rejectTask.id}/reject`, {
      method: 'POST',
      headers: {
        'x-api-key': 'test-key',
        'x-reviewer': 'fraud-ops@grabit.ai',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        notes: 'Confirmed suspicious user. Do not attempt recovery.',
      }),
    })

    assert.equal(res.status, 200)
    const data = await res.json() as { success: boolean; status: string; task: { status: string; reviewedBy: string; notes: string } }
    assert.equal(data.success, true)
    assert.equal(data.status, 'rejected')
    assert.equal(data.task.reviewedBy, 'fraud-ops@grabit.ai')
    assert.equal(data.task.notes, 'Confirmed suspicious user. Do not attempt recovery.')

    // Verify DB state
    const updatedRejectJob = await prisma.recoveryJob.findUnique({ where: { id: rejectJob.id } })
    assert.equal(updatedRejectJob?.status, 'rejected')
    assert.equal(updatedRejectJob?.assignedTo, 'fraud-ops@grabit.ai')

    const rejectAudit = await prisma.auditLog.findFirst({
      where: { entityId: rejectTask.id, action: 'hitl_rejected' },
    })
    assert.ok(rejectAudit, 'Audit log for hitl_queue rejection should exist')

    const jobRejectAudit = await prisma.auditLog.findFirst({
      where: { entityId: rejectJob.id, action: 'stop_rejected' },
    })
    assert.ok(jobRejectAudit, 'Audit log for recovery_jobs stop_rejected should exist')

    // Test double reject is idempotent
    const doubleRes = await app.request(`/hitl/${rejectTask.id}/reject`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(doubleRes.status, 200)
    const doubleData = await doubleRes.json() as { alreadyProcessed: boolean }
    assert.equal(doubleData.alreadyProcessed, true)

    // Attempting to approve the rejected task should return 409
    const conflictApproveRes = await app.request(`/hitl/${rejectTask.id}/approve`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key' },
    })
    assert.equal(conflictApproveRes.status, 409)

    // Cleanup reject test data
    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ entityId: rejectJob.id }, { entityId: rejectTask.id }],
      },
    })
    await prisma.hitlQueue.deleteMany({ where: { id: rejectTask.id } })
    await prisma.recoveryJob.deleteMany({ where: { id: rejectJob.id } })
    await prisma.failedPayment.deleteMany({ where: { id: rejectPayment.id } })
  })
})
