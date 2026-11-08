import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { ACTIVITY_METHODS, METHODS, adaptCsp, adaptViewerPage, bearerOf, classifyViewerPath, createViewerProxy } from '../src/viewer.js'
import { createTicketBook } from '../src/tickets.js'
import { encodeMessage, grpcWebFrame } from '../src/proto.js'

test('viewer paths are either a flat asset or one gRPC method', () => {
  assert.deepEqual(classifyViewerPath('viewer/'), { kind: 'asset', name: '' })
  assert.deepEqual(classifyViewerPath('viewer/viewer.js'), { kind: 'asset', name: 'viewer.js' })
  assert.deepEqual(classifyViewerPath('cua.env.v1.StreamService/OpenMedia'), { kind: 'rpc', method: 'StreamService/OpenMedia' })
  assert.equal(classifyViewerPath('viewer/../index.js'), undefined)
  assert.equal(classifyViewerPath('viewer/a/b'), undefined)
  assert.equal(classifyViewerPath('files'), undefined)
  assert.equal(classifyViewerPath('cua.daemon.v1.Daemon/Do'), undefined)
})

test('watching may only stream and see presence; control adds clipboard and files', () => {
  for (const method of METHODS.watch) assert.match(method, /^(SystemService\/GetCapabilities|StreamService\/|PresenceService\/)/)
  assert.equal(METHODS.watch.includes('ComputerService/SetClipboard'), false)
  assert.equal(METHODS.control.includes('ComputerService/SetClipboard'), true)
  assert.equal(METHODS.control.includes('FilesystemService/BeginUpload'), true)
  for (const forbidden of ['SystemService/CreateViewerTicket', 'SystemService/Init', 'ProcessService/Spawn', 'FilesystemService/WriteFile', 'FilesystemService/CreateSignedUrl']) {
    assert.equal(METHODS.control.includes(forbidden), false, forbidden)
  }
})

test('every activity method is one control mode allows', () => {
  for (const method of ACTIVITY_METHODS) assert.equal(METHODS.control.includes(method), true, method)
})

test('the relay ticket is read from the viewer\'s own header or authorization', () => {
  assert.equal(bearerOf({ 'x-cua-env-authorization': 'Bearer abc' }), 'abc')
  assert.equal(bearerOf({ authorization: 'bearer xyz' }), 'xyz')
  assert.equal(bearerOf({ authorization: 'Basic abc' }), undefined)
  assert.equal(bearerOf({}), undefined)
})

test('the viewer page loads the shim first and may be framed by its own origin only', () => {
  const page = adaptViewerPage('<!doctype html><html><head><meta charset="utf-8"><script type="module" src="./viewer.js"></script></head></html>', '../../shim.js')
  assert.ok(page.indexOf('../../shim.js') < page.indexOf('./viewer.js'))
  assert.equal(adaptViewerPage('<html>no head</html>', '../../shim.js'), undefined)
  assert.equal(
    adaptCsp("default-src 'self'; frame-ancestors 'none'; base-uri 'none'"),
    "default-src 'self'; frame-ancestors 'self'; base-uri 'none'",
  )
})

/** A fake cua-spacesd: records requests and answers gRPC-Web calls. */
async function daemon(answer) {
  const seen = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
    answer(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { seen, endpoint: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

/** Run the proxy against one request and collect the response. */
async function call(proxy, { method = 'POST', rest, headers = {}, body = Buffer.alloc(0) }) {
  const server = http.createServer((req, res) => proxy(req, res, rest))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { method, headers, body: method === 'GET' ? undefined : body })
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function setup(endpoint) {
  const tickets = createTicketBook({
    spacesd: { async createViewerTicket(options) { return { ticket: `real-${options.policy}`, expiresAt: Date.now() + 3_600_000, hints: '' } } },
    features: { clipboard: true, filesRoot: '~', microphone: true },
  })
  const touched = []
  const proxy = createViewerProxy({ endpoint, tickets, touch: id => touched.push(id), logger: { warn() {}, debug() {} } })
  return { tickets, touched, proxy }
}

const grpcOk = (res, message = Buffer.alloc(0)) => {
  const status = Buffer.from('grpc-status:0\r\n')
  res.writeHead(200, { 'content-type': 'application/grpc-web+proto' })
  res.end(Buffer.concat([grpcWebFrame(message), Buffer.from([0x80, 0, 0, 0, status.length]), status]))
}

test('a call is sent on with the daemon\'s viewer ticket instead of the relay ticket', async () => {
  const fake = await daemon((req, res) => grpcOk(res))
  try {
    const { tickets, proxy } = setup(fake.endpoint)
    const relay = tickets.issue({ mode: 'watch', holderId: 'h1', sessionId: null })
    const response = await call(proxy, {
      rest: 'cua.env.v1.SystemService/GetCapabilities',
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', 'x-cua-env-authorization': `Bearer ${relay}`, cookie: 'dsh-auth=secret' },
      body: grpcWebFrame(Buffer.alloc(0)),
    })
    assert.equal(response.status, 200)
    assert.equal(fake.seen[0].url, '/cua.env.v1.SystemService/GetCapabilities')
    assert.equal(fake.seen[0].headers['x-cua-env-authorization'], 'Bearer real-view_only')
    assert.equal(fake.seen[0].headers.cookie, undefined, 'DSH cookies are not sent to the daemon')
  } finally {
    await fake.close()
  }
})

test('watching cannot reach the clipboard, and an unknown ticket reaches nothing', async () => {
  const fake = await daemon((req, res) => grpcOk(res))
  try {
    const { tickets, proxy } = setup(fake.endpoint)
    const watch = tickets.issue({ mode: 'watch', holderId: 'h1', sessionId: null })
    const clip = await call(proxy, { rest: 'cua.env.v1.ComputerService/GetClipboard', headers: { 'x-cua-env-authorization': `Bearer ${watch}` } })
    assert.equal(clip.status, 403)
    const forged = await call(proxy, { rest: 'cua.env.v1.SystemService/GetCapabilities', headers: { 'x-cua-env-authorization': 'Bearer forged' } })
    assert.equal(forged.status, 401)
    assert.equal(fake.seen.length, 0, 'nothing reached the daemon')
  } finally {
    await fake.close()
  }
})

test('control calls use the control ticket; only user actions count as activity', async () => {
  const fake = await daemon((req, res) => grpcOk(res))
  try {
    const { tickets, touched, proxy } = setup(fake.endpoint)
    const control = tickets.issue({ mode: 'control', holderId: 'h1', sessionId: 's-1' })
    const response = await call(proxy, { rest: 'cua.env.v1.ComputerService/GetClipboard', headers: { 'x-cua-env-authorization': `Bearer ${control}` } })
    assert.equal(response.status, 200)
    assert.equal(fake.seen[0].headers['x-cua-env-authorization'], 'Bearer real-allow_activation')
    assert.deepEqual(touched, [], 'clipboard polling does not keep control alive')
    await call(proxy, { rest: 'cua.env.v1.ComputerService/SetClipboard', headers: { 'x-cua-env-authorization': `Bearer ${control}` } })
    assert.deepEqual(touched, ['h1'], 'pasting into the desktop does')
    tickets.revoke(control)
    const after = await call(proxy, { rest: 'cua.env.v1.ComputerService/GetClipboard', headers: { 'x-cua-env-authorization': `Bearer ${control}` } })
    assert.equal(after.status, 401, 'a given-back control ticket stops working at once')
  } finally {
    await fake.close()
  }
})

test('an OpenMedia answer ties its media ticket to the relay ticket that asked', async () => {
  const fake = await daemon((req, res) => grpcOk(res, encodeMessage([[1, 'string', 'media-7'], [2, 'string', 'media-ticket-7']])))
  try {
    const { tickets, proxy } = setup(fake.endpoint)
    const watch = tickets.issue({ mode: 'watch', holderId: 'h1', sessionId: null })
    const response = await call(proxy, { rest: 'cua.env.v1.StreamService/OpenMedia', headers: { 'x-cua-env-authorization': `Bearer ${watch}` } })
    assert.equal(response.status, 200)
    assert.equal(tickets.media('media-ticket-7').grant.mode, 'watch')
    assert.equal(tickets.media('media-ticket-7').sessionId, 'media-7')
  } finally {
    await fake.close()
  }
})

test('the viewer page is passed through with the shim and same-origin framing', async () => {
  const fake = await daemon((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'access-control-allow-origin': '*' })
    res.end('<!doctype html><html><head><script type="module" src="./viewer.js"></script></head><body></body></html>')
  })
  try {
    const { proxy } = setup(fake.endpoint)
    const response = await call(proxy, { method: 'GET', rest: 'viewer/' })
    assert.equal(fake.seen[0].url, '/viewer/')
    assert.match(response.body.toString(), /<script src="\.\.\/\.\.\/shim\.js"><\/script>/)
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  } finally {
    await fake.close()
  }
})

test('a daemon that is down gives a 502, not a hung request', async () => {
  const { proxy } = setup('http://127.0.0.1:9')
  const response = await call(proxy, { method: 'GET', rest: 'viewer/viewer.js' })
  assert.equal(response.status, 502)
})
