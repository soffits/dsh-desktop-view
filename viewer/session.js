/**
 * One open view of the desktop, shared by the sidebar tab and the
 * full-screen page: the status socket that carries Take control / Give
 * back, and the frame that shows the relayed Cua viewer in the mode the
 * server granted. It owns no UI text; callers render the status it reports.
 *
 * Status: { phase: 'connecting' | 'live' | 'error', mode: 'watch' | 'control',
 *           controller: 'user' | null, mine: boolean, ended: string | null }
 */

const RETRY_MS = [1000, 2000, 5000, 10000]

/** Permissions the viewer frame may use (the page itself also allows them). */
export const FRAME_ALLOW = 'autoplay; clipboard-read; clipboard-write; microphone; fullscreen; keyboard-map'

/**
 * The viewer URL for one grant. A fresh query makes the frame load anew;
 * the fragment (ticket and options) never reaches a server.
 * @param {URL} base - The plugin prefix URL, ending in '/'.
 */
export function viewerUrl(base, { ticket, hints }, serial) {
  const fragment = new URLSearchParams(hints)
  fragment.set('ticket', ticket)
  return new URL(`d/viewer/?v=${serial}#${fragment}`, base).href
}

/**
 * @param {object} options
 * @param {HTMLIFrameElement} options.frame
 * @param {URL | string} options.base - URL of the plugin's prefix, ending in '/'.
 * @param {string | null} [options.sessionId] - DSH session the view belongs to.
 * @param {'watch' | 'control'} [options.mode] - Mode to ask for once connected.
 * @param {(status: object) => void} options.onStatus
 */
export function createDesktopSession({ frame, base, sessionId = null, mode = 'watch', onStatus }) {
  const root = new URL(base)
  let socket
  let failures = 0
  let retryTimer
  let destroyed = false
  let serial = 0
  let wanted = mode
  /** Token to pick this view up again after a dropped socket. */
  let resume = null
  /** The relay ticket the frame shows now. */
  let shown = null
  /** The grant the server gave last; shown again after a pause. */
  let latest = null
  /** While paused the frame is unloaded, but the view and its control stay. */
  let paused = false
  let status = { phase: 'connecting', mode: 'watch', controller: null, mine: false, ended: null }

  const report = (patch) => {
    status = { ...status, ...patch }
    onStatus(status)
  }
  const send = (message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  frame.allow = FRAME_ALLOW
  const onLoad = () => {
    if (!paused && shown !== null && status.phase === 'connecting') report({ phase: 'live' })
  }
  frame.addEventListener('load', onLoad)

  const show = (grant) => {
    latest = grant
    if (paused) {
      report({ mode: grant.mode })
      return
    }
    // A resumed view gets its current grant again; the frame keeps running.
    if (grant.ticket === shown) {
      report({ phase: frame.src === '' ? 'connecting' : 'live', mode: grant.mode })
      return
    }
    shown = grant.ticket
    serial += 1
    report({ phase: 'connecting', mode: grant.mode })
    frame.src = viewerUrl(root, grant, serial)
  }

  const onMessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    switch (message?.type) {
      case 'hello':
        resume = message.resume
        break
      case 'state':
        report({ controller: message.controller, mine: message.mine === true })
        break
      case 'view':
        if (message.mode === 'watch' && wanted === 'control' && !status.mine) {
          // First grant after connecting: the page asked to start in control.
          wanted = 'watch'
          send({ type: 'take' })
        }
        show(message)
        break
      case 'ended':
        wanted = 'watch'
        report({ ended: message.reason })
        break
      case 'error':
        report({ phase: 'error' })
        break
      default:
        break
    }
  }

  const connect = () => {
    clearTimeout(retryTimer)
    if (destroyed) return
    const query = new URLSearchParams()
    if (sessionId) query.set('session', sessionId)
    if (resume) query.set('resume', resume)
    const url = new URL(`status${query.size > 0 ? `?${query}` : ''}`, root)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const current = new WebSocket(url)
    socket = current
    current.onmessage = onMessage
    current.onopen = () => { failures = 0 }
    current.onclose = () => {
      if (socket !== current || destroyed) return
      socket = undefined
      failures += 1
      // The server keeps the view (and its control) for a short grace
      // period; reconnecting with the resume token picks it up unchanged.
      // If that is too late, the server starts a new watching view, and
      // control is only ever taken again on request.
      wanted = 'watch'
      report({ phase: failures > 2 ? 'error' : 'connecting' })
      retryTimer = setTimeout(connect, RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)])
    }
  }

  onStatus(status)
  connect()

  return {
    /** Ask to take control, or give it back. */
    setMode(next) {
      if (next === 'control') {
        report({ ended: null })
        send({ type: 'take' })
      } else {
        send({ type: 'give' })
      }
    },
    /**
     * Stop showing the desktop but keep the view: the frame is unloaded (no
     * stream, no decoding), while the status socket, the grant and control
     * stay. Used while the sidebar tab is hidden.
     */
    pause() {
      if (paused) return
      paused = true
      shown = null
      frame.src = 'about:blank'
    },
    /** Show the desktop again after {@link pause}, with the current grant. */
    resume() {
      if (!paused) return
      paused = false
      if (latest !== null) show(latest)
    },
    /** Reconnect after an error. */
    retry() {
      failures = 0
      if (socket !== undefined) {
        socket.onclose = null
        socket.close(1000)
        socket = undefined
      }
      connect()
    },
    destroy() {
      destroyed = true
      clearTimeout(retryTimer)
      frame.removeEventListener('load', onLoad)
      if (socket !== undefined) {
        socket.onclose = null
        socket.close(1000)
      }
      frame.src = 'about:blank'
    },
  }
}
