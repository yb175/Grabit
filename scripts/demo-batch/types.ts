export interface BatchFixture {
  case?: string
  description?: string
  event: string
  duplicate_of?: string
  simulate_timing?: {
    hours_ist?: number
    minutes_ist?: number
    day?: number
    month?: number
    year?: number
  }
  payload: {
    payment?: {
      entity?: {
        id?: string
        order_id?: string | null
        amount?: number
        currency?: string
        method?: string | null
        error_code?: string | null
        error_description?: string | null
        contact?: string | null
        email?: string | null
        notes?: Record<string, string> | null
      }
    }
    subscription?: {
      entity?: {
        id?: string
        payment_id?: string | null
        customer_id?: string | null
        notes?: Record<string, string> | null
      }
    }
    mandate?: {
      entity?: {
        id?: string
        status?: string
      }
    }
    [key: string]: unknown
  }
}

export interface BatchCaseResult {
  caseName: string
  description: string
  fileName: string
  paymentId: string
  amount: number
  formattedAmount: string
  ruleAction: string
  aiFailureType: string
  aiDecision: string
  confidence: string
  jobId: string
  status: string
  outcome: 'created' | 'duplicate' | 'ignored'
  timingNote?: string
}

export interface BatchRunSummary {
  totalCases: number
  createdCount: number
  duplicateCount: number
  ignoredCount: number
  totalAmountRupees: number
  oneClickCount: number
  delayCount: number
  hitlCount: number
  stopCount: number
  results: BatchCaseResult[]
  passedQAChecks: boolean
}
