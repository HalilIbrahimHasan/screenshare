import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

import { buildShareUrl } from '../lib/session'

type AckResponse = {
  ok?: boolean
  error?: string
  sessionId?: string
}

type ViewerJoinPayload = {
  viewerId: string
}

type ViewerSignalPayload = {
  viewerId: string
  sdp: RTCSessionDescriptionInit
}

type ViewerIcePayload = {
  viewerId: string
  candidate: RTCIceCandidateInit
}

export function HostScreen() {
  const socketRef = useRef<Socket | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const viewerIdsRef = useRef<Set<string>>(new Set())
  const localVideoRef = useRef<HTMLVideoElement | null>(null)

  const [status, setStatus] = useState('Ready to start a session')
  const [error, setError] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [shareUrl, setShareUrl] = useState('')
  const [viewerCount, setViewerCount] = useState(0)
  const [copied, setCopied] = useState(false)
  const [isSharing, setIsSharing] = useState(false)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)

  const closePeer = useCallback((viewerId: string) => {
    const peer = peersRef.current.get(viewerId)

    if (!peer) {
      return
    }

    peer.onicecandidate = null
    peer.ontrack = null
    peer.onconnectionstatechange = null
    peer.close()
    peersRef.current.delete(viewerId)
  }, [])

  const closeAllPeers = useCallback(() => {
    for (const viewerId of peersRef.current.keys()) {
      closePeer(viewerId)
    }
  }, [closePeer])

  const stopLocalStream = useCallback(() => {
    if (!streamRef.current) {
      return
    }

    for (const track of streamRef.current.getTracks()) {
      track.onended = null
      track.stop()
    }

    streamRef.current = null
    setLocalStream(null)
  }, [])

  const resetSession = useCallback(
    (nextStatus: string) => {
      stopLocalStream()
      closeAllPeers()
      viewerIdsRef.current.clear()
      sessionIdRef.current = null
      setSessionId('')
      setShareUrl('')
      setViewerCount(0)
      setCopied(false)
      setIsSharing(false)
      setStatus(nextStatus)
    },
    [closeAllPeers, stopLocalStream],
  )

  const createPeerForViewer = useCallback(async (viewerId: string) => {
    const socket = socketRef.current
    const sessionIdValue = sessionIdRef.current
    const activeStream = streamRef.current

    if (!socket || !sessionIdValue || !activeStream || peersRef.current.has(viewerId)) {
      return
    }

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    peersRef.current.set(viewerId, peer)

    for (const track of activeStream.getVideoTracks()) {
      peer.addTrack(track, activeStream)
    }

    peer.onicecandidate = ({ candidate }) => {
      if (!candidate) {
        return
      }

      socket.emit('host:ice-candidate', {
        sessionId: sessionIdValue,
        viewerId,
        candidate,
      })
    }

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') {
        setError('A viewer connection failed. They can rejoin from the same link.')
      }
    }

    try {
      const offer = await peer.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      })

      await peer.setLocalDescription(offer)

      socket.emit('host:offer', {
        sessionId: sessionIdValue,
        viewerId,
        sdp: offer,
      })
    } catch (peerError) {
      closePeer(viewerId)
      setError(
        peerError instanceof Error
          ? peerError.message
          : 'Unable to start a viewer connection.',
      )
    }
  }, [closePeer])

  const stopSharing = useCallback(
    (reason = 'Screen sharing ended') => {
      const socket = socketRef.current
      const activeSessionId = sessionIdRef.current

      if (socket && activeSessionId) {
        socket.emit('host:stop-sharing', { sessionId: activeSessionId })
      }

      resetSession(reason)
    },
    [resetSession],
  )

  useEffect(() => {
    if (!localVideoRef.current) {
      return
    }

    localVideoRef.current.srcObject = localStream
  }, [localStream])

  useEffect(() => {
    const socket = io({
      path: '/socket.io',
    })

    socketRef.current = socket

    socket.on('connect', () => {
      if (!sessionIdRef.current) {
        setStatus('Ready to start a session')
      }
    })

    socket.on('disconnect', () => {
      setStatus('Connection lost')
    })

    socket.on('viewer:joined', ({ viewerId }: ViewerJoinPayload) => {
      viewerIdsRef.current.add(viewerId)
      setViewerCount(viewerIdsRef.current.size)
      setStatus(streamRef.current ? 'Sharing live' : 'Viewer connected')

      if (streamRef.current) {
        void createPeerForViewer(viewerId)
      }
    })

    socket.on('viewer:left', ({ viewerId }: ViewerJoinPayload) => {
      viewerIdsRef.current.delete(viewerId)
      closePeer(viewerId)
      setViewerCount(viewerIdsRef.current.size)

      if (viewerIdsRef.current.size === 0) {
        setStatus(sessionIdRef.current ? 'Waiting for viewer' : 'Ready to start a session')
      }
    })

    socket.on('viewer:answer', async ({ viewerId, sdp }: ViewerSignalPayload) => {
      const peer = peersRef.current.get(viewerId)

      if (!peer) {
        return
      }

      try {
        await peer.setRemoteDescription(new RTCSessionDescription(sdp))
        setStatus('Sharing live')
      } catch (peerError) {
        setError(
          peerError instanceof Error
            ? peerError.message
            : 'Unable to connect a viewer to this session.',
        )
      }
    })

    socket.on('viewer:ice-candidate', async ({ viewerId, candidate }: ViewerIcePayload) => {
      const peer = peersRef.current.get(viewerId)

      if (!peer) {
        return
      }

      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (peerError) {
        setError(
          peerError instanceof Error
            ? peerError.message
            : 'Unable to apply a viewer network candidate.',
        )
      }
    })

    socket.on('session:ended', ({ reason }: { reason?: string }) => {
      resetSession(reason ?? 'Screen sharing ended')
    })

    return () => {
      socket.disconnect()
      stopLocalStream()
      closeAllPeers()
    }
  }, [closeAllPeers, closePeer, createPeerForViewer, resetSession, stopLocalStream])

  async function handleCreateSession() {
    const socket = socketRef.current

    if (!socket) {
      setError('The signaling service is not connected yet.')
      return
    }

    setError('')

    socket.emit('host:create-session', (response: AckResponse) => {
      if (!response.ok || !response.sessionId) {
        setError(response.error ?? 'Unable to create a session right now.')
        return
      }

      sessionIdRef.current = response.sessionId
      setSessionId(response.sessionId)
      setShareUrl(buildShareUrl(response.sessionId))
      setStatus('Waiting for viewer')
    })
  }

  async function handleStartSharing() {
    if (!sessionIdRef.current) {
      setError('Create a session before starting the screen share.')
      return
    }

    setError('')

    try {
      const captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',
          frameRate: { ideal: 15, max: 24 },
          width: { ideal: 1920, max: 2560 },
          height: { ideal: 1080, max: 1440 },
        },
        audio: false,
      })

      for (const track of captureStream.getAudioTracks()) {
        track.stop()
      }

      const [videoTrack] = captureStream.getVideoTracks()

      if (!videoTrack) {
        throw new Error('No video track was returned by screen sharing.')
      }

      const videoOnlyStream = new MediaStream([videoTrack])

      videoTrack.onended = () => {
        stopSharing('Screen sharing ended')
      }

      stopLocalStream()
      streamRef.current = videoOnlyStream
      setLocalStream(videoOnlyStream)
      setIsSharing(true)
      setStatus(viewerIdsRef.current.size > 0 ? 'Sharing live' : 'Waiting for viewer')

      for (const viewerId of viewerIdsRef.current) {
        void createPeerForViewer(viewerId)
      }
    } catch (shareError) {
      setError(
        shareError instanceof Error
          ? shareError.message
          : 'The browser could not start screen sharing.',
      )
    }
  }

  async function handleCopyLink() {
    if (!shareUrl) {
      return
    }

    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
    } catch {
      setError('Clipboard access was blocked. You can copy the link manually.')
    }
  }

  return (
    <section className="workspace-grid">
      <div className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Host</p>
            <h2>Share your screen</h2>
          </div>
          <span className={`status-pill ${isSharing ? 'live' : ''}`}>{status}</span>
        </div>

        <p className="panel-copy">
          Start a room, send the link to a phone, and share only a video track. The app
          never asks for microphone access.
        </p>

        <div className="button-row">
          <button className="primary-button" onClick={handleCreateSession}>
            {sessionId ? 'Create a new session' : 'Start session'}
          </button>
          <button
            className="secondary-button"
            onClick={handleStartSharing}
            disabled={!sessionId || isSharing}
          >
            Start screen share
          </button>
          <button
            className="ghost-button"
            onClick={() => stopSharing('Screen sharing ended')}
            disabled={!sessionId}
          >
            Stop sharing
          </button>
        </div>

        <div className="info-grid">
          <div className="info-card">
            <span className="label">Room code</span>
            <strong>{sessionId || 'Not created yet'}</strong>
          </div>
          <div className="info-card">
            <span className="label">Viewers</span>
            <strong>{viewerCount}</strong>
          </div>
        </div>

        <label className="field">
          <span className="label">Share link</span>
          <div className="field-row">
            <input value={shareUrl} readOnly placeholder="Create a session to generate a link" />
            <button className="secondary-button" onClick={handleCopyLink} disabled={!shareUrl}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </label>

        <div className="note-card">
          <h3>Recommended setup</h3>
          <p>
            Share a single app window or browser tab for the clearest phone experience,
            especially when the content contains text or dashboards.
          </p>
        </div>

        {error ? <p className="error-text">{error}</p> : null}
      </div>

      <div className="panel stream-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Preview</p>
            <h2>Local screen preview</h2>
          </div>
        </div>

        <div className="stream-frame preview-frame">
          {localStream ? (
            <video ref={localVideoRef} autoPlay playsInline muted />
          ) : (
            <div className="empty-state">
              <strong>No active screen share</strong>
              <p>Your selected screen, window, or tab will appear here.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
