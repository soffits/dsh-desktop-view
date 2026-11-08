/**
 * The browser-side view (viewer/session.js) with a fake WebSocket and a fake
 * frame: hiding the sidebar tab pauses the frame but must keep the view and
 * its control (OWNER-3); only destroying the view closes it on purpose.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

class FakeWebSocket {
  static OPEN = 1
  static instances = []
  readyState = 1
  sent = []
  closed = null
  constructor(url) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }
  send(text) { this.sent.push(JSON.parse(text)) }
  close(code) { this.closed = code; this.readyState = 3 }
  /** Deliver one server message. */
  receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
}

class FakeFrame extends EventEmitter {
  src = ''
  allow = ''
  addEventListener(type, handler) { this.on(type, handler) }
  removeEventListener(type, handler) { this.off(type, handler) }
}

globalThis.WebSocket = FakeWebSocket
const { createDesktopSession } = await import('../viewer/session.js')

function open() {
  FakeWebSocket.instances.length = 0
  const frame = new FakeFrame()
  const statuses = []
  const session = createDesktopSession({ frame, base: 'https://dsh.example/desktop-view/', sessionId: 's-1', onStatus: status => statuses.push(status) })
  const socket = FakeWebSocket.instances[0]
  socket.receive({ type: 'hello', resume: 'resume-token-123456789' })
  socket.receive({ type: 'state', controller: null, since: null, mine: false })
  socket.receive({ type: 'view', mode: 'watch', ticket: 'watch-1', hints: 'view_only=1' })
  return { frame, session, socket, statuses }
}

test('the status socket names the session and the frame loads the granted viewer', () => {
  const { frame, socket } = open()
  assert.equal(socket.url, 'wss://dsh.example/desktop-view/status?session=s-1')
  assert.match(frame.src, /^https:\/\/dsh\.example\/desktop-view\/d\/viewer\/\?v=1#/)
  assert.match(frame.src, /ticket=watch-1/)
})

test('pausing unloads the frame but keeps the view and its control (OWNER-3)', () => {
  const { frame, session, socket, statuses } = open()
  session.setMode('control')
  socket.receive({ type: 'view', mode: 'control', ticket: 'control-1', hints: '' })
  socket.receive({ type: 'state', controller: 'user', since: 'now', mine: true })
  session.pause()
  assert.equal(frame.src, 'about:blank', 'nothing streams while the tab is hidden')
  assert.equal(socket.closed, null, 'the status socket stays open, so control stays')
  assert.equal(socket.sent.some(message => message.type === 'give'), false)
  assert.equal(statuses.at(-1).mode, 'control')
  session.resume()
  assert.match(frame.src, /ticket=control-1/, 'shown again with the same control grant')
})

test('a grant that arrives while paused is the one shown on resume', () => {
  const { frame, session, socket } = open()
  session.pause()
  socket.receive({ type: 'view', mode: 'watch', ticket: 'watch-2', hints: '' })
  assert.equal(frame.src, 'about:blank')
  session.resume()
  assert.match(frame.src, /ticket=watch-2/)
})

test('pause and resume are idempotent', () => {
  const { frame, session } = open()
  const before = frame.src
  session.resume()
  assert.equal(frame.src, before, 'resume without pause reloads nothing')
  session.pause()
  session.pause()
  session.resume()
  assert.match(frame.src, /ticket=watch-1/)
})

test('destroying the view closes the socket on purpose, which ends it on the server', () => {
  const { frame, session, socket } = open()
  session.destroy()
  assert.equal(socket.closed, 1000)
  assert.equal(frame.src, 'about:blank')
})
