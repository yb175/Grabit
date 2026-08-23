// Grabit API — entrypoint.
//
// Grabit is an AI-powered Payment Revenue Recovery system: it detects failed
// payments & UPI Autopay failures, diagnoses the failure type with an AI
// agent (Hard / Soft / Autopay Failed / Autopay Cancelled), and runs smart,
// personalized recovery flows over WhatsApp with human-in-the-loop escalation
// and a full recovery ledger + dashboard.
//
// This file boots the Hono app (see app.ts) and starts the HTTP server.
import { serve } from '@hono/node-server'
import { config } from '@grabit/config'
import { app } from './app.js'

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[grabit-api] listening on :${info.port}`)
})
