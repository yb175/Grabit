import { useEffect, useMemo, useState } from 'react'
import { fetchJob, fetchTimeline, type Job, type TimelineEvent } from '../api'
import { fmtINR } from '../format'

type StageId = 'ingested' | 'created' | 'decision' | 'link' | 'message' | 'outcome' | 'ledger' | 'audit'
type Stage = { id: StageId; title: string; event: TimelineEvent; tone: 'system' | 'agent' | 'success' | 'stopped' }

const DEMO_JOBS = [
  { id: 'job_8f91a2', label: 'RECOVERED' },
  { id: 'job_3c72b1', label: 'STOPPED' },
]

function isStop(event: TimelineEvent) {
  return event.type === 'rule_decision' && event.title.toLowerCase().includes('stopping')
}

function buildStages(events: TimelineEvent[]): Stage[] {
  const stages: Stage[] = []
  const add = (id: StageId, title: string, event: TimelineEvent, tone: Stage['tone']) => stages.push({ id, title, event, tone })
  const first = (fn: (event: TimelineEvent) => boolean) => events.find(fn)

  const ingested = first(e => e.type === 'ingested')
  const created = first(e => e.title.toLowerCase().includes('job created'))
  const decision = first(e => e.type === 'agent_decision' || (e.type === 'rule_decision' && !isStop(e)))
  const link = first(e => e.type === 'action' && e.data?.action === 'payment_link_created')
  const message = first(e => e.type === 'message')
  const outcome = first(e => e.type === 'captured') ?? first(isStop)
  const ledger = first(e => e.type === 'ledger')
  const audit = [...events].reverse().find(e => e.type === 'audit')

  if (ingested) add('ingested', 'Ingested', ingested, 'system')
  if (created) add('created', 'Job created', created, 'system')
  if (decision) add('decision', 'AI / rule decision', decision, 'agent')
  if (link) add('link', 'Payment link', link, 'system')
  if (message) add('message', 'Message sent', message, 'agent')
  if (outcome) add('outcome', outcome.type === 'captured' ? 'Captured' : 'Stopped', outcome, outcome.type === 'captured' ? 'success' : 'stopped')
  if (ledger) add('ledger', 'Ledger', ledger, ledger.data?.status === 'recovered' ? 'success' : 'stopped')
  if (audit) add('audit', 'Audit', audit, 'system')
  return stages
}

function eventTitle(event: TimelineEvent): string {
  const amount = typeof event.data?.amount === 'number' ? fmtINR(event.data.amount) : null
  if (event.type === 'captured' && amount) return `Payment captured · ${amount}`
  if (event.type === 'ledger' && event.data?.status === 'recovered' && amount) return `Recovery ledger · ${amount}`
  return event.title
}

function eventTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function detailValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function hostOnly(value: unknown): string {
  if (typeof value !== 'string') return '—'
  try { return new URL(value).host } catch { return '—' }
}

function DetailPanel({ stage, job }: { stage?: Stage; job: Job }) {
  if (!stage) return <div className="timeline-detail-empty">Select a stage</div>
  const { event } = stage
  const data = event.data ?? {}
  const rows: [string, unknown][] = []

  if (stage.id === 'ingested') rows.push(['Payment ID', data.paymentId], ['Amount', typeof data.amount === 'number' ? fmtINR(data.amount) : undefined], ['Failure type', data.failureType], ['Failure code', data.failureCode], ['Reason', data.failureReason])
  if (stage.id === 'created') rows.push(['Job ID', job.id], ['Created at', eventTime(event.timestamp)])
  if (stage.id === 'decision') rows.push(['Decision type', data.decisionType], ['Confidence', data.confidence], ['Explanation', data.explanation], ['Failure type', data.failureType])
  if (stage.id === 'link') rows.push(['URL host', hostOnly(job.paymentLinkUrl)], ['Link ID', data.paymentLinkId])
  if (stage.id === 'message') rows.push(['Channel', data.channel], ['Template', data.templateName], ['Status', data.status], ['Sent at', eventTime(event.timestamp)])
  if (stage.id === 'outcome') rows.push(['Why', isStop(event) ? 'Stopping rule: no retry or outreach' : 'Payment captured; recovery stop'], ['isPaid', job.isPaid], ['No message proof', isStop(event) ? job.messages.length === 0 ? 'No message event' : '—' : undefined])
  if (stage.id === 'ledger') rows.push(['Status', data.status], ['Amount', typeof data.amount === 'number' ? fmtINR(data.amount) : undefined], ['Method', data.recoveryMethod], ['Recovered at', eventTime(event.timestamp)])
  if (stage.id === 'audit') rows.push(['Action', data.action], ['Performed by', event.performedBy], ['Created at', eventTime(event.timestamp)], ['Reason', event.description])

  return <div className="timeline-detail-content">
    <div className="timeline-detail-heading">
      <span className={`timeline-detail-dot ${stage.tone}`} />
      <div><p className="eyebrow">{stage.title}</p><h2>{eventTitle(event)}</h2></div>
      <time className="mono">{eventTime(event.timestamp)}</time>
    </div>
    <dl className="timeline-detail-grid">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{detailValue(value)}</dd></div>)}</dl>
    {stage.id === 'outcome' && isStop(event) && <p className="timeline-proof">No message event exists for this stopped job.</p>}
    <details className="timeline-raw"><summary>Raw event</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>
  </div>
}

export function JobTimeline({ requestedId }: { requestedId?: string }) {
  const [job, setJob] = useState<Job | null>(null)
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const activeId = requestedId && DEMO_JOBS.some(item => item.id === requestedId) ? requestedId : DEMO_JOBS[0].id

  useEffect(() => {
    setSelected(null); setError(null)
    Promise.all([fetchJob(activeId), fetchTimeline(activeId)]).then(([nextJob, nextEvents]) => { setJob(nextJob); setEvents(nextEvents) }).catch(err => setError(err instanceof Error ? err.message : 'Unable to load timeline'))
  }, [activeId])

  const stages = useMemo(() => buildStages(events), [events])
  const current = selected === null ? undefined : stages[selected]

  return <main className="page timeline-page">
    <div className="page-heading"><div><p className="eyebrow">Evidence trail / recovery execution</p><h1>Recovery Job Timeline</h1><p className="page-subtitle">Select a stage to inspect the operational record.</p></div></div>
    <div className="job-tabs" role="tablist">{DEMO_JOBS.map(item => <button key={item.id} className={`job-tab ${activeId === item.id ? 'active' : ''}`} onClick={() => { window.location.hash = `/jobs/${item.id}` }} role="tab" aria-selected={activeId === item.id}><span className="mono">{item.id}</span><strong>{item.label}</strong></button>)}</div>
    {error && <div className="error-state"><strong>Could not load job</strong><span>{error}</span></div>}
    {job && !error && <section className="timeline-workspace" aria-label="Job evidence timeline">
      <nav className="timeline-stack" aria-label="Stages">
        <div className="timeline-stack-head"><span>Stages</span><span className="mono">{stages.length.toString().padStart(2, '0')}</span></div>
        {stages.map((stage, index) => <button key={stage.id} className={`stage-chip ${stage.tone} ${index === selected ? 'selected' : ''}`} onClick={() => setSelected(index)}><span className={`stage-dot ${stage.tone}`} /><span className="stage-chip-copy"><strong>{stage.title}</strong><small className="mono">{eventTime(stage.event.timestamp)}</small></span><span className="stage-status">{stage.id === 'outcome' ? stage.tone === 'success' ? 'paid' : 'stopped' : stage.id === 'ledger' ? detailValue(stage.event.data?.status) : 'logged'}</span></button>)}
      </nav>
      <article className="timeline-detail"><DetailPanel stage={current} job={job} /></article>
    </section>}
  </main>
}
