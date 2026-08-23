// Grabit API — /jobs routes.
//
// Inspection/control endpoints for the recovery pipeline: list jobs by state
// (pending / diagnosing / contacting / recovered / abandoned / escalated),
// trigger a manual re-run, and replay a webhook event.
//
// Chunk 1: stub.
import { Hono } from 'hono'

const app = new Hono()

// GET /jobs — recent recovery pipeline jobs (stub)
app.get('/', (c) => c.json({ jobs: [] }))

export default app
