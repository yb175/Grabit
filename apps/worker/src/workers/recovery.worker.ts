// recovery.worker — the brain-adjacent stage of Grabit's pipeline.
//
// Takes a persisted PaymentFailure, calls the Python AI agent (@grabit/ai-agent)
// to classify it (Hard / Soft / Autopay Failed / Autopay Cancelled), then
// applies smart-timing (salary windows, quiet hours, retry gaps) and stopping
// rules (max attempts, do-not-disturb) to decide: message now, schedule later,
// or escalate to HITL.
//
// Chunk 1: stub.
export {}
