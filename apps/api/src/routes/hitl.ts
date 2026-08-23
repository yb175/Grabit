// Grabit API — /hitl routes (Human-in-the-Loop).
//
// When the AI agent flags a case as high-value, unclear, or risky (e.g. angry
// customer, dispute, mandate cancellation), it creates a HITL task instead of
// auto-messaging. Eventually these endpoints let a human reviewer list open
// tasks, see the AI's recommendation, and approve / edit / reject the next
// action.
//
// Chunk 1: stub.
import { Hono } from 'hono'

const app = new Hono()

// GET /hitl — open human-review tasks (stub)
app.get('/', (c) => c.json({ tasks: [] }))

export default app
