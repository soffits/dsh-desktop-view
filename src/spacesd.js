/**
 * The relay's calls to cua-spacesd: open and close one media session
 * (`cua.env.v1.StreamService`), and attach to its media socket. The env
 * token is read from its file for every call, so a rotated token is picked
 * up, and it only ever travels in a request header to the daemon; it is
 * never logged, put in a URL or sent to a browser.
 */
import { readFile } from 'node:fs/promises'
import WebSocket from 'ws'
import { decodeMessage, encodeMessage, grpcWebFrame, message, number, parseGrpcWebResponse, text } from './proto.js'

const SERVICE = 'cua.env.v1.StreamService'

/** `MediaCodec` and `SessionPolicy` values of stream.proto. */
export const CODEC_H264 = 1
export const POLICY = Object.freeze({ view_only: 1, allow_activation: 3 })

/** How long one call to the daemon may take. */
const CALL_TIMEOUT_MS = 10_000

/** A daemon call failed; `status` is the gRPC status code when there was one. */
export class SpacesdError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'SpacesdError'
    this.status = status
  }
}

/**
 * @param {object} options
 * @param {string} options.endpoint - Base URL of cua-spacesd, such as http://127.0.0.1:3211.
 * @param {string} options.tokenFile - File holding the env token.
 * @param {typeof fetch} [options.fetch]
 * @param {(path: string) => Promise<string>} [options.readToken] - Test seam.
 */
export function createSpacesd({ endpoint, tokenFile, fetch = globalThis.fetch, readToken }) {
  const base = endpoint.replace(/\/+$/, '')
  const token = readToken ?? (async path => (await readFile(path, 'utf8')).trim())

  async function call(method, body) {
    const secret = await token(tokenFile).catch(error => {
      throw new SpacesdError(`cannot read the cua-spacesd token file (${error.code ?? 'error'})`)
    })
    if (secret === '') throw new SpacesdError('the cua-spacesd token file is empty')
    let response
    try {
      response = await fetch(`${base}/${SERVICE}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/grpc-web+proto',
          'x-grpc-web': '1',
          'x-cua-env-authorization': `Bearer ${secret}`,
        },
        body: grpcWebFrame(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })
    } catch (error) {
      throw new SpacesdError(`cua-spacesd is not reachable at ${base} (${error.cause?.code ?? error.name})`)
    }
    if (!response.ok) throw new SpacesdError(`cua-spacesd answered HTTP ${response.status} to ${method}`)
    const parsed = parseGrpcWebResponse(Buffer.from(await response.arrayBuffer()), response.headers)
    if (parsed.status !== 0) {
      throw new SpacesdError(`cua-spacesd ${method} failed (status ${parsed.status}): ${parsed.statusMessage}`, parsed.status)
    }
    return decodeMessage(parsed.message ?? Buffer.alloc(0))
  }

  return {
    /**
     * Open a media session on one display.
     * @param {{ display: string, policy: keyof typeof POLICY, maxFps: number, maxDimension: number, bitrateKbps: number, ticketTtlSeconds: number }} options
     * @returns {Promise<{ sessionId: string, ticket: string, wsPath: string, policy: number, width: number, height: number }>}
     */
    async openMedia({ display, policy, maxFps, maxDimension, bitrateKbps, ticketTtlSeconds }) {
      const response = await call('OpenMedia', encodeOpenMedia({ display, policy, maxFps, maxDimension, bitrateKbps, ticketTtlSeconds }))
      return decodeOpenMedia(response)
    },

    /** Close a media session and revoke its ticket. */
    async closeMedia(sessionId) {
      await call('CloseMedia', encodeMessage([[1, 'string', sessionId]]))
    },

    /**
     * Attach to an opened session's media socket. The ticket goes in the
     * subprotocol header, the form the daemon documents for clients.
     * @returns {WebSocket}
     */
    attach(opened) {
      const url = new URL(opened.wsPath.split('?')[0] || '/media', base)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      return new WebSocket(url, ['rcdp.v2', `cua.ticket.${opened.ticket}`], { perMessageDeflate: false })
    },
  }
}

/** The `OpenMediaRequest` bytes. */
export function encodeOpenMedia({ display, policy, maxFps, maxDimension, bitrateKbps, ticketTtlSeconds }) {
  const policyValue = POLICY[policy]
  if (policyValue === undefined) throw new Error(`unknown media policy ${JSON.stringify(policy)}`)
  return encodeMessage([
    [1, 'message', encodeMessage([[1, 'string', display]])],
    [2, 'varint', CODEC_H264],
    [3, 'varint', maxFps],
    [4, 'varint', maxDimension],
    [5, 'varint', bitrateKbps],
    [6, 'varint', policyValue],
    [8, 'message', encodeMessage([[1, 'varint', ticketTtlSeconds]])],
  ])
}

/** The fields of an `OpenMediaResponse` the relay uses. */
export function decodeOpenMedia(fields) {
  const geometry = message(fields, 12)
  const size = message(geometry, 1)
  const opened = {
    sessionId: text(fields, 1),
    ticket: text(fields, 2),
    wsPath: text(fields, 4),
    policy: number(fields, 10),
    width: number(size, 1),
    height: number(size, 2),
  }
  if (opened.sessionId === '' || opened.ticket === '') throw new SpacesdError('cua-spacesd returned no media session')
  return opened
}
