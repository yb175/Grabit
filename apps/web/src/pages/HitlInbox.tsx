import { useEffect, useState } from 'react'
import { fetchHitlTasks, approveHitlTask, rejectHitlTask, type HitlTask } from '../api'
import { fmtINR, fmtDateTime, failureLabel } from '../format'

// Review-queue cadence; Command View's HITL KPI repolls on its own 3s timer.
const POLL_MS = 5000

export function HitlInbox() {
  const [tasks, setTasks] = useState<HitlTask[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  // Generation counter: increments on every review action so the background
  // poll discards responses from fetches that started before the action.
  const [pollGen, setPollGen] = useState(0)

  useEffect(() => {
    let interval: number | undefined
    let cancelled = false
    let inFlight: AbortController | null = null
    const gen = pollGen // capture current generation

    const poll = async () => {
      if (inFlight) return
      const controller = new AbortController()
      inFlight = controller
      try {
        const list = await fetchHitlTasks('pending', controller.signal)
        // Discard if a review action started a newer generation or unmounted.
        if (cancelled || controller.signal.aborted) return
        setTasks(list)
        setError(null)
      } catch (err) {
        if (cancelled || controller.signal.aborted) return
        setError(err instanceof Error ? err.message : 'API unreachable')
      } finally {
        if (inFlight === controller) inFlight = null
      }
    }

    const tick = () => {
      if (document.visibilityState === 'visible') poll()
    }
    poll()
    interval = window.setInterval(tick, POLL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') poll()
    }
    const onFocus = () => poll()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      inFlight?.abort()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  // Re-run the polling loop after every review action (pollGen bump) so the
  // first poll after approve/reject comes from a fresh, non-cancelled loop.
  }, [pollGen]) // eslint-disable-line react-hooks/exhaustive-deps

  const review = async (task: HitlTask, action: 'approve' | 'reject') => {
    if (busy[task.id]) return
    setBusy((b) => ({ ...b, [task.id]: action }))
    setActionError(null)
    try {
      await (action === 'approve' ? approveHitlTask(task.id) : rejectHitlTask(task.id))
      // Bump generation — the current poll loop is cancelled and a fresh one
      // starts immediately, preventing a stale in-flight poll from overwriting
      // the refetch result with the pre-review pending list.
      setPollGen((g) => g + 1)
    } catch (err) {
      // The POST failed — the action did not commit. Report it without hiding
      // a successful action behind a refresh error.
      setActionError(
        `${action === 'approve' ? 'Approve' : 'Reject'} failed — ${err instanceof Error ? err.message : 'retry'}`,
      )
    } finally {
      setBusy((b) => {
        const next = { ...b }
        delete next[task.id]
        return next
      })
    }
  }

  const list = tasks ?? []
  const loading = tasks === null && !error
  // Show amber highlight for the highest-value case in any non-empty queue
  // (includes queues with a single item).
  const highest = list.length > 0 ? Math.max(...list.map((t) => Number(t.recoveryJob.failedPayment.amount))) : null

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>HITL Inbox</h1>
          <p className="page-sub">
            {loading ? '…' : error ? 'queue unavailable' : `${list.length} ${list.length === 1 ? 'case' : 'cases'} awaiting human review`}
          </p>
        </div>
        <div className="poll-note">
          {error ? (
            <span className="poll-error" title={error}>
              {error.includes('401') ? 'Review API needs VITE_GRABIT_API_KEY — retrying…' : 'API unreachable — retrying…'}
            </span>
          ) : (
            <span className="poll-ok">live queue · GET /hitl?status=pending</span>
          )}
        </div>
      </div>

      <section className="table-card">
        <div className="table-head">
          <h2>Review queue</h2>
          {actionError && <span className="poll-error">{actionError}</span>}
          <span className="table-count">
            {loading ? <span className="skeleton skeleton-count" /> : `${list.length} pending`}
          </span>
        </div>
        <div className="table-wrap">
          <table className="jobs-table hitl-table">
            <thead>
              <tr>
                <th className="num">Failed ₹</th>
                <th>Failure Type</th>
                <th>Escalation Reason</th>
                <th>AI Decision</th>
                <th className="num">Confidence</th>
                <th>Created At</th>
                <th>Assigned To</th>
                <th>Status</th>
                <th className="action-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={`skeleton-row-${i}`} className="skeleton-row">
                    <td className="num"><span className="skeleton skeleton-text skeleton-num" /></td>
                    <td><span className="skeleton skeleton-text skeleton-type" /></td>
                    <td><span className="skeleton skeleton-text skeleton-type" /></td>
                    <td><span className="skeleton skeleton-text skeleton-type" /></td>
                    <td className="num"><span className="skeleton skeleton-text skeleton-num" /></td>
                    <td><span className="skeleton skeleton-text skeleton-date" /></td>
                    <td><span className="skeleton skeleton-text skeleton-date" /></td>
                    <td><span className="skeleton skeleton-pill" /></td>
                    <td className="action-col"><span className="skeleton skeleton-text skeleton-action" /></td>
                  </tr>
                ))}
              {!loading && error && (
                <tr>
                  <td colSpan={9} className="empty-row">
                    Queue unavailable — {error.includes('401') ? 'check VITE_GRABIT_API_KEY' : 'retrying…'}
                  </td>
                </tr>
              )}
              {!loading && !error && list.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty-row">
                    0 cases — nothing awaiting human review. Run <code>pnpm db:seed</code> to add demo HITL tasks.
                  </td>
                </tr>
              )}
              {!loading &&
                list.map((task) => {
                  const decision = task.recoveryJob.decisions[0]
                  const amount = Number(task.recoveryJob.failedPayment.amount)
                  const high = highest !== null && amount === highest
                  return (
                    <tr key={task.id} className={high ? 'row-high' : undefined}>
                      <td className="mono num">{fmtINR(amount)}</td>
                      <td>{failureLabel(task.recoveryJob.failureType)}</td>
                      <td className="reason-cell" title={task.reason}>
                        {task.reason}
                      </td>
                      <td className="mono">{decision?.decisionType ?? '—'}</td>
                      <td className="mono num">{decision?.confidence != null ? decision.confidence.toFixed(2) : '—'}</td>
                      <td className="mono">{fmtDateTime(task.createdAt)}</td>
                      <td>{task.reviewedBy ?? '—'}</td>
                      <td>
                        <span className="pill amber">PENDING</span>
                      </td>
                      <td className="action-col">
                        <span className="review-actions">
                          <button
                            type="button"
                            className="btn-approve"
                            disabled={Boolean(busy[task.id])}
                            onClick={() => review(task, 'approve')}
                          >
                            {busy[task.id] === 'approve' ? '…' : 'Approve'}
                          </button>
                          <button
                            type="button"
                            className="btn-reject"
                            disabled={Boolean(busy[task.id])}
                            onClick={() => review(task, 'reject')}
                          >
                            {busy[task.id] === 'reject' ? '…' : 'Reject'}
                          </button>
                        </span>
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