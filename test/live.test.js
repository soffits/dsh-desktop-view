/**
 * The one check that needs the real daemon: a watch connection gets frames,
 * and neither the relay nor cua-spacesd lets it send input. It runs only on
 * a machine that has cua-spacesd and its token file (CI has neither) and
 * keeps one low-rate stream open for a few seconds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createSpacesd } from '../src/spacesd.js'
import { createControl } from '../src/control.js'
import { relay, videoKeyframe } from '../src/relay.js'

const TOKEN_FILE = process.env.CUA_ENV_TOKEN_FILE ?? '/run/cua/env-token'
const ENDPOINT = process.env.CUA_ENV_URL ?? 'http://127.0.0.1:3211'

async function available() {
  if (!existsSync(TOKEN_FILE)) return 'no cua-spacesd token file on this machine'
  const spacesd = createSpacesd({ endpoint: ENDPOINT, tokenFile: TOKEN_FILE })
  try {
    const opened = await spacesd.openMedia({ display: 'primary', policy: 'view_only', maxFps: 5, maxDimension: 640, bitrateKbps: 500, ticketTtlSeconds: 15 })
    await spacesd.closeMedia(opened.sessionId)
    return false
  } catch (error) {
    return `cua-spacesd is not usable here: ${error.message}`
  }
}

const skip = await available()

test('a watch connection gets real frames and cannot send input', { skip }, async () => {
  const spacesd = createSpacesd({ endpoint: ENDPOINT, tokenFile: TOKEN_FILE })
  const browser = new (class extends EventEmitter {
    OPEN = 1
    readyState = 1
    bufferedAmount = 0
    frames = []
    sent = []
    send(data, options) { this.sent.push({ data, binary: options?.binary === true }) }
    close(code = 1000, reason = '') { this.readyState = 3; this.emit('close', code, Buffer.from(reason)) }
  })()
  const control = createControl({ idleMs: 60_000, persist: async () => {} })
  const relayed = relay({
    browser,
    mode: 'watch',
    sessionId: null,
    spacesd,
    control,
    media: { display: 'primary', maxFps: 5, maxDimension: 640, bitrateKbps: 500 },
    logger: { warn() {}, debug() {} },
  })
  try {
    const firstFrame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame within 8 s')), 8000)
      const poll = setInterval(() => {
        const video = browser.sent.find(entry => entry.binary && videoKeyframe(entry.data) !== undefined)
        if (video !== undefined) { clearTimeout(timer); clearInterval(poll); resolve(video) }
      }, 50)
    })
    assert.equal(videoKeyframe(firstFrame.data), true, 'the stream starts with a keyframe')

    // The browser tries to click; the relay refuses to forward it.
    browser.emit('message', Buffer.from(JSON.stringify({
      type: 'interactive_input',
      payload: { session_id: 'media-1', first_sequence: 1, events: [{ kind: 'pointer', phase: 'up', button: 'left', x_normalized: 0.5, y_normalized: 0.5, modifiers: [] }] },
    })), false)
    assert.equal(browser.sent.some(entry => !entry.binary && /interactive_input/.test(entry.data)), false)

    // And the daemon refuses input on a view-only session even when it is
    // sent straight to the media socket, so the rule holds server-side.
    const opened = await spacesd.openMedia({ display: 'primary', policy: 'view_only', maxFps: 5, maxDimension: 640, bitrateKbps: 500, ticketTtlSeconds: 15 })
    const socket = spacesd.attach(opened)
    try {
      const acknowledgement = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no acknowledgement within 8 s')), 8000)
        socket.on('message', (data, binary) => {
          if (binary) return
          const message = JSON.parse(data.toString())
          if (message.type === 'interactive_input_acknowledgement') { clearTimeout(timer); resolve(message.payload) }
        })
        socket.on('open', () => {
          socket.send(JSON.stringify({
            type: 'interactive_input',
            payload: { session_id: opened.sessionId, first_sequence: 1, events: [{ kind: 'pointer', phase: 'move', button: null, x_normalized: 0.5, y_normalized: 0.5, modifiers: [] }] },
          }))
        })
      })
      assert.equal(acknowledgement.delivered, false)
      assert.equal(acknowledgement.error.code, 'view_only')
    } finally {
      socket.terminate()
      await spacesd.closeMedia(opened.sessionId)
    }
  } finally {
    relayed.close(1000, 'done')
  }
})
