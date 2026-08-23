// @grabit/core — shared business logic used by both API and workers.
//
// Eventually contains:
//  - failure classification types (Hard / Soft / Autopay Failed / Autopay Cancelled)
//  - stopping rules (max attempts, quiet hours, do-not-disturb)
//  - smart-timing logic (salary-cycle-aware send windows)
//  - ledger amount calculation helpers
//
// Chunk 1: just the shared failure-type enum.
export const FAILURE_TYPES = [
  'HARD',
  'SOFT',
  'AUTOPAY_FAILED',
  'AUTOPAY_CANCELLED',
] as const

export type FailureType = (typeof FAILURE_TYPES)[number]
