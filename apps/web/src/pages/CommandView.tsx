import { useEffect, useState } from 'react'
import { fetchSummary, fetchJobs, timelineUrl, type Summary, type Job, type LedgerEntry } from '../api'
import { fmtINR, fmtDateTime, shortId, failureLabel } from '../format'
import { KpiCard } from '../components/KpiCard'

// Poll cadence while the tab is visible (issue #32 realtime requirement).
const POLL_MS = 3000

type Tone = 'green' | 'grey' | 'amber' | 'neutral'

function statusInfo(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'recovered':
      return { label: 'RECOVERED', tone: 'green' }
    case 'unrecovered':
    case 'rejected':
    case 'stale':
      return { label: 'STOPPED', tone: 'grey' }
    case 'hitl':
      return { label: 'HITL PENDING', tone: 'amber' }
    default:
      return { label: status.toUpperCase(), tone: 'neutral' }
  }
}

/** Latest recovered ledger entry for a job (ledger is desc-ordered). */
function latestRecovered(job: Job): LedgerEntry | null {
  return job.ledger.find((l) => l.status === 'recovered') ?? null
}

export function CommandView() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  useEffect(() => {
    let interval: number | undefined

    const poll = async () => {
      try {
        const [s, j] = await Promise.all([fetchSummary(), fetchJobs()])
        setSummary(s)
        setJobs(j)
        setError(null)
        setLastUpdated(
          new Date().toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'API unreachable')
      }
    }

    // Tick every 3s but only while the tab is visible; the initial load and
    // a visibilitychange to visible always poll immediately.
    const tick = () => {
      if (document.visibilityState === 'visible') poll()
    }

    poll()
    interval = window.setInterval(tick, POLL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') poll()
    }
    // Coming back to the dashboard re-polls immediately.
    const onFocus = () => poll()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const s = summary
  const list = jobs ?? []

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Command View</h1>
          <p className="page-sub">Recovery pipeline · Last 30 days</p>
        </div>
        <div className="poll-note">
          {error ? (
            <span className="poll-error">API unreachable — retrying…</span>
          ) : (
            lastUpdated && <span className="poll-ok">updated {lastUpdated} · 3s</span>
          )}
        </div>
      </div>

      <div className="kpi-grid">
        <KpiCard
          label="Recovered"
          value={fmtINR(s?.recoveredAmount ?? 0)}
          mono
          sub="total money recovered"
          tag="GET /ledger"
        />
        <KpiCard
          label="Recovered cases"
          value={s?.recoveredCases ?? 0}
          sub="closed as recovered"
          tag="GET /ledger"
        />
        <KpiCard
          label="Active jobs"
          value={s?.activeJobs ?? 0}
          sub="pending · processing · waiting"
          tag="GET /jobs"
        />
        <KpiCard
          label="Stopped"
          value={s?.stopped ?? 0}
          sub="unrecovered · rejected · stale"
          tag="GET /jobs"
        />
        <KpiCard
          label="HITL pending"
          value={s?.hitlPending ?? 0}
          badge={{ text: 'requires action' }}
          sub="awaiting human review"
          tag="GET /hitl?status=pending"
        />
        <KpiCard
          label="One-click recovered"
          value={fmtINR(s?.oneClickRecoveredAmount ?? 0)}
          mono
          sub="via one-click links"
          tag="GET /ledger"
        />
      </div>

      <section className="table-card">
        <div className="table-head">
          <h2>Recovery jobs</h2>
          <span className="table-count">{list.length} jobs</span>
        </div>
        <div className="table-wrap">
          <table className="jobs-table">
            <thead>
              <tr>
                <th>Job ID</th>
                <th className="num">Failed ₹</th>
                <th>Failure Type</th>
                <th>Status</th>
                <th className="num">Recovered ₹</th>
                <th>Recovered At</th>
                <th className="action-col">View</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty-row">
                    No recovery jobs yet — run <code>pnpm db:seed</code> or send a webhook.
                  </td>
                </tr>
              )}
              {list.map((job) => {
                const info = statusInfo(job.status)
                const recovered = latestRecovered(job)
                return (
                  <tr key={job.id}>
                    <td className="mono id-cell" title={job.id}>
                      {shortId(job.id)}
                    </td>
                    <td className="mono num">{fmtINR(job.amount)}</td>
                    <td>{failureLabel(job.failureType)}</td>
                    <td>
                      <span className={`pill ${info.tone}`}>{info.label}</span>
                    </td>
                    <td className="mono num">{recovered ? fmtINR(Number(recovered.amount)) : '—'}</td>
                    <td className="mono">{fmtDateTime(recovered?.recoveredAt ?? null)}</td>
                    <td className="action-col">
                      <a className="view-link" href={timelineUrl(job.id)} target="_blank" rel="noreferrer">
                        View
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}