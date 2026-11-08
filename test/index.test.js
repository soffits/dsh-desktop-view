import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'
import { MEDIA_PATH, PREFIX, STATUS_PATH } from '../src/http.js'

/** A Host context double: only what apply() uses. */
function host({ admission = { peer: { principal: { kind: 'owner' } } } } = {}) {
  const routes = []
  const upgrades = []
  const disposers = []
  const ctx = {
    logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
    effect(fn) { disposers.push(fn()) },
    webServer: {
      register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) },
      registerUpgrade(route) { upgrades.push(route); return () => upgrades.splice(upgrades.indexOf(route), 1) },
    },
    connection: { admit: () => admission },
    get: () => undefined,
  }
  return { ctx, routes, upgrades, disposers }
}

const config = () => Config({ stateFile: '/tmp/dsh-desktop-view-test/control.json' })

test('the plugin registers one prefix route and its two sockets', () => {
  const { ctx, routes, upgrades } = host()
  apply(ctx, config())
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, PREFIX)
  assert.deepEqual(upgrades.map(route => route.path).sort(), [MEDIA_PATH, STATUS_PATH].sort())
})

test('unloading the plugin removes its routes again', async () => {
  const { ctx, routes, upgrades, disposers } = host()
  apply(ctx, config())
  await disposers[0]()
  assert.equal(routes.length, 0)
  assert.equal(upgrades.length, 0)
})

test('both sockets refuse anyone the connection does not admit', () => {
  const { ctx, upgrades } = host({ admission: { rejection: 401 } })
  apply(ctx, config())
  for (const route of upgrades) {
    const written = []
    route.handler({ url: route.path, headers: {} }, { end: text => written.push(text), destroy() {} }, Buffer.alloc(0))
    assert.match(written[0], /401 Unauthorized/, route.path)
  }
})

test('the media socket refuses a media ticket no relay ticket opened', () => {
  const { ctx, upgrades } = host()
  apply(ctx, config())
  const media = upgrades.find(route => route.path === MEDIA_PATH)
  const written = []
  media.handler({ url: `${MEDIA_PATH}?ticket=forged`, headers: {} }, { end: text => written.push(text), destroy() {} }, Buffer.alloc(0))
  assert.match(written[0], /401 Unauthorized/)
  const missing = []
  media.handler({ url: MEDIA_PATH, headers: {} }, { end: text => missing.push(text), destroy() {} }, Buffer.alloc(0))
  assert.match(missing[0], /401 Unauthorized/)
})

test('the config has defaults that fit the Cua container image', () => {
  const defaults = Config({})
  assert.equal(defaults.endpoint, 'http://127.0.0.1:3211')
  assert.equal(defaults.tokenFile, '/run/cua/env-token')
  assert.equal(defaults.maxFps, 30)
  assert.equal(defaults.clipboard, true)
  assert.equal(defaults.filesRoot, '~')
  assert.equal(defaults.microphone, true)
  assert.equal(defaults.idleSeconds, 120)
  assert.equal(defaults.notifyAgent, 'wake')
  assert.match(defaults.stateFile, /dsh-desktop-view\/control\.json$/)
})

test('the config rejects values the daemon would refuse', () => {
  assert.throws(() => Config({ maxFps: 0 }))
  assert.throws(() => Config({ maxFps: 90 }))
  assert.throws(() => Config({ idleSeconds: 1 }))
  assert.throws(() => Config({ notifyAgent: 'shout' }))
})
