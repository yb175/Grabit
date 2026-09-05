// Command View API client — @grabit/api over HTTP.
// The web app polls these endpoints every few seconds; see pages/CommandView.

const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3100'

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
  createdAt: string
  updatedAt: string
  ledger: LedgerEntry[]
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const res = await fetch(`${API_URL}${path}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

export function fetchSummary(signal?: AbortSignal): Promise<Summary> {
  return getJson<Summary>('/dashboard/summary', signal)
}

export async function fetchJobs(signal?: AbortSignal): Promise<Job[]> {
  const from = new Date(Date.now() - WINDOW_MS).toISOString()
  const data = await getJson<{ jobs: Job[] }>(`/jobs?from=${encodeURIComponent(from)}`, signal)
  return data.jobs
}

// The View link in the table opens the job timeline (JSON).
export function timelineUrl(jobId: string): string {
  return `${API_URL}/jobs/${jobId}/timeline`
}