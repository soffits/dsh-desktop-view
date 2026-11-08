/**
 * HTTP side of the relayed Cua viewer, under one fixed base (`/desktop-view/d/`):
 *
 *   GET  d/viewer/[asset]             the daemon's viewer page and assets
 *   POST d/cua.env.v1.<Service>/<Rpc>  gRPC-Web calls the viewer makes
 *
 * The page is the daemon's own (`/viewer/` on cua-spacesd), passed through
 * with two changes: a same-origin script runs first so the viewer's fetches
 * carry cookies (it sends them with `credentials: "omit"`, which DSH's
 * login and the OIDC proxy in front of it would refuse), and the page may be
 * framed by its own origin, for the sidebar tab.
 *
 * A gRPC-Web call carries a relay ticket where the viewer would send a
 * viewer ticket. The relay looks it up, checks the method against its mode's
 * allow-list, swaps in the daemon's viewer ticket for that mode, and streams
 * the call through. OpenMedia answers are read on the way back, so the
 * media socket can later be tied to the relay ticket that opened it.
 */
import http from 'node:http'
import https from 'node:https'
import { Buffer } from 'node:buffer'
import { decodeMessage, parseGrpcWebResponse } from './proto.js'
import { UNAUTHENTICATED, decodeOpenMedia } from './spacesd.js'

/** The viewer's base path under the plugin prefix. */
export const VIEWER_BASE = 'd/'

/** Script the relay serves, which the viewer page loads first. */
export const SHIM_PATH = 'shim.js'

const WATCH_METHODS = Object.freeze([
  'SystemService/GetCapabilities',
  'StreamService/ListTargets',
  'StreamService/OpenMedia',
  'StreamService/SetPreferences',
  'StreamService/RequestKeyframe',
  'StreamService/CloseMedia',
  'PresenceService/Join',
  'PresenceService/UpdateCursor',
  'PresenceService/Leave',
])

/** gRPC methods per mode: exactly what the viewer calls, nothing else. */
export const METHODS = Object.freeze({
  watch: WATCH_METHODS,
  control: Object.freeze([
    ...WATCH_METHODS,
    'ComputerService/GetClipboard',
    'ComputerService/SetClipboard',
    'FilesystemService/Stat',
    'FilesystemService/ListDir',
    'FilesystemService/MakeDir',
    'FilesystemService/Move',
    'FilesystemService/Remove',
    'FilesystemService/ReadFile',
    'FilesystemService/BeginUpload',
    'FilesystemService/UploadChunk',
    'FilesystemService/CommitUpload',
    'FilesystemService/AbortUpload',
    'FilesystemService/CreateWatcher',
    'FilesystemService/GetWatcherEvents',
    'FilesystemService/RemoveWatcher',
  ]),
})

/**
 * Calls that mean the person in control did something, which keeps control
 * from going idle. Polling the viewer does on its own (clipboard sync,
 * folder watching) does not count.
 */
export const ACTIVITY_METHODS = Object.freeze([
  'ComputerService/SetClipboard',
  'FilesystemService/MakeDir',
  'FilesystemService/Move',
  'FilesystemService/Remove',
  'FilesystemService/ReadFile',
  'FilesystemService/BeginUpload',
  'FilesystemService/UploadChunk',
  'FilesystemService/CommitUpload',
])

/** Request headers passed to the daemon on a gRPC-Web call. */
const FORWARD_REQUEST = Object.freeze(['content-type', 'x-grpc-web', 'x-user-agent', 'grpc-timeout', 'accept', 'content-length'])
/** Response headers passed back to the viewer. */
const FORWARD_RESPONSE = Object.freeze(['content-type', 'grpc-status', 'grpc-message', 'grpc-status-details-bin', 'cache-control', 'content-length', 'etag', 'last-modified'])

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const RPC_PATH = /^cua\.env\.v1\.([A-Za-z]+)\/([A-Za-z]+)$/

/**
 * Where a path under the viewer base goes.
 * @param {string} rest - The path after `/desktop-view/d/`.
 * @returns {{ kind: 'asset', name: string } | { kind: 'rpc', method: string } | undefined}
 */
export function classifyViewerPath(rest) {
  if (rest === 'viewer/' || rest === 'viewer') return { kind: 'asset', name: '' }
  if (rest.startsWith('viewer/')) {
    const name = rest.slice('viewer/'.length)
    return ASSET_NAME.test(name) ? { kind: 'asset', name } : undefined
  }
  const rpc = RPC_PATH.exec(rest)
  return rpc === null ? undefined : { kind: 'rpc', method: `${rpc[1]}/${rpc[2]}` }
}

/** The relay ticket a viewer request carries. */
export function bearerOf(headers) {
  const value = headers['x-cua-env-authorization'] ?? headers.authorization
  const match = typeof value === 'string' ? /^Bearer\s+(\S+)$/i.exec(value) : null
  return match?.[1]
}

/**
 * Make the daemon's viewer page fit the relay: load the shim before
 * anything else and allow same-origin framing.
 * @param {string} html
 * @param {string} shimUrl - Relative URL of the shim from the page.
 * @returns {string | undefined} undefined when the page has no `<head>` to put it in
 */
export function adaptViewerPage(html, shimUrl) {
  const head = /<head[^>]*>/i.exec(html)
  if (head === null) return undefined
  const at = head.index + head[0].length
  return `${html.slice(0, at)}\n    <script src="${shimUrl}"></script>${html.slice(at)}`
}

/** The daemon page's CSP with framing allowed for this origin only. */
export function adaptCsp(value) {
  if (typeof value !== 'string') return value
  return value.replace(/frame-ancestors\s+[^;]*/i, "frame-ancestors 'self'")
}

/**
 * @param {object} options
 * @param {string} options.endpoint - cua-spacesd base URL.
 * @param {ReturnType<typeof import('./tickets.js').createTicketBook>} options.tickets
 * @param {(holderId: string) => void} options.touch - Records activity of a control holder.
 * @param {{ warn: Function, debug: Function }} options.logger
 * @param {typeof http.request} [options.request] - Test seam.
 */
export function createViewerProxy({ endpoint, tickets, touch, logger, request }) {
  const upstreamBase = new URL(endpoint.replace(/\/*$/, '/'))
  const send = request ?? (upstreamBase.protocol === 'https:' ? https.request : http.request)

  const fail = (res, status, text) => {
    if (res.headersSent) return res.destroy()
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(`${text}\n`)
  }

  /** Copy the allowed headers of a daemon response. */
  const responseHeaders = (upstream, pick = FORWARD_RESPONSE) => {
    const headers = {}
    for (const name of pick) if (upstream.headers[name] !== undefined) headers[name] = upstream.headers[name]
    return headers
  }

  async function asset(req, res, name) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed.')
    const upstream = await forward({ method: 'GET', path: `/viewer/${name}`, headers: {} })
    const headers = {
      ...responseHeaders(upstream, ['content-type', 'cache-control', 'etag', 'last-modified', 'permissions-policy', 'cross-origin-opener-policy']),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    }
    const csp = adaptCsp(upstream.headers['content-security-policy'])
    if (csp !== undefined) headers['content-security-policy'] = csp
    const isPage = String(upstream.headers['content-type'] ?? '').startsWith('text/html')
    if (!isPage) {
      res.writeHead(upstream.statusCode ?? 502, headers)
      if (req.method === 'HEAD') {
        upstream.resume()
        res.end()
        return
      }
      upstream.pipe(res)
      return
    }
    const html = (await readAll(upstream)).toString('utf8')
    const page = upstream.statusCode === 200 ? adaptViewerPage(html, `../../${SHIM_PATH}`) : html
    if (page === undefined) return fail(res, 502, 'The desktop viewer page changed shape; update dsh-desktop-view.')
    const body = Buffer.from(page)
    res.writeHead(upstream.statusCode ?? 502, { ...headers, 'cache-control': 'no-store', 'content-length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  async function rpc(req, res, method) {
    if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.')
    const token = bearerOf(req.headers)
    const grant = tickets.lookup(token)
    if (grant === undefined) return fail(res, 401, 'This desktop view has expired; reload it.')
    if (!METHODS[grant.mode]?.includes(method)) return fail(res, 403, `${method} is not available in ${grant.mode} mode.`)
    if (grant.mode === 'control' && ACTIVITY_METHODS.includes(method)) touch(grant.holderId)
    const viewer = await tickets.viewerTicket(grant.mode)
    const headers = { 'x-cua-env-authorization': `Bearer ${viewer.ticket}` }
    for (const name of FORWARD_REQUEST) if (req.headers[name] !== undefined) headers[name] = req.headers[name]
    const upstream = await forward({ method: 'POST', path: `/cua.env.v1.${method}`, headers, body: req })
    if (Number(upstream.headers['grpc-status']) === UNAUTHENTICATED) tickets.invalidate(grant.mode)
    res.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream))
    if (method !== 'StreamService/OpenMedia') {
      upstream.pipe(res)
      return
    }
    const body = await readAll(upstream)
    try {
      const parsed = parseGrpcWebResponse(body, new Headers())
      const opened = parsed.status === 0 && parsed.message !== undefined ? decodeOpenMedia(decodeMessage(parsed.message)) : undefined
      if (opened !== undefined) tickets.bindMedia(opened.ticket, token, opened.sessionId)
    } catch (error) {
      logger.debug('could not read an OpenMedia answer: %s', error.message)
    }
    res.end(body)
  }

  /** One request to the daemon; resolves with its response. */
  function forward({ method, path, headers, body }) {
    return new Promise((resolve, reject) => {
      const outgoing = send(new URL(path.replace(/^\//, ''), upstreamBase), { method, headers }, resolve)
      outgoing.on('error', reject)
      if (body === undefined) outgoing.end()
      else body.pipe(outgoing)
    })
  }

  /**
   * Handle a request under the viewer base.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} rest - Path after the viewer base.
   */
  return async (req, res, rest) => {
    const target = classifyViewerPath(rest)
    try {
      if (target?.kind === 'asset') await asset(req, res, target.name)
      else if (target?.kind === 'rpc') await rpc(req, res, target.method)
      else fail(res, 404, 'Not found.')
    } catch (error) {
      logger.warn('desktop viewer request failed: %s', error.message)
      fail(res, 502, 'The desktop is not reachable right now.')
    }
  }
}

async function readAll(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}
