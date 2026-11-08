import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PREFIX, SECURITY_HEADERS, admitOwner, createPageHandler, isCrossSiteNavigation, parseMediaQuery, refuseUpgrade } from '../src/http.js'

/** A DSH connection double: admit() answers with the configured admission. */
const connection = admission => ({ admit: () => admission })
const owner = connection({ peer: { principal: { kind: 'owner' } } })

/** Run the page handler and collect the response it wrote. */
function respond(handler, { url = '/desktop-view/', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      status: undefined,
      headers: {},
      body: undefined,
      ended: false,
      writeHead(status, headerSet) { this.status = status; this.headers = headerSet; return this },
      end(body) { this.body = body; this.ended = true; resolve(this) },
    }
    handler({ method, url, headers }, res)
  })
}

const files = { 'page.html': Buffer.from('<html>page</html>'), 'core.js': Buffer.from('export {}'), 'page.js': Buffer.from(''), 'page.css': Buffer.from(''), 'input.js': Buffer.from('') }
const handlerFor = admission => createPageHandler({
  connection: admission,
  read: async file => files[file] ?? Promise.reject(new Error('missing')),
})

test('only the owner is admitted; other principals and refusals are not', () => {
  assert.deepEqual(admitOwner(owner, { headers: {} }), { ok: true })
  const member = connection({ peer: { principal: { kind: 'api' } } })
  assert.deepEqual(admitOwner(member, { headers: {} }), { ok: false, status: 403 })
  const anonymous = connection({ rejection: 401 })
  assert.deepEqual(admitOwner(anonymous, { headers: {} }), { ok: false, status: 401 })
})

test('the media query names a mode and an optional session', () => {
  assert.deepEqual(parseMediaQuery('/desktop-view/media'), { mode: 'watch', sessionId: null })
  assert.deepEqual(parseMediaQuery('/desktop-view/media?mode=control&session=s-1'), { mode: 'control', sessionId: 's-1' })
  assert.deepEqual(parseMediaQuery('/desktop-view/media?session=bad%20id'), { mode: 'watch', sessionId: null })
  assert.equal(parseMediaQuery('/desktop-view/media?mode=admin'), undefined)
})

test('a cross-site navigation is told apart from a fetch', () => {
  assert.equal(isCrossSiteNavigation({ 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' }), true)
  assert.equal(isCrossSiteNavigation({ 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' }), false)
  assert.equal(isCrossSiteNavigation({ 'sec-fetch-mode': 'cors' }), false)
})

test('the page and its assets are served to the owner with hardened headers', async () => {
  const res = await respond(handlerFor(owner))
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  assert.match(res.body.toString(), /<html>page<\/html>/)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[name], value, name)
  const asset = await respond(handlerFor(owner), { url: '/desktop-view/core.js' })
  assert.equal(asset.status, 200)
  assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8')
})

test('a signed-out browser is refused and told to sign in', async () => {
  const res = await respond(handlerFor(connection({ rejection: 401 })))
  assert.equal(res.status, 401)
  assert.match(res.body.toString(), /Sign in/)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('a link opened from a chat app reloads once from this origin instead of showing an error', async () => {
  const refused = handlerFor(connection({ rejection: 401 }))
  const res = await respond(refused, {
    url: '/desktop-view/?control=1',
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(res.status, 200)
  assert.match(res.body.toString(), /http-equiv="refresh"/)
  assert.match(res.body.toString(), /control=1&amp;bounced=1|control=1&bounced=1/)
  const again = await respond(refused, {
    url: '/desktop-view/?control=1&bounced=1',
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(again.status, 401)
})

test('the bare prefix redirects to the directory and keeps the query', async () => {
  const res = await respond(handlerFor(owner), { url: `/desktop-view?control=1` })
  assert.equal(res.status, 308)
  assert.equal(res.headers.location, 'desktop-view/?control=1')
})

test('unknown assets are 404 and other methods 405', async () => {
  assert.equal((await respond(handlerFor(owner), { url: '/desktop-view/secrets.js' })).status, 404)
  assert.equal((await respond(handlerFor(owner), { method: 'POST' })).status, 405)
})

test('a missing viewer file is reported, not crashed on', async () => {
  const handler = createPageHandler({ connection: owner, read: async () => { throw new Error('ENOENT') } })
  assert.equal((await respond(handler)).status, 500)
})

test('a refused upgrade ends the socket with an HTTP status', () => {
  const written = []
  refuseUpgrade({ end: text => written.push(text) }, 401)
  assert.match(written[0], /^HTTP\/1\.1 401 Unauthorized\r\n/)
  assert.match(written[0], /Connection: close/)
})

test('the viewer prefix is a single path segment under the DSH origin', () => {
  assert.equal(PREFIX, '/desktop-view')
})
