import type { ReactNode } from 'react'

export interface NavItem {
  label: string
  href: string
  active?: boolean
}

interface AppShellProps {
  /** Center navigation items — other pages add their own links here. */
  nav?: NavItem[]
  /** Right-side merchant context chip, e.g. "rzp_test · Last 30 days". */
  context?: ReactNode
  children: ReactNode
  /** Bottom footer; undefined renders the default pipeline line, null hides it,
   * and any other node replaces the pipeline. */
  footer?: ReactNode
}

const PIPELINE_LINE = ['webhook', 'rules', 'AI', 'HITL/template', 'captured', 'ledger']

/**
 * Shared page shell: brand header (live badge + nav + context) on top and the
 * pipeline footer on the bottom. Page content goes in `children`, so any page
 * (Command View today, timeline / HITL inbox later) reuses the same chrome.
 */
export function AppShell({ nav = [], context, children, footer }: AppShellProps) {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">Grabit</span>
          <span className="live">
            <span className="live-dot" aria-hidden="true" />
            LIVE
          </span>
        </div>
        {nav.length > 0 && (
          <nav className="topbar-nav" aria-label="Pages">
            {nav.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className={item.active ? 'nav-link active' : 'nav-link'}
                aria-current={item.active ? 'page' : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
        )}
        <div className="topbar-right">{context}</div>
      </header>

      <main className="content">{children}</main>

      {footer === undefined ? (
        <footer className="pipeline">
          {PIPELINE_LINE.map((step, i) => (
            <span key={step} className="pipeline-step">
              {step}
              {i < PIPELINE_LINE.length - 1 && <span className="pipeline-arrow">→</span>}
            </span>
          ))}
        </footer>
      ) : (
        footer
      )}
    </div>
  )
}