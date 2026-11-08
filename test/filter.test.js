import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED_TYPES, MAX_CLIENT_MESSAGE_BYTES, checkClientMessage } from '../src/filter.js'

const session = 'media-1-abc'
const input = JSON.stringify({
  type: 'interactive_input',
  payload: { session_id: session, first_sequence: 1, events: [{ kind: 'pointer', phase: 'down', button: 'left', x_normalized: 0.5, y_normalized: 0.5, modifiers: [] }] },
})

test('a watch socket may ask for keyframes, stats, acks and pings only', () => {
  assert.deepEqual(ALLOWED_TYPES.watch, ['request_keyframe', 'get_stats', 'frame_ack', 'ping'])
  for (const type of ALLOWED_TYPES.watch) {
    const message = checkClientMessage(JSON.stringify({ type, payload: { session_id: session } }), false, 'watch', session)
    assert.equal(message.ok, true, type)
  }
})

test('a watch socket cannot send input even when the client is modified', () => {
  const result = checkClientMessage(input, false, 'watch', session)
  assert.equal(result.ok, false)
  assert.match(result.reason, /interactive_input.*not allowed on a watch socket/)
})

test('a control socket may send input', () => {
  const result = checkClientMessage(input, false, 'control', session)
  assert.equal(result.ok, true)
  assert.equal(result.type, 'interactive_input')
  assert.deepEqual(JSON.parse(result.text).payload.session_id, session)
})

test('message types the viewer never uses are refused on every socket', () => {
  for (const type of ['action', 'set_window_geometry', 'set_stream_preferences', 'audio_uplink_state', 'close_media', 'get_window_state']) {
    const result = checkClientMessage(JSON.stringify({ type, payload: {} }), false, 'control', session)
    assert.equal(result.ok, false, type)
  }
})

test('messages for another media session are refused', () => {
  const result = checkClientMessage(input.replace(session, 'media-2-other'), false, 'control', session)
  assert.equal(result.ok, false)
  assert.match(result.reason, /another media session/)
})

test('only the envelope fields are forwarded, so nothing unchecked rides along', () => {
  const result = checkClientMessage(JSON.stringify({ type: 'ping', payload: { nonce: 5 }, extra: 'x' }), false, 'watch', session)
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(result.text), { type: 'ping', payload: { nonce: 5 } })
})

test('malformed, oversized and binary messages are refused with a reason', () => {
  assert.equal(checkClientMessage('not json', false, 'watch', session).ok, false)
  assert.equal(checkClientMessage('[]', false, 'watch', session).ok, false)
  assert.equal(checkClientMessage('null', false, 'watch', session).ok, false)
  assert.equal(checkClientMessage(JSON.stringify({ type: 'not-a-string' }), false, 'watch', session).ok, false)
  assert.equal(checkClientMessage(JSON.stringify({ type: 'ping', payload: [1] }), false, 'watch', session).ok, false)
  const huge = JSON.stringify({ type: 'ping', payload: { nonce: 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES) } })
  assert.match(checkClientMessage(huge, false, 'watch', session).reason, /too large/)
  assert.match(checkClientMessage(Buffer.from([0, 0, 0, 1]), true, 'control', session).reason, /binary/)
})
