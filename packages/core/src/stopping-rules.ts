// @grabit/core — Stopping Rules & Smart-Timing Engine.
//
// Pure domain logic to evaluate whether a recovery job should:
//   - continue to the AI Agent (continue)
//   - be delayed for smart timing (delay: quiet hours, salary window, repeat gap)
//   - be escalated to human review (hitl: high value, low confidence, ambiguous)
//   - be marked stale (stale: no response/payment for 24h after outreach)
//   - be stopped as unrecovered (stop_unrecovered: max follow-ups exceeded, hard failure)
//   - be stopped as rejected (stop_rejected: HITL reviewer rejected)
//   - be stopped as recovered (stop_recovered: already paid/recovered)
//
// Evaluated deterministically with zero database or network dependencies.

import { HARD_DECLINE_CODES } from './razorpay.js'
import type { FailureType } from './index.js'

export type StoppingRuleAction =
  | 'continue'
  | 'delay'
  | 'hitl'
  | 'stop_recovered'
  | 'stop_unrecovered'
  | 'stop_rejected'
  | 'stale'

export type StoppingRuleName =
  | 'already_recovered'
  | 'hitl_rejected'
  | 'stale_timeout'
  | 'stale_status'
  | 'max_followups_exceeded'
  | 'hitl_high_value'
  | 'hitl_low_confidence'
  | 'hitl_ambiguous'
  | 'hard_failure'
  | 'quiet_hours'
  | 'night_failure'
  | 'salary_window'
  | 'repeat_failure_gap'
  | 'all_passed'

export interface StoppingRuleDecision {
  action: StoppingRuleAction
  rule: StoppingRuleName
  reason: string
  nextAttemptAt?: Date
  shouldCallAi: boolean
}

export interface StoppingRulesConfig {
  /** Maximum number of follow-ups before giving up (default: 2) */
  maxFollowUps: number
  /** Amount in rupees above which human review is mandatory (default: 10,000) */
  hitlAmountThresholdRupees: number
  /** Minimum AI confidence score (0.0–1.0) below which HITL is triggered (default: 0.70) */
  minAiConfidence: number
  /** Inactivity threshold in hours after last outreach before marking job stale (default: 24) */
  staleThresholdHours: number
  /** Start hour in IST (0-23) for Quiet Hours when messages cannot be sent (default: 21 / 9 PM) */
  quietHoursStartHourIST: number
  /** End hour in IST (0-23) for Quiet Hours when outreach resumes (default: 8 / 8 AM) */
  quietHoursEndHourIST: number
  /** Minimum hours to wait before follow-up 1 (default: 4) */
  followUp1GapHours: number
  /** Minimum hours to wait before follow-up 2 (default: 24) */
  followUp2GapHours: number
  /** Calendar days of month (in IST) considered salary credit windows (default: 1-5, 25-28) */
  salaryWindowDays: readonly number[]
}

export const DEFAULT_STOPPING_RULES_CONFIG: StoppingRulesConfig = {
  maxFollowUps: 2,
  hitlAmountThresholdRupees: 10000,
  minAiConfidence: 0.7,
  staleThresholdHours: 24,
  quietHoursStartHourIST: 21,
  quietHoursEndHourIST: 8,
  followUp1GapHours: 4,
  followUp2GapHours: 24,
  salaryWindowDays: [1, 2, 3, 4, 5, 25, 26, 27, 28],
} as const

export interface RecoveryJobLike {
  id?: string
  status?: string
  failureType?: FailureType | string
  followUpCount?: number
  maxFollowUps?: number
  createdAt?: Date | string
  updatedAt?: Date | string
  nextAttemptAt?: Date | string | null
}

export interface FailedPaymentLike {
  id?: string
  razorpayPaymentId?: string
  amount: number | string | { toString(): string }
  currency?: string
  failureCode?: string | null
  failureReason?: string | null
  failureSource?: string | null
  createdAt?: Date | string
  isPaid?: boolean
}

export interface StoppingRulesInput {
  job: RecoveryJobLike
  payment: FailedPaymentLike
  now?: Date | string
  lastMessageAt?: Date | string | null
  aiConfidence?: number
  hitlStatus?: 'pending' | 'approved' | 'rejected' | string | null
  isAmbiguous?: boolean
  preferSalaryWindow?: boolean
  config?: Partial<StoppingRulesConfig>
}

// ---------------------------------------------------------------------------
// IST Date Math Helpers (Fixed UTC+05:30, No DST in India)
// ---------------------------------------------------------------------------

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000 // 19,800,000 ms

export interface ISTDateComponents {
  year: number
  month: number // 1 - 12
  day: number // 1 - 31
  hours: number // 0 - 23
  minutes: number // 0 - 59
  seconds: number // 0 - 59
}

export function toISTComponents(date: Date): ISTDateComponents {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS)
  return {
    year: istDate.getUTCFullYear(),
    month: istDate.getUTCMonth() + 1,
    day: istDate.getUTCDate(),
    hours: istDate.getUTCHours(),
    minutes: istDate.getUTCMinutes(),
    seconds: istDate.getUTCSeconds(),
  }
}

export function fromISTComponents(
  year: number,
  month: number, // 1 - 12
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
): Date {
  const utcMillis = Date.UTC(year, month - 1, day, hours, minutes, seconds)
  return new Date(utcMillis - IST_OFFSET_MS)
}

export function formatISTDate(date: Date): string {
  const ist = toISTComponents(date)
  const y = ist.year
  const m = String(ist.month).padStart(2, '0')
  const d = String(ist.day).padStart(2, '0')
  const hh = String(ist.hours).padStart(2, '0')
  const mm = String(ist.minutes).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm} IST`
}

export function isInsideQuietHours(
  date: Date,
  startHour = 21,
  endHour = 8,
): boolean {
  const ist = toISTComponents(date)
  if (startHour > endHour) {
    return ist.hours >= startHour || ist.hours < endHour
  }
  return ist.hours >= startHour && ist.hours < endHour
}

export function getNextQuietHoursEnd(
  date: Date,
  startHour = 21,
  endHour = 8,
): Date {
  const ist = toISTComponents(date)
  if (ist.hours >= startHour) {
    // e.g. 21:30 IST -> Next day at endHour:00:00 IST
    return fromISTComponents(ist.year, ist.month, ist.day + 1, endHour, 0, 0)
  }
  if (ist.hours < endHour) {
    // e.g. 03:30 IST -> Today at endHour:00:00 IST
    return fromISTComponents(ist.year, ist.month, ist.day, endHour, 0, 0)
  }
  return date
}

export function isInsideSalaryWindow(
  date: Date,
  salaryWindowDays: readonly number[] = DEFAULT_STOPPING_RULES_CONFIG.salaryWindowDays,
): boolean {
  const ist = toISTComponents(date)
  return salaryWindowDays.includes(ist.day)
}

export function getNextSalaryWindowDate(
  date: Date,
  quietHoursEndHour = 8,
): Date {
  const ist = toISTComponents(date)
  // Days 1–5: already inside salary window day
  if (ist.day >= 1 && ist.day <= 5) {
    return fromISTComponents(ist.year, ist.month, ist.day, quietHoursEndHour, 0, 0)
  }
  // Days 6–24: next salary window is on 25th of current month
  if (ist.day < 25) {
    return fromISTComponents(ist.year, ist.month, 25, quietHoursEndHour, 0, 0)
  }
  // Days 25–28: already inside salary window day
  if (ist.day <= 28) {
    return fromISTComponents(ist.year, ist.month, ist.day, quietHoursEndHour, 0, 0)
  }
  // Days 29–31: next salary window is 1st of next month
  return fromISTComponents(ist.year, ist.month + 1, 1, quietHoursEndHour, 0, 0)
}

export function parseAmount(amount: number | string | { toString(): string } | unknown): number {
  if (typeof amount === 'number') return amount
  if (typeof amount === 'string') return parseFloat(amount) || 0
  if (amount && typeof (amount as { toNumber?: () => number }).toNumber === 'function') {
    return (amount as { toNumber: () => number }).toNumber()
  }
  if (amount && typeof (amount as { toString?: () => string }).toString === 'function') {
    return parseFloat((amount as { toString: () => string }).toString()) || 0
  }
  return 0
}

// ---------------------------------------------------------------------------
// Main Stopping Rules Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates stopping rules in strict priority order before dispatching to the AI Agent.
 */
export function evaluateStoppingRules(input: StoppingRulesInput): StoppingRuleDecision {
  const cfg: StoppingRulesConfig = {
    ...DEFAULT_STOPPING_RULES_CONFIG,
    ...input.config,
  }

  const now = input.now
    ? input.now instanceof Date
      ? input.now
      : new Date(input.now)
    : new Date()

  const { job, payment } = input
  const amount = parseAmount(payment.amount)
  const followUpCount = job.followUpCount ?? 0
  const maxFollowUps = job.maxFollowUps ?? cfg.maxFollowUps

  // 1. Rule 10: Already Recovered
  if (payment.isPaid === true || job.status === 'recovered') {
    return {
      action: 'stop_recovered',
      rule: 'already_recovered',
      reason: 'Payment is already marked as recovered/paid.',
      shouldCallAi: false,
    }
  }

  // 2. Rule 9: HITL Rejected
  if (input.hitlStatus === 'rejected' || job.status === 'rejected') {
    return {
      action: 'stop_rejected',
      rule: 'hitl_rejected',
      reason: 'Case was reviewed and rejected by human reviewer.',
      shouldCallAi: false,
    }
  }

  // 3. Already Stale Status
  if (job.status === 'stale') {
    return {
      action: 'stale',
      rule: 'stale_status',
      reason: 'Job is already marked stale.',
      shouldCallAi: false,
    }
  }

  // 4. Rule 7: Stale Rule (Inactivity >= 24h after last outreach)
  const lastMsgDate = input.lastMessageAt
    ? input.lastMessageAt instanceof Date
      ? input.lastMessageAt
      : new Date(input.lastMessageAt)
    : null

  if (lastMsgDate) {
    const elapsedHours = (now.getTime() - lastMsgDate.getTime()) / (1000 * 60 * 60)
    if (elapsedHours >= cfg.staleThresholdHours) {
      return {
        action: 'stale',
        rule: 'stale_timeout',
        reason: `Customer has not responded or paid within ${cfg.staleThresholdHours} hours of last message.`,
        shouldCallAi: false,
      }
    }
  }

  // 5. Rule 2: Max Follow-ups Exceeded
  if (followUpCount >= maxFollowUps) {
    return {
      action: 'stop_unrecovered',
      rule: 'max_followups_exceeded',
      reason: `Maximum follow-up attempts (${maxFollowUps}) reached without payment recovery.`,
      shouldCallAi: false,
    }
  }

  // 6. Rule 8: HITL Thresholds (High Value / Low Confidence / Ambiguous)
  // 6a. High Value
  if (amount >= cfg.hitlAmountThresholdRupees) {
    return {
      action: 'hitl',
      rule: 'hitl_high_value',
      reason: `Payment amount ₹${amount.toLocaleString('en-IN')} exceeds HITL threshold of ₹${cfg.hitlAmountThresholdRupees.toLocaleString('en-IN')}. Escalate to human reviewer.`,
      shouldCallAi: false,
    }
  }

  // 6b. Low AI Confidence
  if (input.aiConfidence !== undefined && input.aiConfidence < cfg.minAiConfidence) {
    return {
      action: 'hitl',
      rule: 'hitl_low_confidence',
      reason: `AI diagnosis confidence (${(input.aiConfidence * 100).toFixed(0)}%) is below minimum threshold (${(cfg.minAiConfidence * 100).toFixed(0)}%). Escalate to human reviewer.`,
      shouldCallAi: false,
    }
  }

  // 6c. Ambiguous Case
  if (input.isAmbiguous === true) {
    return {
      action: 'hitl',
      rule: 'hitl_ambiguous',
      reason: 'Payment failure details are ambiguous and require human review.',
      shouldCallAi: false,
    }
  }

  // 7. Rule 1: Hard Failure Stop
  const isHardDecline = Boolean(payment.failureCode && HARD_DECLINE_CODES.has(payment.failureCode))
  if (job.failureType === 'hard' || isHardDecline) {
    return {
      action: 'stop_unrecovered',
      rule: 'hard_failure',
      reason: `Hard payment failure (${payment.failureCode ?? job.failureType ?? 'hard'}). Instrument cannot be retried automatically.`,
      shouldCallAi: false,
    }
  }

  // 8. Timing Constraints (Repeat Gap, Salary Window, Quiet Hours / Night Failure)
  let earliestAllowed = new Date(now.getTime())
  let timingRule: StoppingRuleName | null = null
  let timingDetail = ''

  // 8a. Rule 6: Repeat Failure Gap
  if (followUpCount > 0 && lastMsgDate) {
    const requiredGapHours = followUpCount === 1 ? cfg.followUp1GapHours : cfg.followUp2GapHours
    const minGapDate = new Date(lastMsgDate.getTime() + requiredGapHours * 60 * 60 * 1000)
    if (minGapDate.getTime() > earliestAllowed.getTime()) {
      earliestAllowed = minGapDate
      timingRule = 'repeat_failure_gap'
      timingDetail = `Follow-up ${followUpCount} requires minimum ${requiredGapHours}h gap after previous message.`
    }
  }

  // 8b. Rule 5: Salary Window for Soft / Low Balance
  const isLowBalanceOrSoft = job.failureType === 'soft' || payment.failureCode === 'insufficient_funds'
  if (input.preferSalaryWindow && isLowBalanceOrSoft) {
    if (!isInsideSalaryWindow(earliestAllowed, cfg.salaryWindowDays)) {
      const salaryDate = getNextSalaryWindowDate(earliestAllowed, cfg.quietHoursEndHourIST)
      if (salaryDate.getTime() > earliestAllowed.getTime()) {
        earliestAllowed = salaryDate
        timingRule = 'salary_window'
        timingDetail = 'Delayed until next salary window (1st–5th or 25th–28th).'
      }
    }
  }

  // 8c. Rules 3 & 4: Quiet Hours & Night-Time Failure (21:00–08:00 IST)
  if (isInsideQuietHours(earliestAllowed, cfg.quietHoursStartHourIST, cfg.quietHoursEndHourIST)) {
    const morningDate = getNextQuietHoursEnd(earliestAllowed, cfg.quietHoursStartHourIST, cfg.quietHoursEndHourIST)
    earliestAllowed = morningDate

    // If salary window preference was set, ensure the morning date is still within salary window
    if (input.preferSalaryWindow && isLowBalanceOrSoft && !isInsideSalaryWindow(earliestAllowed, cfg.salaryWindowDays)) {
      earliestAllowed = getNextSalaryWindowDate(earliestAllowed, cfg.quietHoursEndHourIST)
      timingRule = 'salary_window'
      timingDetail = 'Delayed until next salary window (1st–5th or 25th–28th).'
    } else if (!timingRule || timingRule === 'repeat_failure_gap') {
      const isNightCreation = followUpCount === 0 && Boolean(payment.createdAt || job.createdAt)
      timingRule = isNightCreation ? 'night_failure' : 'quiet_hours'
      timingDetail = `Delayed outreach during quiet hours (${cfg.quietHoursStartHourIST}:00–0${cfg.quietHoursEndHourIST}:00 IST).`
    }
  }

  // If outreach needs to be scheduled in the future -> delay
  if (earliestAllowed.getTime() > now.getTime()) {
    const formattedIST = formatISTDate(earliestAllowed)
    return {
      action: 'delay',
      rule: timingRule ?? 'quiet_hours',
      reason: `${timingDetail || 'Outreach delayed by scheduling rules.'} Scheduled for ${formattedIST}.`,
      nextAttemptAt: earliestAllowed,
      shouldCallAi: false,
    }
  }

  // 9. All Rules Passed -> Continue to AI Agent
  return {
    action: 'continue',
    rule: 'all_passed',
    reason: 'All stopping and timing rules passed. Ready for AI processing.',
    shouldCallAi: true,
  }
}
