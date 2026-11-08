/**
 * The credentials of the relayed viewer, in three layers:
 *
 * - Viewer tickets: the daemon's own scoped tickets, one per mode, minted
 *   by the relay and kept server-side. They never reach the browser.
 * - Relay tickets: random tokens the browser's viewer sends instead
 *   (`x-cua-env-authorization: Bearer <relay ticket>`). Each names a mode
 *   (`watch` or `control`), the status socket it belongs to, and the DSH
 *   session the view was opened from. The relay swaps it for the viewer
 *   ticket of its mode. A control relay ticket lives only while its status
 *   socket holds control; a watch one, while its status socket is open.
 * - Media tickets: minted by the daemon for each media session the viewer
 *   opens. The relay notes which relay ticket opened each one, so a media
 *   socket is judged by the mode that opened it.
 */
import { randomBytes } from 'node:crypto'

/** Modes and the daemon scope each one's viewer ticket gets. */
export const MODES = Object.freeze(['watch', 'control'])

/** Refresh a viewer ticket when it has less than this long left. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000
/** Lifetime asked for each viewer ticket. */
const VIEWER_TICKET_SECONDS = 60 * 60

/**
 * @param {object} options
 * @param {{ createViewerTicket: Function }} options.spacesd
 * @param {{ clipboard: boolean, filesRoot: string, microphone: boolean }} options.features - What control mode may use.
 * @param {() => number} [options.now]
 */
export function createTicketBook({ spacesd, features, now = Date.now }) {
  const viewer = new Map()
  const relay = new Map()
  const media = new Map()
  const revokeListeners = new Set()

  /** The daemon scope of each mode: watching gets the stream and nothing else. */
  const scope = mode => mode === 'control'
    ? { policy: 'allow_activation', clipboard: features.clipboard, filesRoot: features.filesRoot, audioUplink: features.microphone }
    : { policy: 'view_only', clipboard: false, filesRoot: '', audioUplink: false }

  return {
    /**
     * The daemon's viewer ticket for a mode, minted or refreshed as needed.
     * @param {'watch' | 'control'} mode
     * @returns {Promise<{ ticket: string, expiresAt: number, hints: string }>}
     */
    async viewerTicket(mode) {
      const cached = viewer.get(mode)
      if (cached !== undefined) {
        const current = await cached
        if (current.expiresAt - now() > REFRESH_MARGIN_MS) return current
        if (viewer.get(mode) === cached) viewer.delete(mode)
      }
      if (!viewer.has(mode)) {
        const minting = spacesd.createViewerTicket({ ...scope(mode), ttlSeconds: VIEWER_TICKET_SECONDS, name: 'Owner' })
        viewer.set(mode, minting)
        minting.catch(() => { if (viewer.get(mode) === minting) viewer.delete(mode) })
      }
      return viewer.get(mode)
    },

    /** Forget a mode's viewer ticket (the daemon said it is no longer valid). */
    invalidate(mode) {
      viewer.delete(mode)
    },

    /**
     * Issue a relay ticket.
     * @param {{ mode: 'watch' | 'control', holderId: string, sessionId: string | null }} grant
     * @returns {string}
     */
    issue(grant) {
      const token = randomBytes(32).toString('base64url')
      relay.set(token, { ...grant })
      return token
    },

    /** The grant of a relay ticket, or undefined when unknown or revoked. */
    lookup(token) {
      return typeof token === 'string' ? relay.get(token) : undefined
    },

    /** Revoke one relay ticket and every media socket it opened. */
    revoke(token) {
      if (!relay.delete(token)) return
      for (const [ticket, binding] of media) if (binding.relayToken === token) media.delete(ticket)
      for (const listener of revokeListeners) listener(token)
    },

    /** Revoke every relay ticket of one status socket, or only those of one mode. */
    revokeHolder(holderId, mode) {
      for (const [token, grant] of [...relay]) {
        if (grant.holderId === holderId && (mode === undefined || grant.mode === mode)) this.revoke(token)
      }
    },

    /** Note that a relay ticket opened a media session. */
    bindMedia(mediaTicket, relayToken, sessionId) {
      if (relay.has(relayToken)) media.set(mediaTicket, { relayToken, sessionId })
    },

    /**
     * Which relay ticket opened a media ticket's session, with its grant.
     * @returns {{ relayToken: string, sessionId: string, grant: object } | undefined}
     */
    media(mediaTicket) {
      const binding = media.get(mediaTicket)
      const grant = binding === undefined ? undefined : relay.get(binding.relayToken)
      return grant === undefined ? undefined : { ...binding, grant }
    },

    /** Follow revocations (to close the media sockets of a revoked ticket). */
    onRevoke(listener) {
      revokeListeners.add(listener)
      return () => revokeListeners.delete(listener)
    },
  }
}
