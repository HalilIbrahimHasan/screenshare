import { useMemo, useState } from 'react'

import { HostScreen } from './components/HostScreen'
import { ViewerScreen } from './components/ViewerScreen'
import { normalizeSessionId } from './lib/session'
import './App.css'

function App() {
  const sessionFromUrl = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return normalizeSessionId(params.get('session') ?? '')
  }, [])

  const [mode, setMode] = useState<'host' | 'viewer'>(sessionFromUrl ? 'viewer' : 'host')

  return (
    <main className="app-shell">
      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow">Screen Share Web App</p>
          <h1>Share a desktop screen to any phone browser</h1>
          <p className="hero-text">
            A lightweight, no-audio screen share built for readable mobile viewing,
            clear status feedback, and fast session links.
          </p>
        </div>

        <div className="mode-toggle" role="tablist" aria-label="Choose app mode">
          <button
            className={mode === 'host' ? 'mode-button active' : 'mode-button'}
            onClick={() => setMode('host')}
            role="tab"
            aria-selected={mode === 'host'}
          >
            Host
          </button>
          <button
            className={mode === 'viewer' ? 'mode-button active' : 'mode-button'}
            onClick={() => setMode('viewer')}
            role="tab"
            aria-selected={mode === 'viewer'}
          >
            Viewer
          </button>
        </div>
      </section>

      <section className="summary-strip">
        <div className="summary-card">
          <span className="label">Streaming</span>
          <strong>WebRTC video only</strong>
        </div>
        <div className="summary-card">
          <span className="label">Audio</span>
          <strong>Disabled end to end</strong>
        </div>
        <div className="summary-card">
          <span className="label">Mobile</span>
          <strong>Landscape and fullscreen ready</strong>
        </div>
      </section>

      {mode === 'host' ? <HostScreen /> : <ViewerScreen initialSessionId={sessionFromUrl} />}
    </main>
  )
}

export default App
