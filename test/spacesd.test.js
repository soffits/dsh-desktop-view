import { test } from 'node:test'
import assert from 'node:assert/strict'
import { POLICY, SpacesdError, createSpacesd, decodeOpenMedia, decodeViewerTicket, encodeViewerTicket } from '../src/spacesd.js'
import { decodeMessage, encodeMessage, grpcWebFrame, message, number, text } from '../src/proto.js'

const grpcBody = (bytes) => {
  const status = Buffer.from('grpc-status:0\r\n')
  return Buffer.concat([grpcWebFrame(bytes), Buffer.from([0x80, 0, 0, 0, status.length]), status])
}

const ticketResponse = encodeMessage([
  [1, 'string', 'viewer-ticket-1'],
  [2, 'message', encodeMessage([[1, 'varint', 1_800_000_000]])],
  [3, 'string', '/viewer/#ticket=viewer-ticket-1&clipboard=0'],
  [4, 'string', '/home/cua'],
])

test('a control viewer ticket asks for input, clipboard, files and the microphone', () => {
  const fields = decodeMessage(encodeViewerTicket({ policy: 'allow_activation', clipboard: true, filesRoot: '~', audioUplink: true, ttlSeconds: 3600, name: 'Owner' }))
  assert.equal(number(message(fields, 1), 1), 3600)
  assert.equal(number(fields, 2), POLICY.allow_activation)
  assert.equal(number(fields, 3), 1)
  assert.equal(text(fields, 4), '~')
  assert.equal(number(fields, 5), 1)
  assert.equal(text(message(fields, 6), 2), 'Owner')
})

test('a watch viewer ticket asks for nothing but the view-only stream', () => {
  const fields = decodeMessage(encodeViewerTicket({ policy: 'view_only', clipboard: false, filesRoot: '', audioUplink: false, ttlSeconds: 3600, name: 'Owner' }))
  assert.equal(number(fields, 2), POLICY.view_only)
  assert.equal(fields.has(3), false)
  assert.equal(fields.has(4), false)
  assert.equal(fields.has(5), false)
})

test('an unknown policy is refused rather than sent as the default', () => {
  assert.throws(() => encodeViewerTicket({ policy: 'root', clipboard: false, filesRoot: '', audioUplink: false, ttlSeconds: 60, name: '' }), /unknown viewer policy/)
})

test('the minted ticket comes back with its expiry and the viewer hints, without the ticket in the hints', () => {
  const minted = decodeViewerTicket(decodeMessage(ticketResponse))
  assert.equal(minted.ticket, 'viewer-ticket-1')
  assert.equal(minted.expiresAt, 1_800_000_000_000)
  assert.equal(minted.hints, 'clipboard=0')
  assert.throws(() => decodeViewerTicket(decodeMessage(encodeMessage([[3, 'string', '/viewer/']]))), SpacesdError)
})

test('an OpenMedia answer names its media session and ticket', () => {
  const fields = decodeMessage(encodeMessage([[1, 'string', 'media-1'], [2, 'string', 'media-ticket']]))
  assert.deepEqual(decodeOpenMedia(fields), { sessionId: 'media-1', ticket: 'media-ticket' })
  assert.equal(decodeOpenMedia(decodeMessage(encodeMessage([[1, 'string', 'media-1']]))), undefined)
})

test('minting sends the env token as a header only, never in the URL', async () => {
  const calls = []
  const spacesd = createSpacesd({
    endpoint: 'http://127.0.0.1:3211/',
    tokenFile: '/run/cua/env-token',
    readToken: async () => 'secret-token',
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response(grpcBody(ticketResponse), { status: 200 })
    },
  })
  const minted = await spacesd.createViewerTicket({ policy: 'view_only', clipboard: false, filesRoot: '', audioUplink: false, ttlSeconds: 3600, name: 'Owner' })
  assert.equal(minted.ticket, 'viewer-ticket-1')
  assert.equal(calls[0].url, 'http://127.0.0.1:3211/cua.env.v1.SystemService/CreateViewerTicket')
  assert.equal(calls[0].url.includes('secret-token'), false)
  assert.equal(calls[0].init.headers['x-cua-env-authorization'], 'Bearer secret-token')
  assert.equal(calls[0].init.headers['content-type'], 'application/grpc-web+proto')
})

test('a daemon that answers with a gRPC failure becomes one readable error', async () => {
  const spacesd = createSpacesd({
    endpoint: 'http://127.0.0.1:3211',
    tokenFile: '/run/cua/env-token',
    readToken: async () => 'secret-token',
    fetch: async () => new Response(Buffer.alloc(0), { status: 200, headers: { 'grpc-status': '16', 'grpc-message': 'bad%20token' } }),
  })
  await assert.rejects(
    () => spacesd.createViewerTicket({ policy: 'view_only', clipboard: false, filesRoot: '', audioUplink: false, ttlSeconds: 60, name: '' }),
    error => error instanceof SpacesdError && error.status === 16 && /bad token/.test(error.message),
  )
})

test('an unreachable daemon and a missing token file are reported plainly', async () => {
  const options = { policy: 'view_only', clipboard: false, filesRoot: '', audioUplink: false, ttlSeconds: 60, name: '' }
  const unreachable = createSpacesd({
    endpoint: 'http://127.0.0.1:3211',
    tokenFile: '/run/cua/env-token',
    readToken: async () => 'secret-token',
    fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) },
  })
  await assert.rejects(() => unreachable.createViewerTicket(options), /not reachable .*ECONNREFUSED/)
  const noToken = createSpacesd({
    endpoint: 'http://127.0.0.1:3211',
    tokenFile: '/run/cua/env-token',
    readToken: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
    fetch: async () => { throw new Error('must not be called') },
  })
  await assert.rejects(() => noToken.createViewerTicket(options), /cannot read the cua-spacesd token file \(ENOENT\)/)
})
