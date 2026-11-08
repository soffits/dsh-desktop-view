/**
 * The relay's own calls to cua-spacesd: minting viewer tickets. The env
 * token is read from its file for every call, so a rotated token is picked
 * up, and it only ever travels in a request header to the daemon; it is
 * never logged, put in a URL or sent to a browser.
 *
 * A viewer ticket is the daemon's scoped credential for its web viewer
 * (`SystemService.CreateViewerTicket`): a session-policy ceiling (a
 * view-only ticket cannot open an input-capable stream), clipboard access,
 * a file root, microphone uplink, and a lifetime. The daemon enforces the
 * scope itself; the relay keeps the tickets server-side too.
 */
import { readFile } from 'node:fs/promises'
import { decodeMessage, encodeMessage, grpcWebFrame, message, number, parseGrpcWebResponse, text } from './proto.js'

/** `SessionPolicy` values of stream.proto. */
export const POLICY = Object.freeze({ view_only: 1, allow_activation: 3 })

/** How long one call to the daemon may take. */
const CALL_TIMEOUT_MS = 10_000

/** gRPC status the daemon answers when a bearer is missing or no longer valid. */
export const UNAUTHENTICATED = 16

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

  async function call(service, method, body) {
    const secret = await token(tokenFile).catch((error) => {
      throw new SpacesdError(`cannot read the cua-spacesd token file (${error.code ?? 'error'})`)
    })
    if (secret === '') throw new SpacesdError('the cua-spacesd token file is empty')
    let response
    try {
      response = await fetch(`${base}/cua.env.v1.${service}/${method}`, {
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
    /** Base URL of the daemon, without a trailing slash. */
    base,

    /**
     * Mint a viewer ticket.
     * @param {{ policy: keyof typeof POLICY, clipboard: boolean, filesRoot: string, audioUplink: boolean, ttlSeconds: number, name: string }} options
     * @returns {Promise<{ ticket: string, expiresAt: number, hints: string }>} `hints` is the viewer fragment without the ticket.
     */
    async createViewerTicket(options) {
      return decodeViewerTicket(await call('SystemService', 'CreateViewerTicket', encodeViewerTicket(options)))
    },
  }
}

/** The `CreateViewerTicketRequest` bytes. */
export function encodeViewerTicket({ policy, clipboard, filesRoot, audioUplink, ttlSeconds, name }) {
  const policyValue = POLICY[policy]
  if (policyValue === undefined) throw new Error(`unknown viewer policy ${JSON.stringify(policy)}`)
  return encodeMessage([
    [1, 'message', encodeMessage([[1, 'varint', ttlSeconds]])],
    [2, 'varint', policyValue],
    [3, 'varint', clipboard ? 1 : 0],
    [4, 'string', filesRoot],
    [5, 'varint', audioUplink ? 1 : 0],
    // PrincipalKind 1 is a human; the daemon prefixes the id with `viewer:`.
    [6, 'message', encodeMessage([[1, 'string', 'dsh-owner'], [2, 'string', name], [4, 'varint', 1]])],
  ])
}

/** The fields of a `CreateViewerTicketResponse` the relay uses. */
export function decodeViewerTicket(fields) {
  const ticket = text(fields, 1)
  if (ticket === '') throw new SpacesdError('cua-spacesd returned no viewer ticket')
  const expires = message(fields, 2)
  const fragment = new URLSearchParams(text(fields, 3).split('#')[1] ?? '')
  fragment.delete('ticket')
  return { ticket, expiresAt: number(expires, 1) * 1000, hints: fragment.toString() }
}

/**
 * The media session id and ticket from an `OpenMediaResponse`, so the relay
 * can tell which viewer opened a media socket.
 * @returns {{ sessionId: string, ticket: string } | undefined}
 */
export function decodeOpenMedia(fields) {
  const sessionId = text(fields, 1)
  const ticket = text(fields, 2)
  return sessionId === '' || ticket === '' ? undefined : { sessionId, ticket }
}
