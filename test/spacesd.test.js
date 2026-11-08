import { test } from 'node:test'
import assert from 'node:assert/strict'
import { POLICY, SpacesdError, createSpacesd, decodeOpenMedia, encodeOpenMedia } from '../src/spacesd.js'
import { decodeMessage, encodeMessage, grpcWebFrame } from '../src/proto.js'

const grpcBody = bytes => {
  const status = Buffer.from('grpc-status:0\r\n')
  return Buffer.concat([grpcWebFrame(bytes), Buffer.from([0x80, 0, 0, 0, status.length]), status])
}

const openResponse = encodeMessage([
  [1, 'string', 'media-1-abc'],
  [2, 'string', 'ticket-123'],
  [4, 'string', '/media?ticket=ticket-123'],
  [10, 'varint', POLICY.view_only],
  [12, 'message', encodeMessage([[1, 'message', encodeMessage([[1, 'varint', 1280], [2, 'varint', 800]])]])],
])

test('encodeOpenMedia carries the display, codec, policy and ticket lifetime', () => {
  const fields = decodeMessage(encodeOpenMedia({
    display: 'primary', policy: 'allow_activation', maxFps: 15, maxDimension: 1280, bitrateKbps: 2000, ticketTtlSeconds: 30,
  }))
  const target = fields.get(1)[0]
  assert.equal(target.toString(), encodeMessage([[1, 'string', 'primary']]).toString())
  assert.equal(fields.get(2)[0], 1)
  assert.equal(fields.get(3)[0], 15)
  assert.equal(fields.get(4)[0], 1280)
  assert.equal(fields.get(5)[0], 2000)
  assert.equal(fields.get(6)[0], POLICY.allow_activation)
  assert.equal(decodeMessage(fields.get(8)[0]).get(1)[0], 30)
})

test('encodeOpenMedia refuses an unknown policy rather than sending a default', () => {
  assert.throws(() => encodeOpenMedia({ display: 'primary', policy: 'full_control', maxFps: 15, maxDimension: 0, bitrateKbps: 0, ticketTtlSeconds: 30 }), /unknown media policy/)
})

test('decodeOpenMedia reads the session, ticket, path, policy and frame size', () => {
  assert.deepEqual(decodeOpenMedia(decodeMessage(openResponse)), {
    sessionId: 'media-1-abc', ticket: 'ticket-123', wsPath: '/media?ticket=ticket-123', policy: 1, width: 1280, height: 800,
  })
})

test('decodeOpenMedia rejects a response without a session', () => {
  assert.throws(() => decodeOpenMedia(decodeMessage(encodeMessage([[1, 'string', 'only-a-session']]))), SpacesdError)
})

test('openMedia sends the token header, never the URL, and reads the session', async () => {
  const calls = []
  const spacesd = createSpacesd({
    endpoint: 'http://127.0.0.1:3211/',
    tokenFile: '/run/cua/env-token',
    readToken: async () => 'secret-token',
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response(grpcBody(openResponse), { status: 200 })
    },
  })
  const opened = await spacesd.openMedia({ display: 'primary', policy: 'view_only', maxFps: 15, maxDimension: 0, bitrateKbps: 0, ticketTtlSeconds: 30 })
  assert.equal(opened.sessionId, 'media-1-abc')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:3211/cua.env.v1.StreamService/OpenMedia')
  assert.equal(calls[0].url.includes('secret-token'), false)
  assert.equal(calls[0].init.headers['x-cua-env-authorization'], 'Bearer secret-token')
  assert.equal(calls[0].init.headers['content-type'], 'application/grpc-web+proto')
  assert.equal(calls[0].init.body.readUInt32BE(1) > 0, true)
})

test('a daemon that answers with a gRPC failure becomes one readable error', async () => {
  const spacesd = createSpacesd({
    endpoint: 'http://127.0.0.1:3211',
    tokenFile: '/run/cua/env-token',
    readToken: async () => 'secret-token',
    fetch: async () => new Response(Buffer.alloc(0), { status: 200, headers: { 'grpc-status': '14', 'grpc-message': 'no%20display' } }),
  })
  await assert.rejects(
    () => spacesd.openMedia({ display: 'primary', policy: 'view_only', maxFps: 15, maxDimension: 0, bitrateKbps: 0, ticketTtlSeconds: 30 }),
    error => error instanceof SpacesdError && error.status === 14 && /no display/.test(error.message),
  )
})

test('an unreachable daemon and a missing token file are reported plainly', async () => {
  const unreachable = createSpacesd({
    endpoint: 'http://127.0.0.1:3211',
    tokenFile: '/run/cua/env-token',
    readToken: async () => 'secret-token',
    fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) },
  })
  await assert.rejects(() => unreachable.closeMedia('media-1-abc'), /not reachable .*ECONNREFUSED/)
  const noToken = createSpacesd({
    endpoint: 'http://127.0.0.1:3211',
    tokenFile: '/run/cua/env-token',
    readToken: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
    fetch: async () => { throw new Error('must not be called') },
  })
  await assert.rejects(() => noToken.closeMedia('media-1-abc'), /cannot read the cua-spacesd token file \(ENOENT\)/)
})

test('attach asks for the media path with the ticket as a subprotocol', async () => {
  const { WebSocketServer } = await import('ws')
  const server = new WebSocketServer({ port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const { port } = server.address()
  const seen = new Promise(resolve => server.on('connection', (socket, request) => resolve(request)))
  const spacesd = createSpacesd({ endpoint: `http://127.0.0.1:${port}`, tokenFile: '/unused' })
  const socket = spacesd.attach({ wsPath: '/media?ticket=abc', ticket: 'abc' })
  try {
    const request = await seen
    assert.equal(request.url, '/media')
    assert.equal(request.headers['sec-websocket-protocol'], 'rcdp.v2,cua.ticket.abc')
  } finally {
    await new Promise(resolve => {
      if (socket.readyState === socket.OPEN) socket.close()
      else socket.once('open', () => socket.close())
      socket.once('close', resolve)
    })
    await new Promise(resolve => server.close(resolve))
  }
})
