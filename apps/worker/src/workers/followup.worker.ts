// followup.worker — the persistence stage of Grabit's pipeline.
//
// Handles scheduled retries: if a recovery message got no response, re-send at
// the next smart-timing window (respecting salary-cycle hints and quiet
// hours) until stopping rules fire (max attempts, recovered, unsubscribed,
// or hard-stop failure type). Writes ledger entries on success.
//
// Chunk 1: stub.
export {}
