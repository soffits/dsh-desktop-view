/**
 * The open views of the desktop (sidebar tabs, full-screen pages) and their
 * status sockets. A view carries the approved flow: it starts watching,
 * "Take control" and "Give back" are messages on its socket, and the server
 * answers with the relay ticket the view's viewer should load.
 *
 * Server to browser:
 *   { type: 'hello', resume }                        once per view: the token to resume it with
 *   { type: 'state', controller, since, mine }       on connect and on every control change
 *   { type: 'view', mode, ticket, hints }            load the viewer in this mode with this relay ticket
 *   { type: 'ended', reason }                        control ended without the view asking
 *   { type: 'error', message }                       the desktop could not be reached
 *   { type: 'heartbeat' }                            keeps proxies from closing a quiet socket
 *
 * Browser to server:
 *   { type: 'take' } | { type: 'give' }
 *
 * Control and tickets belong to the view, not to one socket. A socket that
 * drops without closing on purpose (a proxy cut it, the network changed)
 * leaves the view waiting for `graceMs`: a socket that comes back with the
 * view's resume token picks it up unchanged, with its tickets, its stream
 * and its control. A view closed on purpose (code 1000) or not resumed in
 * time ends: control is given back and its tickets are revoked, which
 * closes its media sockets.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { keepAlive } from './keepalive.js'

/** Close code for a socket the browser should not reconnect as control. */
export const CLOSE_STOPPED = 1001

/** How long a dropped view waits for its socket to come back. */
export const RESUME_GRACE_MS = 30_000

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./control.js').createControl>} options.control
 * @param {ReturnType<typeof import('./tickets.js').createTicketBook>} options.tickets
 * @param {{ maxFps: number }} options.viewer - Viewer options added to its fragment.
 * @param {{ warn: Function, debug: Function }} options.logger
 * @param {number} [options.graceMs]
 * @param {object} [options.keepalive] - Options for {@link keepAlive} (tests).
 */
export function createViews({ control, tickets, viewer, logger, graceMs = RESUME_GRACE_MS, keepalive = {} }) {
  /** @type {Map<string, ReturnType<typeof createView>>} by resume token */
  const views = new Map()

  function createView(sessionId, help) {
    const holderId = randomUUID()
    const resume = randomBytes(24).toString('base64url')
    let socket
    let ended = false
    let graceTimer
    /** The grant the viewer should show now, re-sent on resume. */
    let current

    const send = (message) => {
      if (socket !== undefined && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
    }
    const sendState = state => send({ type: 'state', controller: state.controller, since: state.since, mine: control.holds(holderId) })

    /** Issue a relay ticket for a mode and tell the view to load it. */
    const grant = async (mode) => {
      try {
        const { hints } = await tickets.viewerTicket(mode)
        // Control may have ended (or the view closed) while the ticket was minted.
        if (ended || (mode === 'control' && !control.holds(holderId))) return
        // Only one ticket per mode and view is live at a time.
        tickets.revokeHolder(holderId, mode)
        const ticket = tickets.issue({ mode, holderId, sessionId })
        const fragment = new URLSearchParams(hints)
        fragment.set('fps', String(viewer.maxFps))
        if (mode === 'watch') fragment.set('view_only', '1')
        current = { type: 'view', mode, ticket, hints: fragment.toString() }
        send(current)
      } catch (error) {
        logger.warn('could not open the desktop viewer: %s', error.message)
        send({ type: 'error', message: 'desktop unavailable' })
      }
    }

    const onMessage = (data, binary) => {
      if (binary) return
      let message
      try {
        message = JSON.parse(String(data))
      } catch {
        return
      }
      if (message?.type === 'take') {
        if (control.holds(holderId)) return
        control.take({
          id: holderId,
          sessionId,
          help,
          end: (reason) => {
            tickets.revokeHolder(holderId, 'control')
            // Asked for by this view ('released'), or the view is gone: no notice needed.
            if (reason !== 'released' && reason !== 'disconnected') send({ type: 'ended', reason })
            if (!ended) grant('watch')
          },
        })
        grant('control')
      } else if (message?.type === 'give') {
        control.release(holderId, 'released')
      }
    }

    const end = (reason) => {
      if (ended) return
      ended = true
      clearTimeout(graceTimer)
      views.delete(resume)
      unsubscribe()
      control.release(holderId, reason)
      tickets.revokeHolder(holderId)
    }

    const unsubscribe = control.subscribe(sendState)

    const view = {
      holderId,
      resume,
      /** Bind a (new) socket to this view. */
      attach(next) {
        clearTimeout(graceTimer)
        if (socket !== undefined && socket !== next) socket.terminate()
        socket = next
        next.on('message', onMessage)
        keepAlive(next, { ...keepalive, beat: () => send({ type: 'heartbeat' }) })
        next.on('close', (code) => {
          if (socket !== next || ended) return
          socket = undefined
          // On purpose: the page closed the view. Otherwise wait for it to come back.
          if (code === 1000) end('disconnected')
          else graceTimer = setTimeout(() => end('disconnected'), graceMs)
        })
        send({ type: 'hello', resume })
        sendState(control.state())
        if (current !== undefined) send(current)
      },
      /** Close the view from the server side (plugin stopping). */
      close() {
        end('stopped')
        if (socket !== undefined && socket.readyState === socket.OPEN) socket.close(CLOSE_STOPPED, 'stopped')
      },
      start() {
        grant('watch')
      },
    }
    return view
  }

  return {
    /**
     * Serve one status socket: resume its view or open a new one.
     * @param {import('ws').WebSocket} socket
     * @param {{ sessionId: string | null, resume: string | null, help?: boolean }} request - `help`: opened from the agent's help link.
     */
    attach(socket, { sessionId, resume, help = false }) {
      const resumed = resume === null ? undefined : views.get(resume)
      if (resumed !== undefined) {
        resumed.attach(socket)
        return resumed
      }
      const view = createView(sessionId, help)
      views.set(view.resume, view)
      view.attach(socket)
      view.start()
      return view
    },

    /** Close every view (plugin stopping). */
    closeAll() {
      for (const view of [...views.values()]) view.close()
    },
  }
}
