# Stopping Rules & Smart-Timing Engine

Located in: `packages/core/src/stopping-rules.ts`  
Test Suite: `packages/core/test/stopping-rules.test.ts` (28 unit tests)

---

## 1. Engine Purpose

The Stopping Rules & Smart-Timing Engine is a pure, deterministic domain engine with **zero network or database dependencies**. It answers one question before customer outreach:

> *"Should this recovery attempt proceed immediately, be delayed for an optimal window, be escalated to a human reviewer, or be permanently closed?"*

---

## 2. Evaluation Flow & Priority Hierarchy

The engine evaluates rules in strict sequential order. The first rule that matches produces the final decision.

```
                              [ Stopping Rules Input ]
                                         │
                                         ▼
                     ┌───────────────────────────────────────┐
                     │ 1. Is Payment Already Paid/Recovered? │ ── Yes ──> [ stop_recovered ]
                     └──────────────────┬────────────────────┘
                                        │ No
                                        ▼
                     ┌───────────────────────────────────────┐
                     │ 2. Did HITL Reviewer Reject the Case? │ ── Yes ──> [ stop_rejected ]
                     └──────────────────┬────────────────────┘
                                        │ No
                                        ▼
                     ┌───────────────────────────────────────┐
                     │ 3. Follow-up Count >= Max Follow-ups? │ ── Yes ──> [ stop_unrecovered ]
                     └──────────────────┬────────────────────┘
                                        │ No
                                        ▼
                     ┌───────────────────────────────────────┐
                     │ 4. Is Job Stale (>24h since outreach)?│ ── Yes ──> [ stale ]
                     └──────────────────┬────────────────────┘
                                        │ No
                                        ▼
                     ┌───────────────────────────────────────┐
                     │ 5. Amount >= ₹10k or Low Confidence?  │ ── Yes ──> [ hitl ]
                     └──────────────────┬────────────────────┘
                                        │ No
                                        ▼
                     ┌───────────────────────────────────────┐
                     │ 6. Is this a Known Hard Decline Code? │ ── Yes ──> [ stop_unrecovered ]
                     └──────────────────┬────────────────────┘
                                        │ No
                                        ▼
                     ┌───────────────────────────────────────┐
                     │ 7. Smart Timing: Quiet / Salary / Gap │ ── Triggered ──> [ delay ]
                     └──────────────────┬────────────────────┘
                                        │ All Clear
                                        ▼
                                  [ continue ]
                          (Status -> 'processing')
```

---

## 3. Detailed Rules Specification Table

| Priority | Rule Name | Condition | Action | Next State / Result |
| :--- | :--- | :--- | :--- | :--- |
| **1** | `already_recovered` | `payment.isPaid === true` or `job.status === 'recovered'` | `stop_recovered` | Mark recovered, write `recovery_ledger` entry. |
| **2** | `hitl_rejected` | `hitlStatus === 'rejected'` or `job.status === 'rejected'` | `stop_rejected` | Mark rejected, record audit log. |
| **3** | `max_followups_exceeded` | `followUpCount >= maxFollowUps` (default: 2) | `stop_unrecovered` | Mark unrecovered, close ledger. Evaluated before staleness so an exhausted budget always closes with a ledger row. |
| **4** | `stale_timeout` / `stale_status` | Elapsed time since last outreach $\ge 24\text{h}$ | `stale` | Mark stale, stop future retries (only while follow-ups remain). |
| **5** | `hitl_high_value` | Amount $\ge \text{₹}10,000$ | `hitl` | Escalate to human review in `hitl_queue`. |
| **5** | `hitl_low_confidence` | AI confidence $< 0.70$ (70%) | `hitl` | Escalate to human review in `hitl_queue`. |
| **5** | `hitl_ambiguous` | `isAmbiguous === true` | `hitl` | Escalate to human review in `hitl_queue`. |
| **6** | `hard_failure` | Code in `HARD_DECLINE_CODES` or `failureType === 'hard'` | `stop_unrecovered` | Hard card block/fraud; do not retry. |
| **7** | `repeat_failure_gap` | Follow-up 1 $< 4\text{h}$ or Follow-up 2 $< 24\text{h}$ | `delay` | Reschedule for earliest valid gap window. |
| **7** | `salary_window` | `preferSalaryWindow: true` and outside `salaryWindowDays` | `delay` | Reschedule for next configured salary date at 08:00 IST. |
| **7** | `quiet_hours` / `night_failure`| Current IST time in `21:00`–`08:00` | `delay` | Reschedule for next morning 08:00 IST. |
| **8** | `all_passed` | All checks and timing gates clear | `continue` | Ready for AI processing and message generation. |

---

## 4. Smart Timing & Timezone Engine (IST UTC+05:30)

India Standard Time (IST) is a fixed UTC+05:30 offset with no Daylight Saving Time. The engine provides exact UTC/IST conversions:

```typescript
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000 // 19,800,000 ms

export function toISTComponents(date: Date): ISTDateComponents
export function fromISTComponents(year: number, month: number, day: number, hours?: number, minutes?: number, seconds?: number): Date
export function isInsideQuietHours(date: Date, startHour?: number, endHour?: number): boolean
export function getNextQuietHoursEnd(date: Date, startHour?: number, endHour?: number): Date
export function getNextSalaryWindowDate(date: Date, salaryWindowDays?: readonly number[], quietHoursEndHour?: number): Date
```

### Configurable Engine Parameters (`StoppingRulesConfig`):

```typescript
export const DEFAULT_STOPPING_RULES_CONFIG: StoppingRulesConfig = {
  maxFollowUps: 2,
  hitlAmountThresholdRupees: 10000,
  minAiConfidence: 0.70,
  staleThresholdHours: 24,
  quietHoursStartHourIST: 21,    // 9:00 PM IST
  quietHoursEndHourIST: 8,       // 8:00 AM IST
  followUp1GapHours: 4,          // Minimum 4h between first outreach & followup 1
  followUp2GapHours: 24,         // Minimum 24h between followup 1 & followup 2
  salaryWindowDays: [1, 2, 3, 4, 5, 25, 26, 27, 28],
} as const
```
