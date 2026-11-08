import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTicketBook } from '../src/tickets.js'

function book({ now = () => 1_000_000 } = {}) {
  const minted = []
  const tickets = createTicketBook({
    spacesd: {
      async createViewerTicket(options) {
        minted.push(options)
        return { ticket: `viewer-${minted.length}`, expiresAt: now() + 60 * 60 * 1000, hints: '' }
      },
    },
    features: { clipboard: true, filesRoot: '~', microphone: true },
    now,
  })
  return { tickets, minted }
}

test('watching gets a view-only ticket with no clipboard, files or microphone', async () => {
  const { tickets, minted } = book()
  await tickets.viewerTicket('watch')
  assert.deepEqual({ ...minted[0], ttlSeconds: undefined, name: undefined }, {
    policy: 'view_only', clipboard: false, filesRoot: '', audioUplink: false, ttlSeconds: undefined, name: undefined,
  })
})

test('control gets input, clipboard, files and the microphone as configured', async () => {
  const { tickets, minted } = book()
  await tickets.viewerTicket('control')
  assert.equal(minted[0].policy, 'allow_activation')
  assert.equal(minted[0].clipboard, true)
  assert.equal(minted[0].filesRoot, '~')
  assert.equal(minted[0].audioUplink, true)
})

test('a viewer ticket is reused until it nears expiry, then minted again', async () => {
  let clock = 1_000_000
  const { tickets, minted } = book({ now: () => clock })
  const first = await tickets.viewerTicket('watch')
  assert.equal((await tickets.viewerTicket('watch')).ticket, first.ticket)
  clock += 55 * 60 * 1000
  assert.notEqual((await tickets.viewerTicket('watch')).ticket, first.ticket)
  assert.equal(minted.length, 2)
})

test('concurrent requests share one mint, and an invalidated ticket is minted anew', async () => {
  const { tickets, minted } = book()
  const [a, b] = await Promise.all([tickets.viewerTicket('control'), tickets.viewerTicket('control')])
  assert.equal(a.ticket, b.ticket)
  assert.equal(minted.length, 1)
  tickets.invalidate('control')
  await tickets.viewerTicket('control')
  assert.equal(minted.length, 2)
})

test('relay tickets are random, carry their grant and stop working when revoked', () => {
  const { tickets } = book()
  const one = tickets.issue({ mode: 'watch', holderId: 'h1', sessionId: 's-1' })
  const two = tickets.issue({ mode: 'watch', holderId: 'h1', sessionId: 's-1' })
  assert.notEqual(one, two)
  assert.ok(one.length >= 40)
  assert.deepEqual(tickets.lookup(one), { mode: 'watch', holderId: 'h1', sessionId: 's-1' })
  tickets.revoke(one)
  assert.equal(tickets.lookup(one), undefined)
  assert.equal(tickets.lookup(undefined), undefined)
})

test('revoking a holder\'s control tickets keeps its watch ticket', () => {
  const { tickets } = book()
  const watch = tickets.issue({ mode: 'watch', holderId: 'h1', sessionId: null })
  const control = tickets.issue({ mode: 'control', holderId: 'h1', sessionId: null })
  const other = tickets.issue({ mode: 'control', holderId: 'h2', sessionId: null })
  tickets.revokeHolder('h1', 'control')
  assert.notEqual(tickets.lookup(watch), undefined)
  assert.equal(tickets.lookup(control), undefined)
  assert.notEqual(tickets.lookup(other), undefined)
  tickets.revokeHolder('h1')
  assert.equal(tickets.lookup(watch), undefined)
})

test('a media ticket is judged by the relay ticket that opened it, and dies with it', () => {
  const { tickets } = book()
  const revoked = []
  tickets.onRevoke(token => revoked.push(token))
  const control = tickets.issue({ mode: 'control', holderId: 'h1', sessionId: 's-1' })
  tickets.bindMedia('media-ticket', control, 'media-1')
  assert.equal(tickets.media('media-ticket').grant.mode, 'control')
  assert.equal(tickets.media('media-ticket').sessionId, 'media-1')
  assert.equal(tickets.media('unknown'), undefined)
  tickets.revoke(control)
  assert.equal(tickets.media('media-ticket'), undefined)
  assert.deepEqual(revoked, [control])
})

test('a media session opened with an unknown relay ticket is not bound', () => {
  const { tickets } = book()
  tickets.bindMedia('media-ticket', 'not-issued', 'media-1')
  assert.equal(tickets.media('media-ticket'), undefined)
})
