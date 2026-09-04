# Grabit Buildathon Pitch

## The one thing judges must remember

> **“Grabit recovers real ₹ safely: it acts on payment failures, stops when it should, and proves every decision.”**

Do not pitch Grabit as a WhatsApp bot or an AI agent that talks to customers. Pitch it as a **bounded revenue-recovery system**. The win is not that it sends a message. The win is that a failed payment becomes either **captured and recorded in the ledger** or **safely stopped with evidence**.

Razorpay’s Track 03 bar is explicit: show **measured money recovered across a batch, compliant escalation, stopping rules, and an audit trail**. Every minute must prove one of those four things.

---

## The 5-minute structure

### 0:00–0:20 — Start with the outcome, not architecture

**Show:** a batch table containing mixed outcomes. Put recovered rows and stopped rows in the same view. The recovered ₹ total should be immediately visible.

**Say:**

> “A failed payment is not necessarily lost revenue. But blindly retrying or messaging every customer is worse: it wastes effort and can nag someone who has cancelled, paid, or should never be contacted. Grabit turns failed payments into a controlled recovery workflow.”

Then point to the batch result.

> “Across this batch, Grabit recovered ₹[real demo total] and deliberately stopped [real count] cases. I’ll show you one of each.”

**Why this works:** judges hear the business outcome before they hear implementation. Do not begin with “we built an AI agent.”

### 0:20–0:45 — Establish the operating boundary

**Show:** one compact architecture view, or narrate against the batch if architecture is not available.

**Say:**

> “The pipeline starts at Razorpay’s `payment.failed` webhook. Rules stop obvious no-contact cases. AI is deliberately narrow: it classifies the failure and fills approved template slots. It cannot declare a payment recovered, and it cannot send cold free-form WhatsApp.”

> “For uncertainty or high-risk cases, it goes to a human. For eligible cases, it uses a utility template or its email twin, waits, and allows at most two follow-ups.”

Use the channel restriction as a strength:

> “WhatsApp blocks cold free-form outreach with error 131047. We designed around the real constraint: templates only, not a fake chatbot demo.”

### 0:45–2:00 — Job one: soft failure becomes recovered ₹

**Show:** the preloaded soft-recovered job timeline. Reveal events one by one rather than explaining the entire screen at once.

**Narration:**

1. **Failure received**
   > “This Razorpay payment failed for ₹[amount]. Ingest creates one recovery job.”

2. **Decision and boundary**
   > “The classifier identifies a soft recoverable case. Here is the decision, confidence, and reason. AI chose a bounded action; rules still own the limits.”

3. **Action**
   > “Grabit creates a payment link and sends an approved WhatsApp utility template with the permitted slots filled. This is not free-form persuasion.”

4. **Payment truth**
   > “Now the customer pays. Notice the crucial distinction: Grabit does not infer success from a reply, delivery receipt, or link click. Razorpay’s `payment.captured` is the truth.”

5. **Ledger proof**
   > “Only after capture does the job close as recovered and write this idempotent ledger entry for ₹[amount]. This is the number shown in the batch total.”

Pause for one second on the ledger row. This is the money shot.

### 2:00–2:55 — Job two: the system proves restraint

**Show:** the hard/fraud/cancelled job timeline, ideally beside the absence of any outbound message event.

**Say:**

> “The impressive demo is not only the recovery. Here is a hard or cancelled case.”

> “The rule and decision trail classify it as no-contact. The job stops. There is no payment link, no one-click route, and no message event.”

> “Our live golden set asserts this property: hard cases never take the one-click path.”

> “That is what compliant recovery looks like: money-seeking behavior constrained by customer safety and policy.”

Do not apologize for not recovering this payment. A stopped case is evidence that the system is trustworthy.

### 2:55–3:45 — Show human control, not a human-shaped decoration

**Show:** a real pending HITL item, then use approve or reject once. Show the resulting status and audit event.

**Say:**

> “When confidence or policy says ‘do not automate,’ Grabit creates a review task. The reviewer sees the escalation reason and AI recommendation, then can approve or reject.”

> “That action is written to the audit trail with who did it and when. Human review is in the workflow, not a slide claiming there is human review.”

Only perform one action live. A double-action demo is slower and less credible.

### 3:45–4:30 — Make reliability concrete

**Show:** timeline audit events, a ledger row, and optionally the golden-set command/result only if it is clean and readable.

**Say:**

> “We designed for the unpleasant paths. Replayed webhooks do not duplicate recovery jobs. Repeated capture events do not duplicate the ledger. The wait window and two-follow-up cap prevent endless pursuit.”

> “Every consequential transition is inspectable: incoming failure, classification, action, human override, capture, and final ledger outcome.”

Avoid claiming broad accuracy, conversion, or production scale unless measured in the displayed demo batch.

### 4:30–5:00 — Close with the bar, word for word

**Show:** return to batch totals plus the two selected job outcomes.

**Say:**

> “Track 03 asks for measured money recovered across a batch, compliant escalation, stopping rules, and an audit trail. Grabit shows all four: recovered ₹ in the ledger, HITL for uncertainty, no-contact stopping for hard cases, and a complete job timeline.”

> “It is not an AI that chases everyone. It is a system a merchant can trust to recover revenue without creating a new problem.”

Then stop. Do not use the final seconds to list technologies.

---

## Preload plan: make the demo deterministic

Use exactly two primary jobs and one optional HITL task. Do not depend on a real customer, an actual WhatsApp delivery event, or a live payment during the pitch.

### Job A — soft failure, recovered

Ensure the timeline has this complete sequence:

1. Razorpay `payment.failed` received.
2. `failed_payments` row for ₹[amount].
3. `recovery_jobs` row created.
4. `agent_decisions` row: soft/recoverable route, explanation, confidence.
5. Payment link created.
6. `messages` row: approved utility template, sent status.
7. Razorpay `payment.captured` event and `failed_payments.is_paid = true`.
8. Job status recovered.
9. Exactly one `recovery_ledger` recovered row for the same ₹ amount.
10. Relevant `audit_logs` entries in chronological order.

**Judge takeaway:** the system caused a bounded intervention, but capture—not AI—is the recovery authority.

### Job B — hard/fraud/cancelled, stopped

Ensure the timeline has this complete sequence:

1. Razorpay `payment.failed` received.
2. Job created.
3. Rule/decision identifies hard, fraud, or cancelled condition.
4. Job status becomes stopped.
5. Audit entry states the transition.
6. No `messages` row.
7. No payment-link fields populated.
8. No one-click route.

**Judge takeaway:** the system has a real brake, and the brake is observable.

### Optional Job C — HITL pending

Use only if it is ready.

- A case is in `hitl_queue` with its reason and pending status.
- One reviewer action changes it to approved or rejected.
- The corresponding job transition and audit log appear.

If this is unreliable, show the existing completed HITL timeline instead. A stable recording beats a fragile live interaction.

---

## What to show on screen

The presentation does not need a polished dashboard. A batch table plus job timelines is enough.

### Batch table: only columns that make the argument

- Failed payment amount (₹)
- Failure type
- Job status
- Intervention route
- Ledger outcome / recovered amount (₹)
- Link to timeline

The table must include both recovered and stopped outcomes. A table of only successful cases looks cherry-picked.

### Job timeline: only evidence, in chronological order

- Timestamp
- Event
- Decision/reason when applicable
- Actor: system, AI, or reviewer
- Resulting status

For a recovery, make `payment.captured` and the ledger row visually easy to locate. For a stop, make the absence of messaging explicit through the timeline’s terminal stop event and no outbound-message event.

---

## The “crazy” part is disciplined contrast

Do not make the pitch loud; make it surprising.

1. **Lead with recovered ₹, not an AI demo.** Most teams will show a chatbot. You show a ledger.
2. **Make the stopped job a hero moment.** Most teams hide non-action. You prove restraint is a feature.
3. **Say what AI cannot do.** “It cannot decide payment success. It cannot free-write cold WhatsApps. It cannot exceed the follow-up cap.” This reads as mature AI judgment.
4. **Treat constraints as credibility.** Template-only WhatsApp and `payment.captured` reconciliation make the demo feel connected to the actual payments world.
5. **Use a batch before individual stories.** The batch proves this is a workflow, not a lucky one-off.

The emotional arc is:

> Revenue leaks → AI chooses a bounded recovery action → money is actually captured → unsafe cases are stopped → every outcome can be audited.

---

## Failure backup: 30-second recovery plan

If Razorpay, WhatsApp, network, or a worker fails, do not troubleshoot on camera.

Say:

> “The external delivery path is unavailable, so I’ll show the same completed workflow from the persisted evidence.”

Then show, in this order:

1. The batch row with recovered ₹.
2. The soft job’s decision, sent-template record, `is_paid`/captured state, and ledger row.
3. The hard job’s stop decision and absence of a message.
4. The email twin as the delivery fallback if it is already configured.

Never fake a live WhatsApp send. Never send a cold free-form message to compensate for a template failure.

---

## Questions to prepare for

### “How do you know the payment was recovered?”

> “Only Razorpay’s captured payment state closes the case. The ledger is written after that, idempotently.”

### “What prevents spam?”

> “Stopping rules run before action, hard/fraud/cancelled cases stop, uncertain cases go HITL, and every job has a maximum of two follow-ups.”

### “Where is AI actually useful?”

> “It classifies the failure and chooses/fills the permitted intervention template. It is not used as the payment authority or as an unrestricted messenger.”

### “What happens when AI is wrong or uncertain?”

> “The workflow is bounded by rules and routes sensitive or uncertain cases to HITL. The reviewer action is audited.”

### “Why WhatsApp templates?”

> “Cold free-form WhatsApp outreach is blocked; production recovery has to respect that. We use utility templates and an email twin.”

### “Why should a merchant trust this?”

> “Because it proves both sides: captured recoveries in the ledger and deliberate no-contact stops in the audit trail.”

---

## Do not show

- A chat UI.
- Raw prompts or long model reasoning dumps.
- A free-form WhatsApp composer.
- Message open rates, marketing funnels, or generic analytics.
- Fake industry benchmarks.
- A recovery marked successful before `payment.captured`.
- Only a happy-path job.
- A terminal full of logs for more than a few seconds.
- Architecture before the business outcome.
- Unmeasured claims such as “increases recovery by 30%.”

---

## Recording checklist

- Seed and verify the two jobs before recording.
- Verify batch totals equal the visible ledger entries.
- Verify the hard job has no message or one-click route.
- Verify the soft job has exactly one recovered ledger outcome.
- Keep browser tabs pre-open: batch, soft timeline, hard timeline, HITL, architecture, backup recording.
- Record a clean backup walkthrough before the live take.
- Keep the spoken pitch under 4:40 in rehearsal; live demos need slack.
- End on the batch outcome and the one-sentence aha, not a thank-you slide.
