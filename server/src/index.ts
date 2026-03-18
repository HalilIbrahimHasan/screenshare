import crypto from 'node:crypto'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'

type Session = {
  hostSocketId: string
  viewers: Set<string>
}

type SessionAck = {
  ok?: boolean
  error?: string
  sessionId?: string
}

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
})

const sessions = new Map<string, Session>()
const hostSessionBySocketId = new Map<string, string>()
const viewerSessionBySocketId = new Map<string, string>()

const port = Number(process.env.PORT ?? 3001)
const currentFilePath = fileURLToPath(import.meta.url)
const currentDirPath = path.dirname(currentFilePath)
const clientDistPath = path.resolve(currentDirPath, '../../client/dist')

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

if (existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath))

  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'))
  })
}

function generateSessionId() {
  let sessionId = ''

  while (!sessionId || sessions.has(sessionId)) {
    sessionId = crypto.randomBytes(4).toString('hex').toUpperCase()
  }

  return sessionId
}

function endSession(sessionId: string, reason: string) {
  const session = sessions.get(sessionId)

  if (!session) {
    return
  }

  for (const viewerSocketId of session.viewers) {
    viewerSessionBySocketId.delete(viewerSocketId)
    io.to(viewerSocketId).emit('session:ended', { reason })
  }

  hostSessionBySocketId.delete(session.hostSocketId)
  sessions.delete(sessionId)
}

function removeViewerFromSession(viewerSocketId: string) {
  const sessionId = viewerSessionBySocketId.get(viewerSocketId)

  if (!sessionId) {
    return
  }

  const session = sessions.get(sessionId)
  viewerSessionBySocketId.delete(viewerSocketId)

  if (!session) {
    return
  }

  session.viewers.delete(viewerSocketId)
  io.to(session.hostSocketId).emit('viewer:left', { viewerId: viewerSocketId })
}

io.on('connection', (socket) => {
  socket.on('host:create-session', (callback?: (response: SessionAck) => void) => {
    const existingSessionId = hostSessionBySocketId.get(socket.id)

    if (existingSessionId) {
      endSession(existingSessionId, 'Host started a new session')
    }

    const sessionId = generateSessionId()

    sessions.set(sessionId, {
      hostSocketId: socket.id,
      viewers: new Set<string>(),
    })
    hostSessionBySocketId.set(socket.id, sessionId)

    callback?.({ ok: true, sessionId })
  })

  socket.on(
    'viewer:join-session',
    (
      payload: { sessionId?: string },
      callback?: (response: SessionAck) => void,
    ) => {
      const rawSessionId = payload.sessionId?.trim().toUpperCase()

      if (!rawSessionId) {
        callback?.({ error: 'Enter a valid room code.' })
        return
      }

      const session = sessions.get(rawSessionId)

      if (!session) {
        callback?.({ error: 'Session not found or no longer active.' })
        return
      }

      removeViewerFromSession(socket.id)

      session.viewers.add(socket.id)
      viewerSessionBySocketId.set(socket.id, rawSessionId)

      io.to(session.hostSocketId).emit('viewer:joined', { viewerId: socket.id })
      callback?.({ ok: true, sessionId: rawSessionId })
    },
  )

  socket.on('viewer:leave-session', () => {
    removeViewerFromSession(socket.id)
  })

  socket.on(
    'host:offer',
    (payload: { sessionId?: string; viewerId?: string; sdp?: RTCSessionDescriptionInit }) => {
      const { sessionId, viewerId, sdp } = payload

      if (!sessionId || !viewerId || !sdp) {
        return
      }

      const session = sessions.get(sessionId)

      if (!session || session.hostSocketId !== socket.id || !session.viewers.has(viewerId)) {
        return
      }

      io.to(viewerId).emit('host:offer', { sdp })
    },
  )

  socket.on(
    'viewer:answer',
    (payload: { sessionId?: string; sdp?: RTCSessionDescriptionInit }) => {
      const { sessionId, sdp } = payload

      if (!sessionId || !sdp) {
        return
      }

      const session = sessions.get(sessionId)

      if (!session || !session.viewers.has(socket.id)) {
        return
      }

      io.to(session.hostSocketId).emit('viewer:answer', { viewerId: socket.id, sdp })
    },
  )

  socket.on(
    'host:ice-candidate',
    (payload: { sessionId?: string; viewerId?: string; candidate?: RTCIceCandidateInit }) => {
      const { sessionId, viewerId, candidate } = payload

      if (!sessionId || !viewerId || !candidate) {
        return
      }

      const session = sessions.get(sessionId)

      if (!session || session.hostSocketId !== socket.id || !session.viewers.has(viewerId)) {
        return
      }

      io.to(viewerId).emit('host:ice-candidate', { candidate })
    },
  )

  socket.on(
    'viewer:ice-candidate',
    (payload: { sessionId?: string; candidate?: RTCIceCandidateInit }) => {
      const { sessionId, candidate } = payload

      if (!sessionId || !candidate) {
        return
      }

      const session = sessions.get(sessionId)

      if (!session || !session.viewers.has(socket.id)) {
        return
      }

      io.to(session.hostSocketId).emit('viewer:ice-candidate', {
        viewerId: socket.id,
        candidate,
      })
    },
  )

  socket.on('host:stop-sharing', (payload: { sessionId?: string }) => {
    const sessionId = payload.sessionId

    if (!sessionId) {
      return
    }

    const session = sessions.get(sessionId)

    if (!session || session.hostSocketId !== socket.id) {
      return
    }

    endSession(sessionId, 'Screen sharing ended')
  })

  socket.on('disconnect', () => {
    const hostedSessionId = hostSessionBySocketId.get(socket.id)

    if (hostedSessionId) {
      endSession(hostedSessionId, 'Host left the session')
    }

    removeViewerFromSession(socket.id)
  })
})

httpServer.listen(port, () => {
  console.log(`Screen share signaling server running on http://localhost:${port}`)
})
