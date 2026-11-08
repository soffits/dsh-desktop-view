/**
 * The few protobuf and gRPC-Web pieces the relay needs to call
 * `cua.env.v1.StreamService` on cua-spacesd. The daemon answers gRPC-Web
 * only in its binary form, and the relay sends three small messages, so a
 * hand-written encoder for varints, strings and nested messages is smaller
 * and easier to audit than a generated client.
 */

const WIRE_VARINT = 0
const WIRE_LENGTH = 2

/** Encode an unsigned integer (up to 2^53) as a protobuf varint. */
function varint(value) {
  const bytes = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

function tag(field, wire) {
  return varint(field * 8 + wire)
}

/**
 * Encode one message from a list of fields. Zero numbers, empty strings and
 * undefined values are left out, as proto3 does for defaults.
 * @param {Array<[number, 'varint' | 'string' | 'message', number | string | Buffer | undefined]>} fields
 * @returns {Buffer}
 */
export function encodeMessage(fields) {
  const parts = []
  for (const [field, kind, value] of fields) {
    if (value === undefined || value === 0 || value === '') continue
    if (kind === 'varint') {
      parts.push(tag(field, WIRE_VARINT), varint(value))
    } else {
      const bytes = kind === 'string' ? Buffer.from(value, 'utf8') : value
      parts.push(tag(field, WIRE_LENGTH), varint(bytes.length), bytes)
    }
  }
  return Buffer.concat(parts)
}

/**
 * Decode one message into a map from field number to its values, in order.
 * Varints become numbers, length-delimited fields stay Buffers (decode them
 * again or read them as text). Fixed-width fields are skipped.
 * @param {Buffer} bytes
 * @returns {Map<number, Array<number | Buffer>>}
 */
export function decodeMessage(bytes) {
  const fields = new Map()
  let offset = 0
  const readVarint = () => {
    let value = 0
    let scale = 1
    for (;;) {
      if (offset >= bytes.length) throw new Error('truncated protobuf varint')
      const byte = bytes[offset++]
      value += (byte & 0x7f) * scale
      if (byte < 0x80) return value
      scale *= 0x80
    }
  }
  while (offset < bytes.length) {
    const key = readVarint()
    const field = Math.floor(key / 8)
    const wire = key % 8
    let value
    if (wire === WIRE_VARINT) {
      value = readVarint()
    } else if (wire === WIRE_LENGTH) {
      const length = readVarint()
      if (offset + length > bytes.length) throw new Error('truncated protobuf field')
      value = bytes.subarray(offset, offset + length)
      offset += length
    } else if (wire === 1) {
      offset += 8
      continue
    } else if (wire === 5) {
      offset += 4
      continue
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`)
    }
    if (!fields.has(field)) fields.set(field, [])
    fields.get(field).push(value)
  }
  return fields
}

/** First value of a field read as UTF-8 text, or ''. */
export function text(fields, field) {
  const value = fields.get(field)?.[0]
  return Buffer.isBuffer(value) ? value.toString('utf8') : ''
}

/** First value of a varint field, or 0. */
export function number(fields, field) {
  const value = fields.get(field)?.[0]
  return typeof value === 'number' ? value : 0
}

/** First value of a nested message field, decoded, or an empty map. */
export function message(fields, field) {
  const value = fields.get(field)?.[0]
  return Buffer.isBuffer(value) ? decodeMessage(value) : new Map()
}

/** Wrap one message in a gRPC-Web data frame. */
export function grpcWebFrame(body) {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

/**
 * Split a gRPC-Web response body into its message and status. The status
 * comes from the trailer frame, or from the HTTP headers when the server
 * sent a trailers-only response.
 * @param {Buffer} body
 * @param {Headers} headers
 * @returns {{ message: Buffer | undefined, status: number, statusMessage: string }}
 */
export function parseGrpcWebResponse(body, headers) {
  let message
  let trailers = ''
  let offset = 0
  while (offset + 5 <= body.length) {
    const flags = body[offset]
    const length = body.readUInt32BE(offset + 1)
    const frame = body.subarray(offset + 5, offset + 5 + length)
    offset += 5 + length
    if (flags & 0x80) trailers += frame.toString('utf8')
    else if (message === undefined) message = frame
  }
  const values = new Map()
  for (const line of trailers.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon > 0) values.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  const status = values.get('grpc-status') ?? headers.get('grpc-status') ?? (message === undefined ? '2' : '0')
  const statusMessage = values.get('grpc-message') ?? headers.get('grpc-message') ?? ''
  return { message, status: Number(status), statusMessage: percentDecode(statusMessage) }
}

/** gRPC percent-encodes its status message; keep the raw text when it is malformed. */
function percentDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
