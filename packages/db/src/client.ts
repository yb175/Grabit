// @grabit/db — shared Prisma client for the whole Grabit monorepo.
//
// Grabit is an AI-powered Payment Revenue Recovery system: it detects failed
// payments / UPI Autopay failures, diagnoses them with an AI agent, and runs
// smart, personalized recovery flows (WhatsApp one-click retry links),
// tracking every recovered rupee in a ledger + dashboard.
//
// This file exports a single PrismaClient instance so the API and the workers
// share one connection pool. Every part of the system (webhook ingestion,
// recovery state machine, ledger, audit trail) reads/writes through this.
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
