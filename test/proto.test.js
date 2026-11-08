import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeMessage, encodeMessage, grpcWebFrame, message, number, parseGrpcWebResponse, text,
} from '../src/proto.js'

test('encodeMessage writes varints and length-delimited fields, skipping defaults', () => {
  const bytes = encodeMessage([
    [1, 'string', 'primary'],
    [2, 'varint', 15],
    [3, 'varint', 0],
    [4, 'string', ''],
    [5, 'message', encodeMessage([[1, 'varint', 30]])],
  ])
  const fields = decodeMessage(bytes)
  assert.equal(text(fields, 1), 'primary')
  assert.equal(number(fields, 2), 15)
  assert.equal(fields.has(3), false)
  assert.equal(fields.has(4), false)
  assert.equal(number(message(fields, 5), 1), 30)
})

test('decodeMessage keeps repeated fields in order and reads big varints', () => {
  const fields = decodeMessage(encodeMessage([
    [2, 'varint', 1], [2, 'varint', 3], [6, 'varint', 2 ** 40], [1, 'string', 'x'],
  ]))
  assert.deepEqual(fields.get(2), [1, 3])
  assert.equal(number(fields, 6), 2 ** 40)
  assert.equal(Buffer.isBuffer(fields.get(1)[0]), true)
})

test('decodeMessage rejects a truncated message instead of guessing', () => {
  const bytes = encodeMessage([[1, 'string', 'abcdef']])
  assert.throws(() => decodeMessage(bytes.subarray(0, bytes.length - 2)), /truncated/)
})

test('grpcWebFrame frames one message with the length prefix', () => {
  const body = Buffer.from([1, 2, 3])
  const framed = grpcWebFrame(body)
  assert.equal(framed.length, 8)
  assert.equal(framed.readUInt32BE(1), 3)
  assert.deepEqual(framed.subarray(5), body)
})

test('parseGrpcWebResponse reads the message and the trailer status', () => {
  const status = Buffer.from('grpc-status:0\r\ngrpc-message:\r\n')
  const trailer = Buffer.concat([Buffer.from([0x80, 0, 0, 0, status.length]), status])
  const body = Buffer.concat([grpcWebFrame(Buffer.from([7, 7])), trailer])
  const parsed = parseGrpcWebResponse(body, new Headers())
  assert.equal(parsed.status, 0)
  assert.deepEqual(parsed.message, Buffer.from([7, 7]))
})

test('parseGrpcWebResponse falls back to headers for a trailers-only failure', () => {
  const headers = new Headers({ 'grpc-status': '13', 'grpc-message': 'boom%20here' })
  const parsed = parseGrpcWebResponse(Buffer.alloc(0), headers)
  assert.equal(parsed.status, 13)
  assert.equal(parsed.statusMessage, 'boom here')
  assert.equal(parsed.message, undefined)
})

test('parseGrpcWebResponse keeps a malformed status message verbatim', () => {
  const parsed = parseGrpcWebResponse(Buffer.alloc(0), new Headers({ 'grpc-status': '2', 'grpc-message': '100%' }))
  assert.equal(parsed.statusMessage, '100%')
})
