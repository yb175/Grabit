import { useEffect, useState } from 'react'
import { AppShell } from './components/AppShell'
import { CommandView } from './pages/CommandView'
import { JobTimeline } from './pages/JobTimeline'
import { HitlInbox } from './pages/HitlInbox'

interface Route {
  kind: 'command' | 'job' | 'hitl'
  jobId?: string
}

function readRoute(): Route {
  const raw = window.location.hash.replace(/^#/, '') || window.location.pathname
  const match = raw.match(/^\/jobs\/([^/?#]+)\/?$/)
  if (match) {
    try {
      return { kind: 'job', jobId: decodeURIComponent(match[1]) }
    } catch {
      return { kind: 'command' }
    }
  }
  if (/^\/hitl\/?$/.test(raw)) return { kind: 'hitl' }
  return { kind: 'command' }
}

function Header({ route }: { route: Route }) {
  const page = route.kind
  return (
    <AppShell
      nav={[
        { label: 'Command View', href: '#/command-view', active: page === 'command' },
        { label: 'Job Timeline', href: '#/jobs/job_8f91a2', active: page === 'job' },
        { label: 'HITL Inbox', href: '#/hitl', active: page === 'hitl' },
      ]}
      context={<span className="console-context">Operations Console</span>}
      footer={page === 'job' ? null : undefined}
    >
      {page === 'job' && route.jobId ? (
        <JobTimeline requestedId={route.jobId} />
      ) : page === 'hitl' ? (
        <HitlInbox />
      ) : (
        <CommandView />
      )}
    </AppShell>
  )
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute)

  useEffect(() => {
    const update = () => setRoute(readRoute())
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    return () => {
      window.removeEventListener('hashchange', update)
      window.removeEventListener('popstate', update)
    }
  }, [])

  return <Header route={route} />
}
