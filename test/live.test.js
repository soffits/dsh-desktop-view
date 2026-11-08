/**
 * The checks that need the real daemon, through the plugin's real routes on
 * a local HTTP server: a watch view gets frames and cannot send input or
 * reach the clipboard; Take control opens an input-capable stream whose
 * input is delivered; Give back closes it and its ticket stops working. It
 * runs only on a machine with cua-spacesd and its token file (CI has
 * neither), keeps low-rate streams open for a few seconds, and sends one
 * Shift press and release as input.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'
import { apply, Config } from '../index.js'
import { createSpacesd } from '../src/spacesd.js'
import { decodeMessage, encodeMessage, grpcWebFrame, parseGrpcWebResponse, text } from '../src/proto.js'

const TOKEN_FILE = process.env.CUA_ENV_TOKEN_FILE ?? '/run/cua/env-token'
const ENDPOINT = process.env.CUA_ENV_URL ?? 'http://127.0.0.1:3211'

async function unavailable() {
  if (!existsSync(TOKEN_FILE)) return 'no cua-spacesd token file on this machine'
  try {
    await createSpacesd({ endpoint: ENDPOINT, tokenFile: TOKEN_FILE })
      .createViewerTicket({ policy: 'view_only', clipboard: false, filesRoot: '', audioUplink: false, ttlSeconds: 60, name: 'test' })
    return false
  } catch (error) {
    return `cua-spacesd is not usable here: ${error.message}`
  }
}

const skip = await unavailable()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('watch, take control and give back work end to end against the real daemon', { skip, timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-view-live-'))
  const routes = []
  const upgrades = new Map()
  let dispose
  const ctx = {
    logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
    effect(fn) { dispose = fn() },
    webServer: {
      register(route) { routes.push(route); return () => {} },
      registerUpgrade(route) { upgrades.set(route.path, route); return () => {} },
    },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    get: () => undefined,
  }
  apply(ctx, Config({ endpoint: ENDPOINT, tokenFile: TOKEN_FILE, stateFile: join(dir, 'control.json'), maxFps: 5 }))
  const server = http.createServer((req, res) => routes[0].handler(req, res))
  server.on('upgrade', (req, socket, head) => {
    const route = upgrades.get(new URL(req.url, 'http://x').pathname)
    if (route === undefined) socket.destroy()
    else route.handler(req, socket, head)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/desktop-view/`
  const sockets = []

  const rpc = async (method, body, ticket) => {
    const response = await fetch(`${base}d/cua.env.v1.${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', 'x-cua-env-authorization': `Bearer ${ticket}` },
      body: grpcWebFrame(body),
    })
    if (response.status !== 200) return { http: response.status }
    const parsed = parseGrpcWebResponse(Buffer.from(await response.arrayBuffer()), response.headers)
    return { http: 200, status: parsed.status, fields: parsed.message && decodeMessage(parsed.message) }
  }
  const openMedia = async (ticket) => {
    const request = encodeMessage([[1, 'message', encodeMessage([[1, 'string', 'primary']])], [2, 'varint', 1], [3, 'varint', 5], [6, 'varint', 3]])
    const opened = await rpc('StreamService/OpenMedia', request, ticket)
    const socket = new WebSocket(`${base.replace('http', 'ws')}d/media?ticket=${text(opened.fields, 2)}`, ['rcdp.v2'])
    sockets.push(socket)
    const seen = { frames: 0, texts: [], close: null }
    socket.on('message', (data, binary) => { if (binary) seen.frames += 1; else seen.texts.push(JSON.parse(data)) })
    socket.on('close', (code) => { seen.close = code })
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    return { socket, seen, sessionId: text(opened.fields, 1), policy: opened.fields.get(10)?.[0] }
  }
  const shift = sessionId => JSON.stringify({
    type: 'interactive_input',
    payload: { session_id: sessionId, first_sequence: 1, events: [
      { kind: 'key', key: 'shift', state: 'down', modifiers: [], repeat: false },
      { kind: 'key', key: 'shift', state: 'up', modifiers: [], repeat: false },
    ] },
  })

  try {
    const status = new WebSocket(`${base.replace('http', 'ws')}status?session=s-live`)
    sockets.push(status)
    const messages = []
    status.on('message', data => messages.push(JSON.parse(data)))
    const next = async (predicate) => {
      for (let i = 0; i < 100; i += 1) {
        const found = messages.find(predicate)
        if (found !== undefined) return found
        await wait(50)
      }
      throw new Error('no such status message')
    }

    const watch = await next(message => message.type === 'view' && message.mode === 'watch')
    const page = await fetch(`${base}d/viewer/`)
    assert.match(await page.text(), /shim\.js/)
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/)

    assert.equal((await rpc('SystemService/GetCapabilities', Buffer.alloc(0), watch.ticket)).status, 0)
    assert.equal((await rpc('ComputerService/GetClipboard', Buffer.alloc(0), watch.ticket)).http, 403)

    const watching = await openMedia(watch.ticket)
    assert.equal(watching.policy, 1, 'the daemon caps a watch stream to view-only')
    await wait(1500)
    watching.socket.send(shift(watching.sessionId))
    await wait(800)
    assert.ok(watching.seen.frames >= 1, 'the watch stream gets frames')
    assert.equal(watching.seen.texts.some(message => message.type === 'interactive_input_acknowledgement'), false, 'the relay never forwarded the input')

    status.send(JSON.stringify({ type: 'take' }))
    const granted = await next(message => message.type === 'view' && message.mode === 'control')
    assert.equal((await rpc('ComputerService/GetClipboard', Buffer.alloc(0), granted.ticket)).status, 0)
    const controlling = await openMedia(granted.ticket)
    assert.equal(controlling.policy, 3)
    await wait(800)
    controlling.socket.send(shift(controlling.sessionId))
    await wait(800)
    const ack = controlling.seen.texts.find(message => message.type === 'interactive_input_acknowledgement')
    assert.equal(ack?.payload.delivered, true, 'input in control mode reaches the desktop')
    assert.equal(JSON.parse(await readFile(join(dir, 'control.json'), 'utf8')).controller, 'user')

    status.send(JSON.stringify({ type: 'give' }))
    await wait(800)
    assert.equal(controlling.seen.close, 4100, 'giving back closes the control stream')
    assert.equal((await rpc('ComputerService/GetClipboard', Buffer.alloc(0), granted.ticket)).http, 401)
    assert.equal(JSON.parse(await readFile(join(dir, 'control.json'), 'utf8')).controller, null)
  } finally {
    for (const socket of sockets) socket.terminate()
    await dispose?.()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
