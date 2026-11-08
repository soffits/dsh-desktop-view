/**
 * Loads client.js the way DSH's module loader does, with a stub React, so
 * the browser half's registrations and its dictionaries are checked without
 * a page. Nothing here renders; a missing locale key or a registration with
 * the wrong slot name would break the tab in the Web UI, so those are the
 * assertions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const source = await readFile(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

/** A React stand-in: createElement records nothing; hooks are inert. */
const React = {
  createElement: () => null,
  Fragment: 'fragment',
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useRef: value => ({ current: value ?? null }),
  useMemo: value => value(),
  useCallback: value => value,
}

/** Run client.js against a Host-shaped Client context and return what it registered. */
function load() {
  const registrations = []
  const dictionaries = new Map()
  const effects = []
  let factory
  globalThis.window = { __ModuleLoader__: { load: ({ factory: created }) => { factory = created } } }
  globalThis.document = {
    baseURI: 'https://dsh.example/',
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ dataset: {}, remove() {} }),
  }
  // eslint-disable-next-line no-new-func -- the module defines window.__ModuleLoader__ itself
  new Function(source)()
  const ctx = {
    effect(fn) { effects.push(fn()) },
    locale: {
      register(namespace, language, table) { dictionaries.set(language, table); return () => {} },
      bind: () => (key, params) => params === undefined ? key : `${key}:${JSON.stringify(params)}`,
    },
    slots: {
      inject(name, create) { registrations.push({ name, ...create() }) },
      register(definition) { return definition },
    },
    sidebarRightTabs: { register(definition) { registrations.push({ ...definition }); return () => {} } },
    sidebarRight: { active: () => undefined, isExpanded: () => false, openTab() {}, hide() {} },
    get: () => undefined,
  }
  factory(require => {
    if (require === 'react') return React
    throw new Error(`unexpected module ${require}`)
  }).apply(ctx)
  return { registrations, dictionaries, effects }
}

test('the browser half loads through the module loader and registers one tab type', () => {
  const { registrations } = load()
  const types = registrations.filter(entry => entry.kind === 'desktop-view' && entry.guide !== undefined)
  assert.equal(types.length, 1)
  assert.equal(types[0].priority, 'extension')
  assert.equal(types[0].keepMounted, true, 'a hidden tab keeps its view and control')
  assert.equal(types[0].guide.length, 1)
  assert.equal(types[0].guide[0].kind, undefined, 'guide entries are matched by their provider kind')
})

test('the tab body and the header button are registered in their slots', () => {
  const { registrations } = load()
  const body = registrations.find(entry => entry.name === 'sidebar.right.pane.tab')
  assert.equal(body.key, 'dsh-desktop-view')
  const header = registrations.find(entry => entry.name === 'conversation.session.header.utilities')
  assert.equal(header.id, 'desktop-view')
  assert.equal(typeof header.inject().sidebar.openTab, 'function')
})

test('both languages carry the same keys, and every key the code asks for exists', () => {
  const { dictionaries } = load()
  const en = dictionaries.get('en')
  const zh = dictionaries.get('zh')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  const asked = new Set([...source.matchAll(/\bt\('([^']+)'\)/g)].map(match => match[1]))
  for (const key of ['ended.idle', 'ended.replaced', 'ended.disconnected', 'ended.stopped']) asked.add(key)
  for (const key of asked) {
    assert.equal(typeof en[key], 'string', `missing en ${key}`)
    assert.equal(typeof zh[key], 'string', `missing zh ${key}`)
  }
})

test('unloading runs the registered cleanups without throwing', () => {
  const { effects } = load()
  assert.equal(effects.length >= 1, true)
  for (const dispose of effects) if (typeof dispose === 'function') dispose()
})
