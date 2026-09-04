// @grabit/core — shared business logic used by both API and workers.
//
// Eventually contains:
//  - failure classification types (Hard / Soft / Autopay Failed / Autopay Cancelled)
//  - stopping rules (max attempts, quiet hours, do-not-disturb)
//  - smart-timing logic (salary-cycle-aware send windows)
//  - ledger amount calculation helpers
//
// Chunk 1: just the shared failure-type enum.
// Values match the Prisma FailureType enum exactly (packages/db) so the
// core union and the DB enum are interchangeable without mapping.
export const FAILURE_TYPES = [
  'hard',
  'soft',
  'autopay_failed',
  'autopay_cancelled',
] as const

export type FailureType = (typeof FAILURE_TYPES)[number]

// Razorpay domain: event types, whitelist, classification rules.
export * from './razorpay.js'

// Stopping Rules & Smart-Timing Engine
export * from './stopping-rules.js'

// Razorpay Payment Link Service
export * from './payment-link.js'


