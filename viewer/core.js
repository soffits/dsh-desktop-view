/**
 * The desktop viewer shared by the sidebar tab and the full-screen page: it
 * attaches to the plugin's relayed media socket, decodes the H.264 stream
 * with WebCodecs onto a canvas, and, while this viewer holds control, sends
 * input. Written from the open rcdp wire v2 description (cua's MEDIA.md).
 *
 * It owns no UI text; callers render the status it reports.
 */
import { attachInput } from './input.js'

/** Close code the relay uses when control ended (the reason says why). */
const CONTROL_ENDED = 4100
const STATUS_TYPE = 'desktop_view_status'
const MAX_BATCH = 256
const MAX_DECODE_QUEUE = 4
const RETRY_MS = [1000, 2000, 5000, 10000]

/** Whether this browser can decode the stream. */
export function supported() {
  return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function'
}

/**
 * The WebCodecs codec string of an H.264 Annex B keyframe, read from its SPS
 * (profile, constraint flags, level), such as "avc1.42c020".
 * @param {Uint8Array} data
 * @returns {string | undefined}
 */
export function avcCodec(data) {
  for (let i = 0; i + 7 < data.length; i++) {
    const start = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 ? i + 3
      : data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1 ? i + 4 : -1
    if (start < 0) continue
    if ((data[start] & 0x1f) === 7 && start + 3 < data.length) {
      const hex = byte => byte.toString(16).padStart(2, '0')
      return `avc1.${hex(data[start + 1])}${hex(data[start + 2])}${hex(data[start + 3])}`
    }
    i = start - 1
  }
  return undefined
}

/**
 * Split one binary media packet: `u32 header_len, u32 payload_len, JSON
 * header, payload`, both lengths big-endian. Audio packets (magic RAU2)
 * and anything malformed give undefined.
 * @param {ArrayBuffer} buffer
 */
export function parsePacket(buffer) {
  if (buffer.byteLength < 8) return undefined
  const view = new DataView(buffer)
  if (view.getUint8(0) !== 0) return undefined
  const headerLength = view.getUint32(0)
  const payloadLength = view.getUint32(4)
  if (8 + headerLength + payloadLength > buffer.byteLength) return undefined
  try {
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)))
    return { header, payload: new Uint8Array(buffer, 8 + headerLength, payloadLength) }
  } catch {
    return undefined
  }
}

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {HTMLTextAreaElement} options.keyboard - Hidden textarea for keyboard input.
 * @param {URL | string} options.base - URL of the plugin's prefix, ending in '/'.
 * @param {string | null} [options.sessionId] - DSH session the view belongs to.
 * @param {'watch' | 'control'} [options.mode]
 * @param {(status: object) => void} options.onStatus
 */
export function createViewer({ canvas, keyboard, base, sessionId = null, mode = 'watch', onStatus }) {
  const draw = canvas.getContext('2d')
  let socket
  let decoder
  let decoderKey
  let waitKeyframe = true
  let mediaSession
  let sequence = 1
  let queue = []
  let flushing = false
  let failures = 0
  let retryTimer
  let destroyed = false
  let status = { phase: supported() ? 'connecting' : 'unsupported', mode, controller: null, since: null, mine: false, ended: null }

  const report = (patch) => {
    status = { ...status, ...patch }
    onStatus(status)
  }

  const send = (message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }
  const requestKeyframe = () => {
    waitKeyframe = true
    if (mediaSession !== undefined) send({ type: 'request_keyframe', payload: { session_id: mediaSession } })
  }

  const resetDecoder = () => {
    if (decoder !== undefined && decoder.state !== 'closed') decoder.close()
    decoder = undefined
    decoderKey = undefined
    waitKeyframe = true
  }

  const decode = (header, payload) => {
    if (header.codec !== 'h264') return
    const key = header.keyframe === true
    if (key) {
      const codec = avcCodec(payload)
      const next = `${codec}/${header.codec_epoch}/${header.width_px}x${header.height_px}`
      if (codec !== undefined && next !== decoderKey) {
        resetDecoder()
        decoder = new VideoDecoder({
          output(frame) {
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth
              canvas.height = frame.displayHeight
            }
            draw.drawImage(frame, 0, 0)
            frame.close()
            if (status.phase !== 'live') report({ phase: 'live' })
          },
          error() {
            resetDecoder()
            requestKeyframe()
          },
        })
        decoder.configure({ codec, optimizeForLatency: true })
        decoderKey = next
      }
      waitKeyframe = false
    }
    if (decoder === undefined || waitKeyframe) return
    if (!key && decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      requestKeyframe()
      return
    }
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round(performance.now() * 1000), data: payload }))
  }

  const onText = (text) => {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    const payload = message?.payload ?? {}
    switch (message?.type) {
      case STATUS_TYPE:
        report({ controller: payload.controller, since: payload.since, mine: payload.mine === true })
        break
      case 'session_opened':
        mediaSession = payload.session_id
        sequence = 1
        break
      case 'error':
        if (payload.code === 'input_sequence_gap' && Number.isSafeInteger(payload.expected_sequence)) sequence = payload.expected_sequence
        break
      default:
        break
    }
  }

  // Input is batched per animation frame; consecutive pointer moves collapse
  // to the newest one.
  const emit = (event) => {
    const last = queue[queue.length - 1]
    if (event.kind === 'pointer' && event.phase === 'move' && last?.kind === 'pointer' && last.phase === 'move' && last.button === event.button) {
      queue[queue.length - 1] = event
    } else {
      queue.push(event)
    }
    if (!flushing) {
      flushing = true
      requestAnimationFrame(flush)
    }
  }
  const flush = () => {
    flushing = false
    if (mediaSession === undefined || !status.mine) {
      queue = []
      return
    }
    while (queue.length > 0) {
      const events = queue.splice(0, MAX_BATCH)
      send({ type: 'interactive_input', payload: { session_id: mediaSession, first_sequence: sequence, events } })
      sequence += events.length
    }
  }
  const detachInput = attachInput({ canvas, keyboard, emit, enabled: () => status.mode === 'control' && status.mine })

  const connect = (nextMode) => {
    clearTimeout(retryTimer)
    if (socket !== undefined) {
      socket.onclose = null
      socket.close(1000)
    }
    resetDecoder()
    mediaSession = undefined
    queue = []
    if (destroyed || !supported()) return
    report({ phase: 'connecting', mode: nextMode, mine: false })
    const url = new URL(`media?mode=${nextMode}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`, base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const current = new WebSocket(url)
    current.binaryType = 'arraybuffer'
    socket = current
    current.onopen = () => { failures = 0 }
    current.onmessage = (event) => {
      if (typeof event.data === 'string') return onText(event.data)
      const packet = parsePacket(event.data)
      if (packet?.header?.direction === 'video') decode(packet.header.message ?? {}, packet.payload)
    }
    current.onclose = (event) => {
      if (socket !== current || destroyed) return
      socket = undefined
      if (event.code === CONTROL_ENDED) {
        report({ ended: event.reason || 'released' })
        connect('watch')
        return
      }
      failures += 1
      report({ phase: failures > 2 ? 'error' : 'connecting', mine: false })
      // A lost control socket falls back to watching; control is never
      // taken again without the user asking.
      retryTimer = setTimeout(() => connect('watch'), RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)])
    }
  }

  onStatus(status)
  connect(mode)

  return {
    /** Switch between watching and controlling; reconnects the stream. */
    setMode(next) {
      if (next === 'control') report({ ended: null })
      connect(next)
    },
    /** Give the keyboard focus to the desktop (opens a phone's keyboard). */
    focusKeyboard() {
      keyboard.focus({ preventScroll: true })
    },
    /** Reconnect after an error. */
    retry() {
      failures = 0
      connect(status.mode)
    },
    destroy() {
      destroyed = true
      clearTimeout(retryTimer)
      detachInput()
      if (socket !== undefined) {
        socket.onclose = null
        socket.close(1000)
      }
      resetDecoder()
    },
  }
}
