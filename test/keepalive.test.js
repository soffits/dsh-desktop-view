/**
 * Regression for views that froze, then disconnected and
 * reconnected: on the public path a proxy (Cloudflare's tunnel) closes a
 * WebSocket after about 100 s without traffic. The status socket is silent
 * between control changes and the media socket is silent while the desktop
 * does not change, so both were cut, and a cut status socket ended the view.
 * These tests put an idle-cutting proxy in front of a real WebSocket server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { keepAlive } from '../src/keepalive.js'

/** A TCP proxy that closes any connection idle (no bytes either way) for `idleMs`. */
async function idleCuttingProxy(targetPort, idleMs) {
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1')
    let timer
    const cut = () => { client.destroy(); upstream.destroy() }
    const touch = () => { clearTimeout(timer); timer = setTimeout(cut, idleMs) }
    touch()
    client.on('data', (chunk) => { touch(); upstream.write(chunk) })
    upstream.on('data', (chunk) => { touch(); client.write(chunk) })
    client.on('close', () => { clearTimeout(timer); upstream.destroy() })
    upstream.on('close', () => { clearTimeout(timer); client.destroy() })
    client.on('error', () => {})
    upstream.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) }
}

async function wsServer(onConnection) {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise(resolve => wss.once('listening', resolve))
  wss.on('connection', onConnection)
  return { port: wss.address().port, close: () => new Promise(resolve => wss.close(resolve)) }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Open a client through the proxy and report whether it is still open after `ms`. */
async function survives(proxyPort, ms) {
  const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/`)
  let closed = false
  client.on('close', () => { closed = true })
  client.on('error', () => {})
  await new Promise(resolve => client.once('open', resolve))
  await wait(ms)
  const open = !closed
  client.terminate()
  return open
}

test('without keepalive, a quiet socket is cut by an idle proxy (the reported freeze)', async () => {
  const server = await wsServer(() => {})
  const proxy = await idleCuttingProxy(server.port, 150)
  try {
    assert.equal(await survives(proxy.port, 500), false)
  } finally {
    await proxy.close()
    await server.close()
  }
})

test('with keepalive, the same quiet socket stays open through the idle proxy', async () => {
  const server = await wsServer(socket => keepAlive(socket, { intervalMs: 50 }))
  const proxy = await idleCuttingProxy(server.port, 150)
  try {
    assert.equal(await survives(proxy.port, 500), true)
  } finally {
    await proxy.close()
    await server.close()
  }
})

/** A socket double for the timer logic. */
class FakeSocket extends EventEmitter {
  OPEN = 1
  readyState = 1
  pings = 0
  terminated = false
  ping() { this.pings += 1 }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close', 1006) }
}

function manualTimer() {
  let tick
  return {
    setTimer: (callback) => { tick = callback; return { unref() {} } },
    clearTimer: () => { tick = undefined },
    tick: () => tick?.(),
  }
}

test('a socket that answers pings is kept, one that stops answering is dropped', () => {
  const socket = new FakeSocket()
  const timer = manualTimer()
  const beats = []
  keepAlive(socket, { ...timer, beat: () => beats.push(1) })
  timer.tick()
  assert.equal(socket.pings, 1)
  assert.equal(beats.length, 1, 'the app-level heartbeat goes with each ping')
  socket.emit('pong')
  timer.tick()
  assert.equal(socket.pings, 2)
  assert.equal(socket.terminated, false)
  timer.tick()
  assert.equal(socket.terminated, true, 'no pong for a whole interval: the link is dead')
})

test('keepalive stops with the socket', () => {
  const socket = new FakeSocket()
  const timer = manualTimer()
  keepAlive(socket, timer)
  socket.emit('close', 1000)
  timer.tick()
  assert.equal(socket.pings, 0)
})
