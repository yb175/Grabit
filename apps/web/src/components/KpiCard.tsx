import type { ReactNode } from 'react'

interface KpiCardProps {
  label: string
  value?: ReactNode
  /** Money values render in JetBrains Mono; counts stay in Inter. */
  mono?: boolean
  sub?: string
  /** Data-source annotation, e.g. "GET /ledger". */
  tag?: string
  /** Inline badge next to the label (e.g. HITL "requires action"). */
  badge?: { text: string }
  /** Shimmer skeleton placeholder while loading. */
  loading?: boolean
}

export function KpiCard({ label, value, mono, sub, tag, badge, loading }: KpiCardProps) {
  return (
    <section className="kpi-card">
      <div className="kpi-label">
        {label}
        {badge && !loading && <span className="kpi-badge">{badge.text}</span>}
        {badge && loading && <span className="skeleton skeleton-badge" />}
      </div>
      {loading ? (
        <div className="skeleton skeleton-val" />
      ) : (
        <div className={mono ? 'kpi-value mono' : 'kpi-value'}>{value}</div>
      )}
      {loading ? (
        <div className="skeleton skeleton-sub" />
      ) : (
        sub && <div className="kpi-sub">{sub}</div>
      )}
      {loading ? (
        <div className="skeleton skeleton-tag" />
      ) : (
        tag && <div className="kpi-tag">{tag}</div>
      )}
    </section>
  )
}