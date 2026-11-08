import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELEASE_REASONS, createControl, fileWriter } from '../src/control.js'

/** A control store with a manual clock and timers. */
function harness({ idleMs = 120_000 } = {}) {
  let now = Date.UTC(2026, 10, 8, 12, 0, 0)
  const timers = []
  const states = []
  const changes = []
  const control = createControl({
    idleMs,
    persist: async state => { states.push(state) },
    now: () => now,
    setTimer: (callback, delay) => { const timer = { callback, at: now + delay, cleared: false }; timers.push(timer); return timer },
    clearTimer: timer => { timer.cleared = true },
  })
  control.subscribe((state, change) => changes.push({ state, change }))
  return {
    control,
    states,
    changes,
    advance(ms) {
      now += ms
      for (const timer of timers) {
        if (!timer.cleared && timer.at <= now) { timer.cleared = true; timer.callback() }
      }
    },
  }
}

test('control starts free and records who took it', async () => {
  const { control, states, changes } = harness()
  assert.equal(control.state().controller, null)
  assert.equal(control.holds('a'), false)
  control.take({ id: 'a', sessionId: 's-1', end: () => {} })
  assert.equal(control.holds('a'), true)
  assert.equal(control.state().controller, 'user')
  assert.equal(control.state().sessionId, 's-1')
  assert.equal(changes.at(-1).change.kind, 'taken')
  await control.flush()
  assert.equal(states.at(-1).controller, 'user')
})

test('giving control back ends it once and records the reason', () => {
  const { control, changes } = harness()
  const ends = []
  control.take({ id: 'a', sessionId: 's-1', end: reason => ends.push(reason) })
  assert.equal(control.release('a', 'released'), true)
  assert.equal(control.release('a', 'released'), false)
  assert.deepEqual(ends, ['released'])
  assert.equal(control.state().controller, null)
  assert.equal(control.state().lastReason, 'released')
  assert.equal(changes.at(-1).change.kind, 'released')
})

test('control returns to watching after the idle period, and input restarts it', () => {
  const { control, advance } = harness({ idleMs: 1000 })
  const ends = []
  control.take({ id: 'a', sessionId: 's-1', end: reason => ends.push(reason) })
  advance(900)
  control.touch('a')
  advance(900)
  assert.equal(control.holds('a'), true)
  advance(200)
  assert.equal(control.holds('a'), false)
  assert.deepEqual(ends, ['idle'])
  assert.equal(control.state().lastReason, 'idle')
})

test('input from another socket does not keep control alive', () => {
  const { control, advance } = harness({ idleMs: 1000 })
  control.take({ id: 'a', sessionId: null, end: () => {} })
  advance(800)
  control.touch('b')
  advance(300)
  assert.equal(control.holds('a'), false)
})

test('a newer control socket replaces the older one, which is closed with a reason', () => {
  const { control, changes } = harness()
  const ends = []
  control.take({ id: 'a', sessionId: 's-1', end: reason => ends.push(`a:${reason}`) })
  control.take({ id: 'b', sessionId: 's-2', end: reason => ends.push(`b:${reason}`) })
  assert.deepEqual(ends, ['a:replaced'])
  assert.equal(control.holds('a'), false)
  assert.equal(control.holds('b'), true)
  assert.equal(changes.filter(entry => entry.change.kind === 'released').at(-1).change.reason, 'replaced')
})

test('every release reason the relay uses is one the control store knows', () => {
  assert.deepEqual([...RELEASE_REASONS], ['released', 'idle', 'disconnected', 'replaced', 'stopped'])
})

test('the state file is written atomically with owner-only permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-view-test-'))
  const path = join(dir, 'nested', 'control.json')
  const write = fileWriter(path)
  await write({ controller: 'user', since: '2026-11-08T12:00:00.000Z', sessionId: 's-1', updatedAt: '2026-11-08T12:00:00.000Z' })
  const state = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(state.controller, 'user')
  const mode = (await stat(path)).mode & 0o777
  assert.equal(mode, 0o600)
  await write({ controller: null, since: null, sessionId: null, updatedAt: '2026-11-08T12:01:00.000Z', lastReason: 'idle' })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).lastReason, 'idle')
})

test('flush waits for queued writes so the file matches the state', async () => {
  const written = []
  const control = createControl({ idleMs: 1000, persist: async state => { written.push(state.controller) } })
  control.take({ id: 'a', sessionId: null, end: () => {} })
  await control.flush()
  assert.deepEqual(written, ['user', 'user'])
})
