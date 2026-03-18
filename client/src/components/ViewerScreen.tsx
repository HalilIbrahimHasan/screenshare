import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

import { normalizeSessionId, syncSessionInUrl } from '../lib/session'

type AckResponse = {
  ok?: boolean
  error?: string
  sessionId?: string
}

type OfferPayload = {
  sdp: RTCSessionDescriptionInit
}

type IcePayload = {
  candidate: RTCIceCandidateInit
}

type ViewerScreenProps = {
  initialSessionId: string
}

export function ViewerScreen({ initialSessionId }: ViewerScreenProps) {
  const socketRef = useRef<Socket | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const viewerFrameRef = useRef<HTMLDivElement | null>(null)
  const hasAttemptedInitialJoinRef = useRef(false)
  const joinedSessionIdRef = useRef('')

  const [roomCode, setRoomCode] = useState(initialSessionId)
  const [joinedSessionId, setJoinedSessionId] = useState('')
  const [status, setStatus] = useState(
    initialSessionId ? 'Ready to join this screen share' : 'Enter a room code to join',
  )
  const [error, setError] = useState('')
  const [isSocketReady, setIsSocketReady] = useState(false)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)

  const closePeer = useCallback(() => {
    if (!peerRef.current) {
      return
    }

    peerRef.current.onicecandidate = null
    peerRef.current.ontrack = null
    peerRef.current.onconnectionstatechange = null
    peerRef.current.close()
    peerRef.current = null
  }, [])

  const clearViewerState = useCallback((nextStatus: string) => {
    closePeer()
    setRemoteStream(null)
    joinedSessionIdRef.current = ''
    setJoinedSessionId('')
    setStatus(nextStatus)
  }, [closePeer])

  const handleJoinSession = useCallback(
    async (input?: string) => {
      const socket = socketRef.current
      const normalizedRoomCode = normalizeSessionId(input ?? roomCode)

      if (!normalizedRoomCode) {
        setError('Enter the room code from the host screen.')
        return
      }

      if (!socket) {
        setError('The signaling service is not connected yet.')
        return
      }

      setError('')
      setRoomCode(normalizedRoomCode)
      setStatus('Connecting to host...')

      socket.emit(
        'viewer:join-session',
        { sessionId: normalizedRoomCode },
        (response: AckResponse) => {
          if (!response.ok || !response.sessionId) {
            setError(response.error ?? 'Unable to join that session.')
            setStatus('Enter a room code to join')
            return
          }

          joinedSessionIdRef.current = response.sessionId
          setJoinedSessionId(response.sessionId)
          setStatus('Waiting for the host screen...')
          syncSessionInUrl(response.sessionId)
        },
      )
    },
    [roomCode],
  )

  useEffect(() => {
    if (!videoRef.current) {
      return
    }

    videoRef.current.srcObject = remoteStream
  }, [remoteStream])

  useEffect(() => {
    const socket = io({
      path: '/socket.io',
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setIsSocketReady(true)
      if (!joinedSessionIdRef.current) {
        setStatus(initialSessionId ? 'Ready to join this screen share' : 'Enter a room code to join')
      }

      if (initialSessionId && !hasAttemptedInitialJoinRef.current) {
        hasAttemptedInitialJoinRef.current = true
        void handleJoinSession(initialSessionId)
      }
    })

    socket.on('disconnect', () => {
      setIsSocketReady(false)
      setStatus('Connection lost')
    })

    socket.on('host:offer', async ({ sdp }: OfferPayload) => {
      const socketInstance = socketRef.current

      if (!socketInstance || !joinedSessionIdRef.current) {
        return
      }

      closePeer()

      const peer = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      })

      peerRef.current = peer

      peer.onicecandidate = ({ candidate }) => {
        if (!candidate) {
          return
        }

        socketInstance.emit('viewer:ice-candidate', {
          sessionId: joinedSessionIdRef.current,
          candidate,
        })
      }

      peer.ontrack = ({ streams }) => {
        const [incomingStream] = streams

        if (!incomingStream) {
          return
        }

        setRemoteStream(incomingStream)
        setStatus('Sharing live')
      }

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
          setStatus('Connection lost')
        }
      }

      try {
        await peer.setRemoteDescription(new RTCSessionDescription(sdp))

        const answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)

        socketInstance.emit('viewer:answer', {
          sessionId: joinedSessionIdRef.current,
          sdp: answer,
        })
      } catch (peerError) {
        setError(
          peerError instanceof Error ? peerError.message : 'Unable to connect to the host stream.',
        )
      }
    })

    socket.on('host:ice-candidate', async ({ candidate }: IcePayload) => {
      if (!peerRef.current) {
        return
      }

      try {
        await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (peerError) {
        setError(
          peerError instanceof Error
            ? peerError.message
            : 'Unable to apply the host network candidate.',
        )
      }
    })

    socket.on('session:ended', ({ reason }: { reason?: string }) => {
      clearViewerState(reason ?? 'Screen sharing ended')
    })

    return () => {
      socket.emit('viewer:leave-session')
      socket.disconnect()
      closePeer()
    }
  }, [clearViewerState, closePeer, handleJoinSession, initialSessionId])

  function handleLeaveSession() {
    socketRef.current?.emit('viewer:leave-session')
    syncSessionInUrl()
    clearViewerState('You left the session')
  }

  async function handleFullscreen() {
    if (!viewerFrameRef.current) {
      return
    }

    try {
      await viewerFrameRef.current.requestFullscreen()
    } catch {
      setError('Fullscreen was blocked by the browser.')
    }
  }

  return (
    <section className="workspace-grid viewer-layout">
      <div className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Viewer</p>
            <h2>Join from your phone</h2>
          </div>
          <span className={`status-pill ${remoteStream ? 'live' : ''}`}>{status}</span>
        </div>

        <p className="panel-copy">
          Paste the link or enter the room code to watch the host screen. The viewer is
          watch-only and never sends audio or video upstream.
        </p>

        <label className="field">
          <span className="label">Room code</span>
          <div className="field-row">
            <input
              value={roomCode}
              onChange={(event) => setRoomCode(normalizeSessionId(event.target.value))}
              placeholder="Enter room code"
              inputMode="text"
              autoCapitalize="characters"
            />
            <button className="primary-button" onClick={() => void handleJoinSession()}>
              Join session
            </button>
          </div>
        </label>

        <div className="button-row">
          <button className="secondary-button" onClick={handleFullscreen} disabled={!remoteStream}>
            Full screen
          </button>
          <button className="ghost-button" onClick={handleLeaveSession} disabled={!joinedSessionId}>
            Leave
          </button>
        </div>

        <div className="info-grid">
          <div className="info-card">
            <span className="label">Current room</span>
            <strong>{joinedSessionId || 'Not joined yet'}</strong>
          </div>
          <div className="info-card">
            <span className="label">Signal</span>
            <strong>{isSocketReady ? 'Connected' : 'Offline'}</strong>
          </div>
        </div>

        <div className="note-card">
          <h3>Best mobile viewing</h3>
          <p>
            Rotate to landscape and use full screen for the clearest text. Pinch zoom stays
            enabled inside supported mobile browsers.
          </p>
        </div>

        {error ? <p className="error-text">{error}</p> : null}
      </div>

      <div className="panel stream-panel mobile-first">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Live view</p>
            <h2>Viewer screen</h2>
          </div>
        </div>

        <div className="stream-frame viewer-frame" ref={viewerFrameRef}>
          {remoteStream ? (
            <video ref={videoRef} autoPlay playsInline />
          ) : (
            <div className="empty-state">
              <strong>No screen connected</strong>
              <p>Join a room to watch the host screen here.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
