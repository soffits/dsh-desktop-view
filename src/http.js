/**
 * The plugin's routes on DSH's own web server, all under one prefix:
 *
 *   GET  /desktop-view/              full-screen page (phones, direct links): status bar + viewer
 *   GET  /desktop-view/<asset>       its script, styles, the shared session module and the viewer shim
 *   *    /desktop-view/d/...         the relayed Cua viewer and its gRPC-Web calls (src/viewer.js)
 *   WS   /desktop-view/status        one open view's status, Take control / Give back (src/status.js)
 *   WS   /desktop-view/d/media       the viewer's media socket (src/media.js)
 *
 * Every request goes through `connection.admit`, the same check DSH applies
 * to its own API: the Host/Origin fence against cross-site and rebinding
 * requests, then the signed browser cookie. Only the owner gets through.
 * (DSH's reverse proxy with its OIDC gate sits in front of all of this too.)
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { VIEWER_BASE } from './viewer.js'

export const PREFIX = '/desktop-view'
export const STATUS_PATH = `${PREFIX}/status`
export const MEDIA_PATH = `${PREFIX}/${VIEWER_BASE}media`

/** The plugin's own static files, by the path segment they are served under. */
export const ASSETS = Object.freeze({
  '': { file: 'page.html', type: 'text/html; charset=utf-8' },
  'page.js': { file: 'page.js', type: 'text/javascript; charset=utf-8' },
  'page.css': { file: 'page.css', type: 'text/css; charset=utf-8' },
  'session.js': { file: 'session.js', type: 'text/javascript; charset=utf-8' },
  'shim.js': { file: 'shim.js', type: 'text/javascript; charset=utf-8' },
  'icon.svg': { file: '../icon.svg', type: 'image/svg+xml' },
})

const VIEWER_DIR = fileURLToPath(new URL('../viewer/', import.meta.url))

/** Headers on the plugin's own pages: never cached, not framed by others, no referrer. */
export const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
})

/** Session ids are opaque but short and URL-safe; anything else is ignored. */
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/

/**
 * Admit one request as the owner.
 * @param {{ admit: (request: { headers: object }) => ({ peer: { principal: { kind: string } } } | { rejection: 401 | 403 }) }} connection
 * @param {{ headers: object }} request
 * @returns {{ ok: true } | { ok: false, status: 401 | 403 }}
 */
export function admitOwner(connection, request) {
  const admission = connection.admit(request)
  if ('rejection' in admission) return { ok: false, status: admission.rejection }
  if (admission.peer?.principal?.kind !== 'owner') return { ok: false, status: 403 }
  return { ok: true }
}

/** Resume tokens are random base64url. */
const RESUME = /^[A-Za-z0-9_-]{16,64}$/

/**
 * What a status socket names: the DSH session the view was opened from,
 * and the view it resumes after a dropped connection. Malformed values are
 * ignored.
 * @param {string | undefined} url - The request target.
 * `help=1` marks a view opened from a help link the agent sent, so giving
 * control back wakes the agent to carry on.
 * @returns {{ sessionId: string | null, resume: string | null, help: boolean }}
 */
export function statusQuery(url) {
  const params = new URL(url ?? '/', 'http://relay.invalid').searchParams
  const session = params.get('session')
  const resume = params.get('resume')
  return {
    sessionId: session !== null && SESSION_ID.test(session) ? session : null,
    resume: resume !== null && RESUME.test(resume) ? resume : null,
    help: params.get('help') === '1',
  }
}

/**
 * Whether a refused request is a cross-site page navigation (a link opened
 * from a chat app or mail). DSH's cookie is SameSite=Strict, so such a
 * navigation arrives without it; a page that reloads itself from this origin
 * then carries the cookie.
 */
export function isCrossSiteNavigation(headers) {
  return headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-site'] === 'cross-site'
}

/** Query flag on the reload, so a reload that still fails is not repeated. */
const BOUNCED = 'bounced'

/**
 * A page that only reloads the same URL from this origin; it holds nothing.
 * @param {URLSearchParams} params - The request's query.
 */
function bouncePage(params) {
  const next = new URLSearchParams(params)
  next.set(BOUNCED, '1')
  const target = `?${next.toString()}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><title>Desktop</title>`
}

/**
 * The HTTP handler for everything under the prefix.
 * @param {object} options
 * @param {object} options.connection - DSH `ctx.connection`.
 * @param {(req: object, res: object, rest: string) => Promise<void>} options.viewer - Handles `d/...`.
 * @param {(file: string) => Promise<Buffer>} [options.read]
 */
export function createPageHandler({ connection, viewer, read = file => readFile(VIEWER_DIR + file) }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay.invalid')
    const admitted = admitOwner(connection, req)
    if (!admitted.ok) {
      if (req.method === 'GET' && isCrossSiteNavigation(req.headers) && !url.searchParams.has(BOUNCED)) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' }).end(bouncePage(url.searchParams))
        return
      }
      res.writeHead(admitted.status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
        .end(admitted.status === 401 ? 'Sign in to DSH first.\n' : 'Forbidden.\n')
      return
    }
    const rest = url.pathname.slice(PREFIX.length + 1)
    if (url.pathname.startsWith(`${PREFIX}/${VIEWER_BASE}`)) {
      await viewer(req, res, rest.slice(VIEWER_BASE.length))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, allow: 'GET, HEAD' }).end()
      return
    }
    if (url.pathname === PREFIX) {
      // Relative assets need the trailing slash; keep the query (control, session).
      res.writeHead(308, { ...SECURITY_HEADERS, location: `${PREFIX.slice(PREFIX.lastIndexOf('/') + 1)}/${url.search}` }).end()
      return
    }
    const asset = ASSETS[rest]
    if (asset === undefined) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('Not found.\n')
      return
    }
    let body
    try {
      body = await read(asset.file)
    } catch {
      res.writeHead(500, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('The viewer files are missing.\n')
      return
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset.type, 'content-length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}

/** Refuse an upgrade before any WebSocket handshake. */
export function refuseUpgrade(socket, status) {
  const text = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden' }[status] ?? 'Error'
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
