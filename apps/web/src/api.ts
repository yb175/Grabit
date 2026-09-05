// Command View API client — @grabit/api over HTTP.
// The web app polls these endpoints every few seconds; see pages/CommandView.

const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3100'

// /hitl/* is the one route group behind x-api-key (v0 auth, fail-closed). The
// browser reads the demo key from VITE_GRABIT_API_KEY; unset => requests 401
// and the inbox shows the API-unreachable error state.
const API_KEY: string = import.meta.env.VITE_GRABIT_API_KEY ?? ''

// Matches the dashboard KPI window — the table must describe "Last 30 days" too.
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000

// Hard cap so a hung API can't leave the dashboard without an error state.
const REQUEST_TIMEOUT_MS = 10_000

export interface Summary {
  windowDays: number
  recoveredAmount: number
  recoveredCases: number
  activeJobs: number
  stopped: number
  hitlPending: number
  oneClickRecoveredAmount: number
}

export interface LedgerEntry {
  id: string
  amount: number
  status: string
  recoveryMethod: string | null
  recoveredAt: string | null
}

export interface Job {
  id: string
  status: string
  failureType: string
  amount: number
  currency: string
  createdAt: string
  updatedAt: string
  followUpCount: number
  maxFollowUps: number
  paidAt: string | null
  isPaid: boolean
  ledger: LedgerEntry[]
  messages: unknown[]
  paymentLinkUrl?: string | null
}

export interface TimelineEvent {
  id: string
  type: 'ingested' | 'rule_decision' | 'agent_decision' | 'hitl' | 'action' | 'message' | 'captured' | 'ledger' | 'audit'
  title: string
  description?: string
  reason?: string | null
  performedBy?: string | null
  timestamp: string
  data?: Record<string, unknown>
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const res = await fetch(`${API_URL}${path}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

async function postJson<T>(path: string): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: '{}',
    signal: timeout,
  })
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

function authHeaders(): Record<string, string> {
  return API_KEY ? { 'x-api-key': API_KEY, 'x-reviewer': 'ops-console' } : {}
}

export function fetchSummary(signal?: AbortSignal): Promise<Summary> {
  return getJson<Summary>('/dashboard/summary', signal)
}

export async function fetchJobs(signal?: AbortSignal): Promise<Job[]> {
  const from = new Date(Date.now() - WINDOW_MS).toISOString()
  const data = await getJson<{ jobs: Job[] }>(`/jobs?from=${encodeURIComponent(from)}`, signal)
  return data.jobs
}

export function jobUrl(jobId: string): string {
  return `#/jobs/${encodeURIComponent(jobId)}`
}

export function fetchJob(jobId: string, signal?: AbortSignal): Promise<Job> {
  return getJson<{ job: Job }>(`/jobs/${encodeURIComponent(jobId)}`, signal).then((data) => data.job)
}

export function fetchTimeline(jobId: string, signal?: AbortSignal): Promise<TimelineEvent[]> {
  return getJson<{ timeline: TimelineEvent[] }>(`/jobs/${encodeURIComponent(jobId)}/timeline`, signal).then(
    (data) => data.timeline,
  )
}

// ---------------------------------------------------------------------------
// HITL review queue (issue #34) — Screen C, /hitl routes
// ---------------------------------------------------------------------------

// GET /hitl?status=pending shape: raw prisma rows nested as-is (amount is a
// Prisma Decimal and arrives as a JSON string; Number() it before fmtINR).
export interface HitlTask {
  id: string
  recoveryJobId: string
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: string | null
  notes: string | null
  createdAt: string
  recoveryJob: {
    id: string
    status: string
    failureType: string
    failedPayment: {
      amount: string | number
    }
    decisions: Array<{
      decisionType: string
      confidence: number | null
    }>
  }
}

export function fetchHitlTasks(status: 'pending' | 'approved' | 'rejected', signal?: AbortSignal): Promise<HitlTask[]> {
  return getJson<{ tasks: HitlTask[] }>(`/hitl?status=${status}`, signal).then((data) => data.tasks)
}

export function approveHitlTask(taskId: string): Promise<{ status: string }> {
  return postJson<{ status: string }>(`/hitl/${encodeURIComponent(taskId)}/approve`)
}

export function rejectHitlTask(taskId: string): Promise<{ status: string }> {
  return postJson<{ status: string }>(`/hitl/${encodeURIComponent(taskId)}/reject`)
}