import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CLOSE, MAX_BUFFERED_BYTES, STATUS_TYPE, relay, videoKeyframe } from '../src/relay.js'
import { createControl } from '../src/control.js'

/** A browser-side WebSocket double. */
class FakeBrowser extends EventEmitter {
  OPEN = 1
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

/** The daemon's media socket double. */
class FakeUpstream extends EventEmitter {
  OPEN = 1
  readyState = 1
  sent = []
  terminated = false
  send(text) { this.sent.push(text) }
  terminate() { this.terminated = true; this.readyState = 3 }
}

/** A video packet: two big-endian lengths, a JSON header, the payload. */
function videoPacket({ keyframe = false, sequence = 1 } = {}) {
  const header = Buffer.from(JSON.stringify({
    direction: 'video',
    message: {
      session_id: 'media-1', sequence, geometry_epoch: 1, codec_epoch: 1,
      width_px: 1280, height_px: 800, capture_timestamp_us: 0, codec: 'h264', keyframe,
    },
  }))
  const payload = Buffer.from([0, 0, 0, 1, 0x65])
  const lengths = Buffer.alloc(8)
  lengths.writeUInt32BE(header.length, 0)
  lengths.writeUInt32BE(payload.length, 4)
  return Buffer.concat([lengths, header, payload])
}

const input = () => JSON.stringify({
  type: 'interactive_input',
  payload: {
    session_id: 'media-1',
    first_sequence: 1,
    events: [{ kind: 'pointer', phase: 'up', button: 'left', x_normalized: 0.5, y_normalized: 0.5, modifiers: [] }],
  },
})

const settle = () => new Promise(resolve => setImmediate(resolve))

function harness({ mode = 'watch', idleMs = 120_000 } = {}) {
  const browser = new FakeBrowser()
  const upstream = new FakeUpstream()
  const opened = []
  const closed = []
  const spacesd = {
    async openMedia(options) {
      opened.push(options)
      return { sessionId: 'media-1', ticket: 't', wsPath: '/media?ticket=t', policy: 1, width: 1280, height: 800 }
    },
    attach() { return upstream },
    async closeMedia(sessionId) { closed.push(sessionId) },
  }
  const control = createControl({ idleMs, persist: async () => {}, setTimer: () => ({ unref() {} }), clearTimer: () => {} })
  const warnings = []
  const relayed = relay({
    browser,
    mode,
    sessionId: 's-1',
    spacesd,
    control,
    media: { display: 'primary', maxFps: 15, maxDimension: 0, bitrateKbps: 0 },
    logger: { warn: (...args) => warnings.push(args), debug: () => {} },
  })
  return { browser, upstream, control, opened, closed, warnings, relayed }
}

test('a watch socket opens a view-only session, gets frames and cannot send input', async () => {
  const { browser, upstream, opened } = harness({ mode: 'watch' })
  await settle()
  assert.equal(opened.length, 1)
  assert.equal(opened[0].policy, 'view_only')
  assert.equal(opened[0].display, 'primary')
  assert.equal(opened[0].maxFps, 15)

  upstream.emit('message', videoPacket({ keyframe: true }), true)
  assert.equal(browser.sent.some(entry => entry.binary), true)

  browser.emit('message', Buffer.from(input()), false)
  assert.deepEqual(upstream.sent, [])

  browser.emit('message', JSON.stringify({ type: 'request_keyframe', payload: { session_id: 'media-1' } }), false)
  assert.equal(upstream.sent.length, 1)
  assert.equal(JSON.parse(upstream.sent[0]).type, 'request_keyframe')
})

test('a control socket opens an input-capable session and forwards input', async () => {
  const { browser, upstream, opened, control } = harness({ mode: 'control' })
  await settle()
  assert.equal(opened[0].policy, 'allow_activation')
  assert.equal(control.state().controller, 'user')

  browser.emit('message', Buffer.from(input()), false)
  assert.equal(upstream.sent.length, 1)
  assert.equal(JSON.parse(upstream.sent[0]).payload.session_id, 'media-1')
})

test('the status message tells the page whether it holds control', async () => {
  const { browser, control } = harness({ mode: 'control' })
  await settle()
  const statuses = browser.sent.filter(entry => entry.binary === false).map(entry => JSON.parse(entry.data))
  assert.equal(statuses.every(entry => entry.type === STATUS_TYPE), true)
  assert.equal(statuses.at(-1).payload.mine, true)
  assert.equal(statuses.at(-1).payload.mode, 'control')
  assert.equal(control.state().controller, 'user')
})

test('closing the control tab gives control back as disconnected', async () => {
  const { browser, control } = harness({ mode: 'control' })
  await settle()
  browser.close(1001)
  assert.equal(control.state().controller, null)
  assert.equal(control.state().lastReason, 'disconnected')
})

test('another control socket replaces this one, which closes with 4100', async () => {
  const { browser, control, upstream } = harness({ mode: 'control' })
  await settle()
  control.take({ id: 'other', sessionId: 's-2', end: () => {} })
  assert.deepEqual(browser.closed, { code: CLOSE.CONTROL_ENDED, reason: 'replaced' })
  assert.equal(upstream.terminated, true)
})

test('a browser far behind on video skips to the next keyframe instead of buffering', async () => {
  const { browser, upstream } = harness()
  await settle()
  upstream.emit('message', videoPacket({ keyframe: true, sequence: 1 }), true)
  browser.bufferedAmount = MAX_BUFFERED_BYTES + 1
  upstream.emit('message', videoPacket({ keyframe: false, sequence: 2 }), true)
  assert.equal(JSON.parse(upstream.sent.at(-1)).type, 'request_keyframe')
  assert.equal(browser.sent.filter(entry => entry.binary).length, 1)
  upstream.emit('message', videoPacket({ keyframe: false, sequence: 3 }), true)
  assert.equal(browser.sent.filter(entry => entry.binary).length, 1, 'dependent frames stay dropped')
  upstream.emit('message', videoPacket({ keyframe: true, sequence: 4 }), true)
  assert.equal(browser.sent.filter(entry => entry.binary).length, 2, 'forwarding resumes at the keyframe')
})

test('closing the relay closes the daemon media session', async () => {
  const { relayed, closed } = harness()
  await settle()
  relayed.close(1000, 'done')
  await settle()
  assert.deepEqual(closed, ['media-1'])
})

test('the daemon closing the socket passes its own code to the browser', async () => {
  const { browser, upstream } = harness()
  await settle()
  upstream.emit('close', 4401, Buffer.from('ticket'))
  assert.equal(browser.closed.code, 4401)
})

test('a failing daemon call closes the browser instead of leaving it blank', async () => {
  const browser = new FakeBrowser()
  const warnings = []
  relay({
    browser,
    mode: 'watch',
    sessionId: null,
    spacesd: { async openMedia() { throw new Error('no display') }, attach() {}, async closeMedia() {} },
    control: createControl({ idleMs: 1000, persist: async () => {} }),
    media: { display: 'primary', maxFps: 15, maxDimension: 0, bitrateKbps: 0 },
    logger: { warn: (...args) => warnings.push(args), debug: () => {} },
  })
  await settle()
  assert.equal(browser.closed.code, CLOSE.UPSTREAM_FAILED)
  assert.match(warnings[0][0], /could not open the desktop stream/)
})

test('a keyframe is read from the video header, not guessed from the bytes', () => {
  assert.equal(videoKeyframe(videoPacket({ keyframe: true })), true)
  assert.equal(videoKeyframe(videoPacket({ keyframe: false })), false)
  assert.equal(videoKeyframe(Buffer.from([0x52, 0x41, 0x55, 0x32])), undefined, 'audio packets are not video')
  assert.equal(videoKeyframe(Buffer.alloc(4)), undefined)
  assert.equal(videoKeyframe(Buffer.concat([Buffer.alloc(8), Buffer.from('not json')])), undefined)
})
