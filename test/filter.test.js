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

test('a watch socket cannot send input, geometry or microphone audio, even from a modified page', () => {
  const result = checkClientMessage(input, false, 'watch', session)
  assert.equal(result.ok, false)
  assert.match(result.reason, /interactive_input.*not allowed on a watch socket/)
  assert.equal(checkClientMessage(JSON.stringify({ type: 'set_window_geometry', payload: {} }), false, 'watch', session).ok, false)
  assert.equal(checkClientMessage(JSON.stringify({ type: 'audio_uplink_state', payload: {} }), false, 'watch', session).ok, false)
  assert.match(checkClientMessage(Buffer.from('RAU2'), true, 'watch', session).reason, /binary/)
})

test('a control socket may send input, window geometry and microphone audio', () => {
  const result = checkClientMessage(input, false, 'control', session)
  assert.equal(result.ok, true)
  assert.equal(result.type, 'interactive_input')
  assert.equal(JSON.parse(result.data).payload.session_id, session)
  assert.equal(checkClientMessage(JSON.stringify({ type: 'set_window_geometry', payload: { session_id: session } }), false, 'control', session).ok, true)
  assert.equal(checkClientMessage(JSON.stringify({ type: 'audio_uplink_state', payload: { track_id: 2, muted: false } }), false, 'control', session).ok, true)
  const audio = checkClientMessage(Buffer.from('RAU2...'), true, 'control', session)
  assert.equal(audio.ok, true)
  assert.equal(audio.binary, true)
})

test('message types the viewer never uses are refused on every socket', () => {
  for (const type of ['action', 'set_stream_preferences', 'get_window_state', 'ticket', 'close_media']) {
    for (const mode of ['watch', 'control']) {
      assert.equal(checkClientMessage(JSON.stringify({ type, payload: {} }), false, mode, session).ok, false, `${type} on ${mode}`)
    }
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
  assert.deepEqual(JSON.parse(result.data), { type: 'ping', payload: { nonce: 5 } })
})

test('malformed and oversized messages are refused with a reason', () => {
  assert.equal(checkClientMessage('not json', false, 'watch', session).ok, false)
  assert.equal(checkClientMessage('[]', false, 'watch', session).ok, false)
  assert.equal(checkClientMessage('null', false, 'watch', session).ok, false)
  assert.equal(checkClientMessage(JSON.stringify({ type: 7 }), false, 'watch', session).ok, false)
  assert.equal(checkClientMessage(JSON.stringify({ type: 'ping', payload: [1] }), false, 'watch', session).ok, false)
  const huge = JSON.stringify({ type: 'ping', payload: { nonce: 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES) } })
  assert.match(checkClientMessage(huge, false, 'watch', session).reason, /too large/)
})
