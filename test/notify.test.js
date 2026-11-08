import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTIFY_MODES, SOURCE_KIND, createNotifier, noticeText } from '../src/notify.js'

const text = noticeText({ kind: 'taken' }, '/tmp/control.json')
const file = '/tmp/control.json'

test('taking control tells the agent to keep off the desktop and where to look', () => {
  assert.match(text, /took control/)
  assert.match(text, new RegExp(file.replace(/[/.]/g, '\\$&')))
  assert.match(text, /Do not use the mouse, keyboard or browser/)
})

test('giving control back says why and that the agent may act again', () => {
  assert.match(noticeText({ kind: 'released', reason: 'released', heldMs: 90_000 }, file), /gave control back after about 2 min/)
  assert.match(noticeText({ kind: 'released', reason: 'idle', heldMs: 130_000 }, file), /idle timeout/)
  assert.match(noticeText({ kind: 'released', reason: 'disconnected', heldMs: 0 }, file), /closed the live view/)
  assert.match(noticeText({ kind: 'released', reason: 'stopped', heldMs: 0 }, file), /plugin stopped/)
  for (const reason of ['released', 'idle', 'disconnected', 'stopped']) {
    assert.match(noticeText({ kind: 'released', reason, heldMs: 0 }, file), /You may use the desktop again/, reason)
  }
})

/** A Host context double whose session resolves to a fake agent. */
function host({ agent } = {}) {
  const calls = []
  const live = agent === undefined ? new Map() : new Map([['s-1', agent]])
  const ctx = {
    get: name => {
      if (name === 'agents') return { get: id => live.get(id), withoutInitiator: operation => operation() }
      if (name === 'sessionController') return { async resolveAgent() { return agent === undefined ? { error: new Error('gone') } : { agent } } }
      return undefined
    },
  }
  return { ctx, calls }
}

const agentDouble = (calls) => ({
  inject: message => calls.push({ how: 'inject', message }),
  steer: message => calls.push({ how: 'steer', message }),
})

test('taking control is noted for the next step without waking the agent', async () => {
  const calls = []
  const { ctx } = host({ agent: agentDouble(calls) })
  await createNotifier({ ctx, mode: 'wake', stateFile: file, logger: console }).call(
    undefined, { controller: 'user' }, { kind: 'taken', sessionId: 's-1' },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].how, 'inject')
  assert.equal(calls[0].message.role, 'user')
  assert.equal(calls[0].message.source.kind, SOURCE_KIND)
  assert.equal(calls[0].message.source.form, 'notice')
})

test('giving control back steers a running agent and wakes an idle one', async () => {
  const calls = []
  const { ctx } = host({ agent: agentDouble(calls) })
  const notify = createNotifier({ ctx, mode: 'wake', stateFile: file, logger: console })
  await notify({ controller: null }, { kind: 'released', reason: 'idle', sessionId: 's-1', heldMs: 1000 })
  assert.equal(calls[0].how, 'steer')
})

test('quiet mode queues the hand-back note instead of waking the agent', async () => {
  const calls = []
  const { ctx } = host({ agent: agentDouble(calls) })
  await createNotifier({ ctx, mode: 'quiet', stateFile: file, logger: console })({ controller: null }, { kind: 'released', reason: 'released', sessionId: 's-1' })
  assert.equal(calls[0].how, 'inject')
})

test('off mode and views without a session send nothing', async () => {
  const calls = []
  const { ctx } = host({ agent: agentDouble(calls) })
  await createNotifier({ ctx, mode: 'off', stateFile: file, logger: console })({ controller: 'user' }, { kind: 'taken', sessionId: 's-1' })
  await createNotifier({ ctx, mode: 'wake', stateFile: file, logger: console })({ controller: 'user' }, { kind: 'taken', sessionId: null })
  assert.deepEqual(calls, [])
})

test('another view taking over is not reported as a hand-back', async () => {
  const calls = []
  const { ctx } = host({ agent: agentDouble(calls) })
  await createNotifier({ ctx, mode: 'wake', stateFile: file, logger: console })({ controller: 'user' }, { kind: 'released', reason: 'replaced', sessionId: 's-1' })
  assert.deepEqual(calls, [])
})

test('a session that cannot be resumed is a warning, never a crash', async () => {
  const warnings = []
  const { ctx } = host()
  await createNotifier({ ctx, mode: 'wake', stateFile: file, logger: { warn: (...args) => warnings.push(args) } })({ controller: null }, { kind: 'released', reason: 'idle', sessionId: 's-1' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /could not tell session/)
})

test('the three notification modes are the configuration values', () => {
  assert.deepEqual([...NOTIFY_MODES], ['wake', 'quiet', 'off'])
})
