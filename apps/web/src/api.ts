// Command View API client — @grabit/api over HTTP.
// The web app polls these endpoints every few seconds; see pages/CommandView.

const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3100'

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

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`)
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

export function fetchSummary(): Promise<Summary> {
  return getJson<Summary>('/dashboard/summary')
}

export async function fetchJobs(): Promise<Job[]> {
  const data = await getJson<{ jobs: Job[] }>('/jobs')
  return data.jobs
}

// The View link in the table opens the job timeline (JSON).
export function timelineUrl(jobId: string): string {
  return `${API_URL}/jobs/${jobId}/timeline`
}