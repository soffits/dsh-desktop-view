import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createViews } from '../src/status.js'
import { createControl } from '../src/control.js'
import { createTicketBook } from '../src/tickets.js'

class FakeSocket extends EventEmitter {
  OPEN = 1
  readyState = 1
  sent = []
  send(text) { this.sent.push(JSON.parse(text)) }
  ping() {}
  terminate() { this.drop() }
  /** The page closed the view on purpose. */
  close(code = 1000) { this.readyState = 3; this.emit('close', code) }
  /** The connection was cut (a proxy, the network). */
  drop() { this.readyState = 3; this.emit('close', 1006) }
  messages(type) { return this.sent.filter(message => message.type === type) }
}

const settle = () => new Promise(resolve => setImmediate(resolve))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function harness({ mint, graceMs = 50 } = {}) {
  const control = createControl({ idleMs: 60_000, persist: async () => {} })
  const tickets = createTicketBook({
    spacesd: { createViewerTicket: mint ?? (async options => ({ ticket: `real-${options.policy}`, expiresAt: Date.now() + 3_600_000, hints: 'clipboard=0' })) },
    features: { clipboard: true, filesRoot: '~', microphone: true },
  })
  const views = createViews({
    control, tickets, viewer: { maxFps: 30 }, logger: { warn() {}, debug() {} }, graceMs,
    keepalive: { setTimer: () => ({ unref() {} }), clearTimer: () => {} },
  })
  const open = (sessionId = 's-1', resume = null, help = false) => {
    const socket = new FakeSocket()
    const view = views.attach(socket, { sessionId, resume, help })
    return { socket, view }
  }
  return { control, tickets, views, open }
}

const take = async (socket) => {
  socket.emit('message', JSON.stringify({ type: 'take' }))
  await settle()
  return socket.messages('view').find(message => message.mode === 'control')
}

test('a new view starts watching with a view-only relay ticket and a resume token', async () => {
  const { tickets, open } = harness()
  const { socket } = open()
  await settle()
  assert.equal(typeof socket.messages('hello')[0].resume, 'string')
  assert.equal(socket.messages('state')[0].controller, null)
  const [view] = socket.messages('view')
  assert.equal(view.mode, 'watch')
  assert.equal(tickets.lookup(view.ticket).mode, 'watch')
  const hints = new URLSearchParams(view.hints)
  assert.equal(hints.get('view_only'), '1')
  assert.equal(hints.get('fps'), '30')
  assert.equal(view.ticket.startsWith('real-'), false, 'the daemon ticket never goes to the browser')
})

test('Take control grants a control ticket; Give back revokes it and returns to watching', async () => {
  const { control, tickets, open } = harness()
  const { socket } = open()
  await settle()
  const granted = await take(socket)
  assert.equal(tickets.lookup(granted.ticket).mode, 'control')
  assert.equal(control.state().controller, 'user')
  assert.equal(control.state().sessionId, 's-1')
  assert.equal(socket.messages('state').at(-1).mine, true)

  socket.emit('message', JSON.stringify({ type: 'give' }))
  await settle()
  assert.equal(tickets.lookup(granted.ticket), undefined)
  assert.equal(control.state().controller, null)
  assert.equal(control.state().lastReason, 'released')
  assert.equal(socket.messages('view').at(-1).mode, 'watch')
  assert.equal(socket.messages('ended').length, 0, 'asked for, so no notice')
})

test('a dropped status socket keeps the view: resuming restores control and the same tickets', async () => {
  const { control, tickets, open } = harness({ graceMs: 200 })
  const first = open()
  await settle()
  const resume = first.socket.messages('hello')[0].resume
  const granted = await take(first.socket)
  first.socket.drop()
  assert.equal(control.state().controller, 'user', 'a cut connection does not give control back at once')
  assert.notEqual(tickets.lookup(granted.ticket), undefined, 'the stream keeps its ticket')

  const second = open('s-1', resume)
  await settle()
  assert.equal(second.view, first.view)
  assert.deepEqual(second.socket.messages('view').at(-1), granted, 'the same grant comes back, so the viewer is not reloaded')
  assert.equal(second.socket.messages('state').at(-1).mine, true)
  await wait(300)
  assert.equal(control.state().controller, 'user', 'resumed in time: control stays')
  second.socket.emit('message', JSON.stringify({ type: 'give' }))
  await settle()
  assert.equal(control.state().lastReason, 'released')
})

test('a dropped view that does not come back in time gives control back', async () => {
  const { control, tickets, open } = harness({ graceMs: 30 })
  const { socket } = open()
  await settle()
  const granted = await take(socket)
  socket.drop()
  await wait(60)
  assert.equal(control.state().controller, null)
  assert.equal(control.state().lastReason, 'disconnected')
  assert.equal(tickets.lookup(granted.ticket), undefined)
  const late = open('s-1', socket.messages('hello')[0].resume)
  await settle()
  assert.equal(late.socket.messages('view')[0].mode, 'watch', 'too late: a new watching view')
  assert.notEqual(late.socket.messages('hello')[0].resume, socket.messages('hello')[0].resume)
})

test('closing the view on purpose gives control back at once and revokes its tickets', async () => {
  const { control, tickets, open } = harness({ graceMs: 10_000 })
  const { socket } = open()
  await settle()
  await take(socket)
  const all = socket.messages('view').map(message => message.ticket)
  socket.close(1000)
  assert.equal(control.state().controller, null)
  assert.equal(control.state().lastReason, 'disconnected')
  for (const ticket of all) assert.equal(tickets.lookup(ticket), undefined)
})

test('a second view taking control ends the first one\'s control with a notice', async () => {
  const { tickets, open } = harness()
  const first = open('s-1')
  const second = open('s-2')
  await settle()
  const firstGrant = await take(first.socket)
  await take(second.socket)
  assert.equal(tickets.lookup(firstGrant.ticket), undefined)
  assert.deepEqual(first.socket.messages('ended').at(-1), { type: 'ended', reason: 'replaced' })
  assert.equal(first.socket.messages('state').at(-1).mine, false)
  assert.equal(second.socket.messages('state').at(-1).mine, true)
})

test('a repeated Take control from the holder changes nothing', async () => {
  const { open } = harness()
  const { socket } = open()
  await settle()
  await take(socket)
  socket.emit('message', JSON.stringify({ type: 'take' }))
  await settle()
  assert.equal(socket.messages('ended').length, 0)
  assert.equal(socket.messages('view').filter(message => message.mode === 'control').length, 1)
})

test('Give back before the control ticket is ready leaves no control ticket behind', async () => {
  let release
  const slow = new Promise(resolve => { release = resolve })
  const { control, tickets, open } = harness({
    mint: async (options) => {
      if (options.policy === 'allow_activation') await slow
      return { ticket: `real-${options.policy}`, expiresAt: Date.now() + 3_600_000, hints: '' }
    },
  })
  const { socket } = open()
  await settle()
  socket.emit('message', JSON.stringify({ type: 'take' }))
  socket.emit('message', JSON.stringify({ type: 'give' }))
  release()
  await settle()
  await settle()
  assert.equal(control.state().controller, null)
  assert.equal(socket.messages('view').some(message => message.mode === 'control' && tickets.lookup(message.ticket) !== undefined), false)
})

test('a daemon that cannot mint tickets is reported to the view', async () => {
  const { open } = harness({ mint: async () => { throw new Error('down') } })
  const { socket } = open()
  await settle()
  assert.deepEqual(socket.messages('error'), [{ type: 'error', message: 'desktop unavailable' }])
})

test('stopping the plugin closes every view and records why control ended', async () => {
  const { control, views, open } = harness()
  const { socket } = open()
  await settle()
  await take(socket)
  views.closeAll()
  assert.equal(control.state().lastReason, 'stopped')
})

test('control taken in a view opened from the help link is marked as such', async () => {
  const { control, open } = harness()
  const changes = []
  control.subscribe((_state, change) => changes.push(change))
  const { socket } = open('s-1', null, true)
  await settle()
  await take(socket)
  assert.equal(changes.at(-1).help, true)
})
