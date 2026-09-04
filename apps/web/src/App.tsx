import { AppShell } from './components/AppShell'
import { CommandView } from './pages/CommandView'

// Single page today; the shell (header + footer) is shared, so future pages
// (timeline, HITL inbox) swap only the children + nav.
export default function App() {
  return (
    <AppShell
      nav={[{ label: 'Command View', href: '#/command-view', active: true }]}
      context={
        <span className="merchant-chip">
          rzp_test <span className="sep">·</span> Last 30 days
        </span>
      }
    >
      <CommandView />
    </AppShell>
  )
}