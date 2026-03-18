export function normalizeSessionId(value: string) {
  return value.trim().replace(/[^a-z0-9]/gi, '').toUpperCase()
}

export function buildShareUrl(sessionId: string) {
  const url = new URL(window.location.href)

  url.search = ''
  url.hash = ''
  url.searchParams.set('session', sessionId)

  return url.toString()
}

export function syncSessionInUrl(sessionId?: string) {
  const url = new URL(window.location.href)

  if (sessionId) {
    url.searchParams.set('session', sessionId)
  } else {
    url.searchParams.delete('session')
  }

  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}
