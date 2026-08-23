// Grabit API — /ledger routes.
//
// The Recovery Ledger: an append-only record of every rupee Grabit recovered,
// linked to the original failure, the attempt that recovered it, and the
// message that did it. This is the source of truth for "money recovered"
// claims in the dashboard and the buildathon demo.
//
// Chunk 1: stub.
import { Hono } from 'hono'

const app = new Hono()

// GET /ledger — list recovered-amount entries (stub)
app.get('/', (c) => c.json({ entries: [] }))

export default app
