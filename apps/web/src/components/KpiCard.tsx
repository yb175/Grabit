import type { ReactNode } from 'react'

interface KpiCardProps {
  label: string
  value: ReactNode
  /** Money values render in JetBrains Mono; counts stay in Inter. */
  mono?: boolean
  sub?: string
  /** Data-source annotation, e.g. "GET /ledger". */
  tag?: string
  /** Inline badge next to the label (e.g. HITL "requires action"). */
  badge?: { text: string }
}

export function KpiCard({ label, value, mono, sub, tag, badge }: KpiCardProps) {
  return (
    <section className="kpi-card">
      <div className="kpi-label">
        {label}
        {badge && <span className="kpi-badge">{badge.text}</span>}
      </div>
      <div className={mono ? 'kpi-value mono' : 'kpi-value'}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
      {tag && <div className="kpi-tag">{tag}</div>}
    </section>
  )
}