import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'
import { MEDIA_PATH, PREFIX } from '../src/http.js'

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

test('the plugin registers the page and the media upgrade under one prefix', () => {
  const { ctx, routes, upgrades } = host()
  apply(ctx, Config({}))
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, PREFIX)
  assert.equal(upgrades.length, 1)
  assert.equal(upgrades[0].path, MEDIA_PATH)
})

test('unloading the plugin removes its routes again', async () => {
  const { ctx, routes, upgrades, disposers } = host()
  apply(ctx, Config({}))
  assert.equal(disposers.length, 1)
  await disposers[0]()
  assert.equal(routes.length, 0)
  assert.equal(upgrades.length, 0)
})

test('the media upgrade refuses anyone the connection does not admit', () => {
  const { ctx, upgrades } = host({ admission: { rejection: 401 } })
  apply(ctx, Config({}))
  const written = []
  upgrades[0].handler({ url: '/desktop-view/media', headers: {} }, { end: text => written.push(text), destroy() {} }, Buffer.alloc(0))
  assert.match(written[0], /401 Unauthorized/)
})

test('the media upgrade refuses a mode it does not know', () => {
  const { ctx, upgrades } = host()
  apply(ctx, Config({}))
  const written = []
  upgrades[0].handler({ url: '/desktop-view/media?mode=root', headers: {} }, { end: text => written.push(text), destroy() {} }, Buffer.alloc(0))
  assert.match(written[0], /400 Bad Request/)
})

test('the config has defaults that fit the Cua container image', () => {
  const config = Config({})
  assert.equal(config.endpoint, 'http://127.0.0.1:3211')
  assert.equal(config.tokenFile, '/run/cua/env-token')
  assert.equal(config.display, 'primary')
  assert.equal(config.maxFps, 15)
  assert.equal(config.idleSeconds, 120)
  assert.equal(config.notifyAgent, 'wake')
  assert.match(config.stateFile, /dsh-desktop-view\/control\.json$/)
})

test('the config rejects values the daemon would refuse', () => {
  assert.throws(() => Config({ maxFps: 0 }))
  assert.throws(() => Config({ maxFps: 90 }))
  assert.throws(() => Config({ idleSeconds: 1 }))
  assert.throws(() => Config({ notifyAgent: 'shout' }))
})
