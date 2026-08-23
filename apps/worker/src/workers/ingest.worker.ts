// ingest.worker — first stage of Grabit's recovery pipeline.
//
// Consumes raw Razorpay webhook events enqueued by the API, normalizes them
// (payment failure vs subscription/autopay failure vs mandate revocation),
// deduplicates, and writes the canonical PaymentFailure row to Postgres.
// Then enqueues a recovery job.
//
// Chunk 1: stub — registered in src/index.ts in Chunk 2.
export {}
