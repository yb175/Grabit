// Grabit API — /audit routes.
//
// Every automated decision Grabit makes (failure classification, chosen
// action, message copy, timing choice, stop decision) is written to an
// immutable audit log. These endpoints expose it for compliance and debugging.
//
// Chunk 1: stub.
import { Hono } from 'hono'

const app = new Hono()

// GET /audit — recent audit events (stub)
app.get('/', (c) => c.json({ events: [] }))

export default app
