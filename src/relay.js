/**
 * One browser socket relayed to one cua-spacesd media session. The relay
 * opens the session itself (with the env token, which stays on the server),
 * picks its policy from the socket's mode, and pipes messages both ways:
 * everything the daemon sends goes down unchanged, and only what
 * {@link checkClientMessage} allows goes up.
 *
 * A slow browser (a phone on a weak link) must not make the server buffer
 * video without limit: past `MAX_BUFFERED_BYTES` the relay drops frames and
 * asks the daemon for a keyframe, then forwards again from that keyframe,
 * so the picture recovers instead of breaking.
 */
import { randomUUID } from 'node:crypto'
import { checkClientMessage } from './filter.js'

/** Browser send buffer above which video frames are dropped. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

/** Close codes the relay sends the browser (4000-4999 are application codes). */
export const CLOSE = Object.freeze({
  CONTROL_ENDED: 4100,
  UPSTREAM_FAILED: 4502,
})

/** The relay's own status message type, next to the daemon's message types. */
export const STATUS_TYPE = 'desktop_view_status'

/**
 * Read whether one binary media packet is a video keyframe.
 * @param {Buffer} data - `u32 header_len, u32 payload_len, JSON header, payload`.
 * @returns {boolean | undefined} undefined when it is not a video packet
 */
export function videoKeyframe(data) {
  if (data.length < 8 || data[0] !== 0) return undefined
  const length = data.readUInt32BE(0)
  if (8 + length > data.length) return undefined
  try {
    const header = JSON.parse(data.subarray(8, 8 + length).toString('utf8'))
    return header?.direction === 'video' ? header.message?.keyframe === true : undefined
  } catch {
    return undefined
  }
}

/**
 * Relay one accepted browser socket.
 * @param {object} options
 * @param {import('ws').WebSocket} options.browser
 * @param {'watch' | 'control'} options.mode
 * @param {string | null} options.sessionId - DSH session the view was opened from.
 * @param {ReturnType<typeof import('./spacesd.js').createSpacesd>} options.spacesd
 * @param {ReturnType<typeof import('./control.js').createControl>} options.control
 * @param {{ display: string, maxFps: number, maxDimension: number, bitrateKbps: number }} options.media
 * @param {{ warn: Function, debug: Function }} options.logger
 * @returns {{ id: string, close: (code?: number, reason?: string, why?: string) => void }}
 */
export function relay({ browser, mode, sessionId, spacesd, control, media, logger }) {
  const id = randomUUID()
  let upstream
  let opened
  let closed = false
  let skipping = false
  let unsubscribe = () => {}

  const sendStatus = (state) => {
    if (browser.readyState !== browser.OPEN) return
    browser.send(JSON.stringify({
      type: STATUS_TYPE,
      payload: { mode, controller: state.controller, since: state.since, mine: control.holds(id) },
    }))
  }

  const close = (code = 1000, reason = '', why = code === 1000 ? 'released' : 'disconnected') => {
    if (closed) return
    closed = true
    unsubscribe()
    if (mode === 'control') control.release(id, why)
    if (browser.readyState === browser.OPEN || browser.readyState === browser.CONNECTING) browser.close(code, reason)
    if (upstream !== undefined) upstream.terminate()
    if (opened !== undefined) {
      spacesd.closeMedia(opened.sessionId).catch(error => logger.debug('closing media session: %s', error.message))
    }
  }

  browser.on('close', (code) => {
    // A browser that closes on purpose (1000) gives control back; anything
    // else (tab closed, network gone) counts as disconnected.
    close(code === 1000 ? 1000 : 1001)
  })
  browser.on('error', () => close(1011))

  browser.on('message', (data, binary) => {
    if (upstream === undefined || upstream.readyState !== upstream.OPEN || opened === undefined) return
    const checked = checkClientMessage(data, binary, mode, opened.sessionId)
    if (!checked.ok) {
      logger.debug('dropped a browser message: %s', checked.reason)
      return
    }
    if (checked.type === 'interactive_input') {
      if (!control.holds(id)) return
      control.touch(id)
    }
    upstream.send(checked.text)
  })

  const start = async () => {
    if (mode === 'control') {
      control.take({
        id,
        sessionId,
        end: reason => close(CLOSE.CONTROL_ENDED, reason),
      })
    }
    unsubscribe = control.subscribe(sendStatus)
    sendStatus(control.state())
    opened = await spacesd.openMedia({
      ...media,
      policy: mode === 'control' ? 'allow_activation' : 'view_only',
      ticketTtlSeconds: 30,
    })
    if (closed) {
      await spacesd.closeMedia(opened.sessionId)
      return
    }
    upstream = spacesd.attach(opened)
    upstream.on('message', (data, binary) => {
      if (browser.readyState !== browser.OPEN) return
      if (!binary) {
        browser.send(data, { binary: false })
        return
      }
      const keyframe = videoKeyframe(data)
      if (keyframe !== undefined) {
        if (skipping && !keyframe) return
        if (!skipping && !keyframe && browser.bufferedAmount > MAX_BUFFERED_BYTES) {
          skipping = true
          upstream.send(JSON.stringify({ type: 'request_keyframe', payload: { session_id: opened.sessionId } }))
          return
        }
        skipping = false
      }
      browser.send(data, { binary: true })
    })
    upstream.on('close', (code, reason) => {
      // Pass the daemon's own application codes through (MEDIA.md §10).
      close(code >= 4000 && code < 5000 ? code : CLOSE.UPSTREAM_FAILED, String(reason).slice(0, 120))
    })
    upstream.on('error', (error) => {
      logger.warn('media socket error: %s', error.message)
      close(CLOSE.UPSTREAM_FAILED, 'desktop stream unavailable')
    })
  }

  start().catch((error) => {
    logger.warn('could not open the desktop stream: %s', error.message)
    close(CLOSE.UPSTREAM_FAILED, 'desktop stream unavailable')
  })

  return { id, close }
}
