import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTIFY_MODES, SOURCE_KIND, createNotifier, noticeSummary, noticeText, shouldWake } from '../src/notify.js'

const file = '/tmp/control.json'

test('the notes are short and say what to do', () => {
  const taken = noticeText({ kind: 'taken' }, file)
  assert.match(taken, /took control/)
  assert.match(taken, /\/tmp\/control\.json/)
  assert.ok(taken.length < 160, taken)
  for (const reason of ['released', 'idle', 'disconnected', 'stopped', 'unknown']) {
    const text = noticeText({ kind: 'released', reason }, file)
    assert.match(text, /You may use the desktop again/, reason)
    assert.ok(text.length < 130, text)
  }
  assert.match(noticeText({ kind: 'released', reason: 'idle' }, file), /idle timeout/)
  assert.equal(noticeSummary({ kind: 'taken' }), 'Owner took control')
  assert.equal(noticeSummary({ kind: 'released' }), 'Owner gave control back')
})

test('taking control never wakes; giving it back wakes only a running agent or one that asked for help (OWNER-4)', () => {
  const idle = { status: 'idle' }
  const running = { status: 'running' }
  assert.equal(shouldWake({ kind: 'taken', help: true }, 'wake', running), false)
  assert.equal(shouldWake({ kind: 'released' }, 'wake', idle), false, 'an idle agent that did not ask is not woken')
  assert.equal(shouldWake({ kind: 'released' }, 'wake', undefined), false)
  assert.equal(shouldWake({ kind: 'released' }, 'wake', running), true)
  assert.equal(shouldWake({ kind: 'released', help: true }, 'wake', idle), true, 'it sent the help link, so it is waiting')
  assert.equal(shouldWake({ kind: 'released', help: true }, 'quiet', idle), false)
})

/** A Host context double whose session resolves to a fake agent. */
function host({ agent, live = true } = {}) {
  const resolved = []
  const ctx = {
    get: (name) => {
      if (name === 'agents') return { get: id => (live && id === 's-1' ? agent : undefined), withoutInitiator: operation => operation() }
      if (name === 'sessionController') {
        return { async resolveAgent(id) { resolved.push(id); return agent === undefined ? { error: new Error('gone') } : { agent } } }
      }
      return undefined
    },
  }
  return { ctx, resolved }
}

const agentDouble = (calls, status = 'idle') => ({
  status,
  inject: message => calls.push({ how: 'inject', message }),
  steer: message => calls.push({ how: 'steer', message }),
})

const notify = (ctx, mode = 'wake', logger = console) => createNotifier({ ctx, mode, stateFile: file, logger })

test('taking control is queued for the next step, with the plugin\'s own source', async () => {
  const calls = []
  await notify(host({ agent: agentDouble(calls, 'running') }).ctx)({}, { kind: 'taken', sessionId: 's-1', help: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].how, 'inject')
  assert.equal(calls[0].message.role, 'user')
  assert.deepEqual(calls[0].message.source, { kind: SOURCE_KIND, form: 'notice', summary: 'Owner took control', change: 'taken' })
})

test('giving control back to an idle agent that did not ask is queued quietly', async () => {
  const calls = []
  await notify(host({ agent: agentDouble(calls, 'idle') }).ctx)({}, { kind: 'released', reason: 'released', sessionId: 's-1', help: false })
  assert.deepEqual(calls.map(call => call.how), ['inject'])
})

test('giving control back steers a running agent', async () => {
  const calls = []
  await notify(host({ agent: agentDouble(calls, 'running') }).ctx)({}, { kind: 'released', reason: 'idle', sessionId: 's-1' })
  assert.deepEqual(calls.map(call => call.how), ['steer'])
})

test('a help link wakes the agent, resuming its session if it is not live', async () => {
  const calls = []
  const { ctx, resolved } = host({ agent: agentDouble(calls, 'idle'), live: false })
  await notify(ctx)({}, { kind: 'released', reason: 'released', sessionId: 's-1', help: true })
  assert.deepEqual(resolved, ['s-1'])
  assert.deepEqual(calls.map(call => call.how), ['steer'])
})

test('a quiet note for a session that is not live is dropped, not resumed', async () => {
  const calls = []
  const { ctx, resolved } = host({ agent: agentDouble(calls), live: false })
  await notify(ctx)({}, { kind: 'released', reason: 'released', sessionId: 's-1' })
  assert.deepEqual(resolved, [])
  assert.deepEqual(calls, [])
})

test('off mode, views without a session and a takeover by another view send nothing', async () => {
  const calls = []
  const { ctx } = host({ agent: agentDouble(calls, 'running') })
  await notify(ctx, 'off')({}, { kind: 'taken', sessionId: 's-1' })
  await notify(ctx)({}, { kind: 'taken', sessionId: null })
  await notify(ctx)({}, { kind: 'released', reason: 'replaced', sessionId: 's-1' })
  assert.deepEqual(calls, [])
})

test('a session that cannot be resumed is a warning, never a crash', async () => {
  const warnings = []
  const { ctx } = host({ live: false })
  await notify(ctx, 'wake', { warn: (...args) => warnings.push(args) })({}, { kind: 'released', reason: 'idle', sessionId: 's-1', help: true })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /could not tell session/)
})

test('the three notification modes are the configuration values', () => {
  assert.deepEqual([...NOTIFY_MODES], ['wake', 'quiet', 'off'])
})
