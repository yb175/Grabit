// Grabit API — /dashboard routes.
//
// Powers the merchant-facing dashboard: recovery rate, recovered amount over
// time, failure-type breakdown, messages sent vs clicked vs recovered, and
// current pipeline state. Eventually backed by SQL aggregations over the
// ledger + attempt tables.
//
// Chunk 1: stub.
import { Hono } from 'hono'

const app = new Hono()

// GET /dashboard/summary — headline recovery metrics (stub)
app.get('/summary', (c) =>
  c.json({
    recoveredAmount: 0,
    recoveryRate: 0,
    openCases: 0,
  }),
)

export default app
