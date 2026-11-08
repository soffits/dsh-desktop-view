/**
 * The media socket of the relayed viewer: one browser socket piped to one
 * cua-spacesd `/media` socket. The browser presents the media ticket the
 * daemon gave its viewer; the relay accepts it only when one of its own
 * relay tickets opened that media session, and judges the socket by that
 * ticket's mode. Everything the daemon sends goes down unchanged; only what
 * {@link checkClientMessage} allows for the mode goes up.
 *
 * A slow browser (a phone on a weak link) must not make the server buffer
 * video without limit: past `MAX_BUFFERED_BYTES` the relay drops frames and
 * asks the daemon for a keyframe, then forwards again from that keyframe.
 */
import WebSocket from 'ws'
import { checkClientMessage } from './filter.js'

/** Browser send buffer above which video frames are dropped. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

/** Close codes the relay sends the browser (4000-4999 are application codes). */
export const CLOSE = Object.freeze({
  CONTROL_ENDED: 4100,
  UPSTREAM_FAILED: 4502,
})

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
 * The media ticket a browser presents: the `ticket` query parameter, or the
 * `cua.ticket.<ticket>` subprotocol.
 * @param {string | undefined} url
 * @param {string | undefined} protocols - The Sec-WebSocket-Protocol header.
 */
export function mediaTicketOf(url, protocols) {
  const query = new URL(url ?? '/', 'http://relay.invalid').searchParams.get('ticket')
  if (query) return query
  for (const offered of (protocols ?? '').split(',')) {
    const name = offered.trim()
    if (name.startsWith('cua.ticket.')) return name.slice('cua.ticket.'.length)
  }
  return undefined
}

/**
 * Pipe one accepted browser socket to the daemon.
 * @param {object} options
 * @param {import('ws').WebSocket} options.browser
 * @param {'watch' | 'control'} options.mode
 * @param {string} options.sessionId - The media session the ticket belongs to.
 * @param {() => void} [options.onInput] - Called for each forwarded input batch.
 * @param {() => WebSocket} options.connect - Opens the daemon socket.
 * @param {{ warn: Function, debug: Function }} options.logger
 * @returns {{ close: (code?: number, reason?: string) => void }}
 */
export function pipeMedia({ browser, mode, sessionId, onInput = () => {}, connect, logger }) {
  let closed = false
  let skipping = false
  const pending = []
  const upstream = connect()

  const close = (code = 1000, reason = '') => {
    if (closed) return
    closed = true
    if (browser.readyState === browser.OPEN || browser.readyState === browser.CONNECTING) browser.close(code, reason)
    upstream.terminate()
  }

  browser.on('close', () => close())
  browser.on('error', () => close(1011))
  browser.on('message', (data, binary) => {
    const checked = checkClientMessage(data, binary, mode, sessionId)
    if (!checked.ok) {
      logger.debug('dropped a browser media message: %s', checked.reason)
      return
    }
    if (checked.type === 'interactive_input') onInput()
    if (upstream.readyState === WebSocket.OPEN) upstream.send(checked.data, { binary: checked.binary })
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push(checked)
  })

  upstream.on('open', () => {
    for (const message of pending.splice(0)) upstream.send(message.data, { binary: message.binary })
  })
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
        upstream.send(JSON.stringify({ type: 'request_keyframe', payload: { session_id: sessionId } }))
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

  return { close }
}
