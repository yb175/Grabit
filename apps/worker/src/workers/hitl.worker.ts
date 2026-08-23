// hitl.worker — the human-in-the-loop stage of Grabit's pipeline.
//
// Creates a HITL task when the AI flags a case as needing a human (high
// value, ambiguous, angry-customer signals, mandate cancellation disputes),
// notifies the reviewer, and waits for an approve/edit/reject decision from
// the /hitl API routes before continuing or closing the case.
//
// Chunk 1: stub.
export {}
