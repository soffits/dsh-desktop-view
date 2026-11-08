import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avcCodec, parsePacket } from '../viewer/core.js'
import { contentRect, mapKey, modifiers } from '../viewer/input.js'

/** An H.264 Annex B keyframe as captured from cua-spacesd (SPS start). */
const keyframe = Uint8Array.from([
  0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x20, 0x8c, 0x68, 0x05, 0x00, 0x65,
  0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
  0, 0, 0, 1, 0x65, 0x88, 0x84,
])

test('the codec string comes from the stream\'s own SPS', () => {
  assert.equal(avcCodec(keyframe), 'avc1.42c020')
  assert.equal(avcCodec(Uint8Array.from([0, 0, 0, 1, 0x65, 0x88])), undefined, 'no SPS, no codec')
})

test('a video packet is split into its JSON header and payload', () => {
  const header = Buffer.from(JSON.stringify({ direction: 'video', message: { codec: 'h264', keyframe: true } }))
  const payload = Buffer.from([0, 0, 0, 1, 0x65])
  const lengths = Buffer.alloc(8)
  lengths.writeUInt32BE(header.length, 0)
  lengths.writeUInt32BE(payload.length, 4)
  const bytes = Buffer.concat([lengths, header, payload])
  const packet = parsePacket(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))
  assert.equal(packet.header.message.keyframe, true)
  assert.deepEqual(packet.payload, new Uint8Array([0, 0, 0, 1, 0x65]))
})

test('an audio packet and a truncated packet are not video packets', () => {
  assert.equal(parsePacket(Uint8Array.from([0x52, 0x41, 0x55, 0x32, 2, 0, 0, 1]).buffer), undefined)
  assert.equal(parsePacket(new ArrayBuffer(4)), undefined)
  const lengths = Buffer.alloc(8)
  lengths.writeUInt32BE(100, 0)
  lengths.writeUInt32BE(100, 4)
  assert.equal(parsePacket(lengths.buffer), undefined)
})

/** A KeyboardEvent-like object. */
const keyboard = (init) => ({ isComposing: false, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, code: '', getModifierState: () => false, ...init })

test('named keys and function keys are sent as keys, not text', () => {
  const enter = mapKey(keyboard({ key: 'Enter', code: 'Enter' }), 'down')
  assert.deepEqual(enter, { kind: 'key', key: 'enter', state: 'down', modifiers: [], repeat: false })
  const f5 = mapKey(keyboard({ key: 'F5', code: 'F5', shiftKey: true }), 'down')
  assert.deepEqual(f5.modifiers, ['shift'])
})

test('a shortcut letter comes from the physical key, so layouts do not move it', () => {
  const copy = mapKey(keyboard({ key: 'ы', code: 'KeyS', ctrlKey: true }), 'down')
  assert.equal(copy.key, 's')
  assert.deepEqual(copy.modifiers, ['control'])
  const shiftTab = mapKey(keyboard({ key: 'Tab', code: 'Tab', shiftKey: true }), 'down')
  assert.deepEqual(shiftTab.modifiers, ['shift'])
})

test('plain typing is left to the text input, so input methods and dead keys work', () => {
  assert.equal(mapKey(keyboard({ key: 'a', code: 'KeyA' }), 'down'), null)
  assert.equal(mapKey(keyboard({ key: '中', code: 'KeyA' }), 'down'), null)
  assert.equal(mapKey(keyboard({ key: 'Dead', code: 'Quote' }), 'down'), null)
  assert.equal(mapKey(keyboard({ key: 'a', code: 'KeyA', isComposing: true }), 'down'), null)
  assert.equal(mapKey(keyboard({ key: 'a', code: 'KeyA', keyCode: 229 }), 'down'), null)
})

test('modifier keys carry no modifiers of their own', () => {
  const shift = mapKey(keyboard({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), 'down')
  assert.equal(shift.key, 'shift')
  assert.deepEqual(shift.modifiers, [])
})

test('AltGr is text, not a shortcut', () => {
  const event = keyboard({ key: '€', code: 'KeyE', ctrlKey: true, altKey: true, getModifierState: name => name === 'AltGraph' })
  assert.equal(mapKey(event, 'down'), null)
})

test('the modifier snapshot matches the wire names', () => {
  assert.deepEqual(modifiers({ shiftKey: true, ctrlKey: true, altKey: true, metaKey: true }), ['shift', 'control', 'option', 'command'])
  assert.deepEqual(modifiers({}), [])
})

test('pointer positions map onto the picture, not the letterboxed box', () => {
  const box = { left: 0, top: 0, width: 1000, height: 1000 }
  // A 4:3 picture in a square box is 1000x750, centered vertically.
  const rect = contentRect(box, 1280, 800)
  assert.deepEqual(rect, { left: 0, top: 187.5, width: 1000, height: 625 })
  // A square element with no picture yet falls back to the element box.
  assert.deepEqual(contentRect(box, 0, 0), box)
})
