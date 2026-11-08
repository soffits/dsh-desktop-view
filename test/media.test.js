import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CLOSE, MAX_BUFFERED_BYTES, mediaTicketOf, pipeMedia, videoKeyframe } from '../src/media.js'

/** A browser-side WebSocket double. */
class FakeBrowser extends EventEmitter {
  OPEN = 1
  CONNECTING = 0
  readyState = 1
  bufferedAmount = 0
  sent = []
  closed = null
  send(data, options) { this.sent.push({ data, binary: options?.binary === true }) }
  close(code = 1000, reason = '') {
    this.closed = { code, reason }
    this.readyState = 3
    this.emit('close', code, Buffer.from(reason))
  }
}

/** The daemon's media socket double, already open. */
class FakeUpstream extends EventEmitter {
  readyState = 1
  sent = []
  terminated = false
  send(data, options) { this.sent.push({ data, binary: options?.binary === true }) }
  terminate() { this.terminated = true; this.readyState = 3 }
}

/** A video packet: two big-endian lengths, a JSON header, the payload. */
function videoPacket({ keyframe = false, sequence = 1 } = {}) {
  const header = Buffer.from(JSON.stringify({ direction: 'video', message: { session_id: 'media-1', sequence, codec: 'h264', keyframe } }))
  const payload = Buffer.from([0, 0, 0, 1, 0x65])
  const lengths = Buffer.alloc(8)
  lengths.writeUInt32BE(header.length, 0)
  lengths.writeUInt32BE(payload.length, 4)
  return Buffer.concat([lengths, header, payload])
}

const input = JSON.stringify({
  type: 'interactive_input',
  payload: { session_id: 'media-1', first_sequence: 1, events: [{ kind: 'key', key: 'shift', state: 'down', modifiers: [], repeat: false }] },
})

function harness(mode) {
  const browser = new FakeBrowser()
  const upstream = new FakeUpstream()
  const inputs = []
  const piped = pipeMedia({
    browser, mode, sessionId: 'media-1',
    onInput: () => inputs.push(Date.now()),
    connect: () => upstream,
    logger: { warn() {}, debug() {} },
  })
  return { browser, upstream, inputs, piped }
}

test('the media ticket comes from the query or the ticket subprotocol', () => {
  assert.equal(mediaTicketOf('/desktop-view/d/media?ticket=abc', 'rcdp.v2'), 'abc')
  assert.equal(mediaTicketOf('/desktop-view/d/media', 'rcdp.v2, cua.ticket.xyz'), 'xyz')
  assert.equal(mediaTicketOf('/desktop-view/d/media', 'rcdp.v2'), undefined)
})

test('a watch socket forwards video down and drops input and microphone audio up', () => {
  const { browser, upstream, inputs } = harness('watch')
  upstream.emit('message', videoPacket({ keyframe: true }), true)
  assert.equal(browser.sent.filter(entry => entry.binary).length, 1)
  browser.emit('message', Buffer.from(input), false)
  browser.emit('message', Buffer.from('RAU2audio'), true)
  assert.deepEqual(upstream.sent, [])
  assert.deepEqual(inputs, [])
  browser.emit('message', JSON.stringify({ type: 'frame_ack', payload: { session_id: 'media-1', sequence: 1 } }), false)
  assert.equal(upstream.sent.length, 1)
})

test('a control socket forwards input and microphone audio, and input counts as activity', () => {
  const { browser, upstream, inputs } = harness('control')
  browser.emit('message', Buffer.from(input), false)
  browser.emit('message', Buffer.from('RAU2audio'), true)
  assert.equal(upstream.sent.length, 2)
  assert.equal(JSON.parse(upstream.sent[0].data).type, 'interactive_input')
  assert.equal(upstream.sent[1].binary, true)
  assert.equal(inputs.length, 1)
})

test('a browser far behind on video skips to the next keyframe instead of buffering', () => {
  const { browser, upstream } = harness('watch')
  upstream.emit('message', videoPacket({ keyframe: true, sequence: 1 }), true)
  browser.bufferedAmount = MAX_BUFFERED_BYTES + 1
  upstream.emit('message', videoPacket({ sequence: 2 }), true)
  assert.equal(JSON.parse(upstream.sent.at(-1).data).type, 'request_keyframe')
  upstream.emit('message', videoPacket({ sequence: 3 }), true)
  assert.equal(browser.sent.filter(entry => entry.binary).length, 1, 'dependent frames stay dropped')
  upstream.emit('message', videoPacket({ keyframe: true, sequence: 4 }), true)
  assert.equal(browser.sent.filter(entry => entry.binary).length, 2, 'forwarding resumes at the keyframe')
})

test('audio packets are not video and pass straight down', () => {
  const { browser, upstream } = harness('watch')
  browser.bufferedAmount = MAX_BUFFERED_BYTES + 1
  upstream.emit('message', Buffer.from('RAU2-opus-frame'), true)
  assert.equal(browser.sent.length, 1)
})

test('the daemon closing passes its code down; closing the pipe ends both sides', () => {
  const first = harness('watch')
  first.upstream.emit('close', 4404, Buffer.from('closed'))
  assert.equal(first.browser.closed.code, 4404)
  const second = harness('control')
  second.piped.close(CLOSE.CONTROL_ENDED, 'control ended')
  assert.deepEqual(second.browser.closed, { code: CLOSE.CONTROL_ENDED, reason: 'control ended' })
  assert.equal(second.upstream.terminated, true)
})

test('a keyframe is read from the video header, not guessed from the bytes', () => {
  assert.equal(videoKeyframe(videoPacket({ keyframe: true })), true)
  assert.equal(videoKeyframe(videoPacket({ keyframe: false })), false)
  assert.equal(videoKeyframe(Buffer.from([0x52, 0x41, 0x55, 0x32])), undefined)
  assert.equal(videoKeyframe(Buffer.alloc(4)), undefined)
  assert.equal(videoKeyframe(Buffer.concat([Buffer.alloc(8), Buffer.from('not json')])), undefined)
})
