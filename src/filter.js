/**
 * What a browser may send up the media socket. The relay forwards only the
 * message types its viewer uses, so a modified page cannot reach anything
 * else the media plane offers (actions, window geometry, audio uplink).
 * Input is forwarded only on a control socket; a watch socket's media
 * session is also opened `view_only`, so cua-spacesd refuses input there
 * even if this filter were bypassed.
 */

/** Largest text message a browser may send (an input batch is small). */
export const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024

const WATCH_TYPES = Object.freeze(['request_keyframe', 'get_stats', 'frame_ack', 'ping'])
const CONTROL_TYPES = Object.freeze([...WATCH_TYPES, 'interactive_input'])

/** Message types allowed per socket mode. */
export const ALLOWED_TYPES = Object.freeze({ watch: WATCH_TYPES, control: CONTROL_TYPES })

/**
 * Check one message from the browser.
 * @param {Buffer | string} data - The WebSocket message.
 * @param {boolean} binary - Whether it arrived as a binary frame.
 * @param {'watch' | 'control'} mode
 * @param {string} sessionId - The media session this socket is attached to.
 * @returns {{ ok: true, type: string, text: string } | { ok: false, reason: string }}
 */
export function checkClientMessage(data, binary, mode, sessionId) {
  if (binary) return { ok: false, reason: 'binary messages are not accepted' }
  const text = typeof data === 'string' ? data : data.toString('utf8')
  if (Buffer.byteLength(text) > MAX_CLIENT_MESSAGE_BYTES) return { ok: false, reason: 'message too large' }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not JSON' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not an object' }
  const { type, payload } = value
  if (typeof type !== 'string' || !ALLOWED_TYPES[mode]?.includes(type)) {
    return { ok: false, reason: `type ${JSON.stringify(type)} is not allowed on a ${mode} socket` }
  }
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    return { ok: false, reason: 'payload is not an object' }
  }
  if (payload?.session_id !== undefined && payload.session_id !== sessionId) {
    return { ok: false, reason: 'message names another media session' }
  }
  // Only the two documented envelope fields go up, so nothing the filter did
  // not look at rides along.
  return { ok: true, type, text: JSON.stringify(payload === undefined ? { type } : { type, payload }) }
}
