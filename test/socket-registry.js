'use strict'

const { tspl } = require('@matteo.collina/tspl')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { test, after } = require('node:test')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { Client } = require('..')
const { kSockets } = require('../lib/core/socket-registry.js')

const registry = () => globalThis[kSockets]

test('tracks live sockets under the Symbol.for slot with their origin', async (t) => {
  t = tspl(t, { plan: 6 })

  const server = createServer((req, res) => {
    res.end('hello')
  })
  after(server.close.bind(server))

  server.listen(0)
  await once(server, 'listening')

  const origin = `http://localhost:${server.address().port}`
  const client = new Client(origin)
  after(() => client.destroy())

  const before = registry().size

  const { body } = await client.request({ path: '/', method: 'GET' })
  await body.text()

  t.strictEqual(registry().size, before + 1, 'connected socket is registered')

  const entry = [...registry().values()].find((value) => value.origin === origin)
  t.ok(entry, 'entry is recorded for the pool origin')
  t.strictEqual(entry.hostname, 'localhost')
  t.strictEqual(entry.port, String(server.address().port))

  // The deprecated alias must expose the very same Map, not a second registry —
  // a consumer pinned to the old name has to keep observing live counts.
  t.strictEqual(globalThis.__undici_sockets, registry(), 'legacy alias is the same Map')

  await client.close()
  t.strictEqual(registry().size, before, 'socket is removed on close')

  await t.completed
})

test('assigning to the legacy alias absorbs entries instead of replacing the registry', async (t) => {
  t = tspl(t, { plan: 3 })

  const shared = registry()
  const socket = { on () {} }
  const replacement = new Map([[socket, { origin: 'http://example.test' }]])

  globalThis.__undici_sockets = replacement

  t.strictEqual(registry(), shared, 'registry identity is preserved')
  t.strictEqual(shared.get(socket)?.origin, 'http://example.test', 'entries are absorbed')

  shared.delete(socket)
  t.strictEqual(shared.has(socket), false)

  await t.completed
})

test('a non-configurable legacy Map is reused without redefining it', () => {
  const packagePath = require.resolve('..')
  const result = spawnSync(process.execPath, ['--eval', `
    const assert = require('node:assert/strict')
    const legacy = new Map([[{}, { hostname: 'legacy.test' }]])
    Object.defineProperty(globalThis, '__undici_sockets', {
      configurable: false,
      value: legacy
    })

    require(${JSON.stringify(packagePath)})

    const sockets = globalThis[Symbol.for('@nxtedition/undici/sockets')]
    assert.strictEqual(sockets, legacy)
    assert.strictEqual(globalThis.__undici_sockets, legacy)
  `], { encoding: 'utf8', timeout: 5000 })

  assert.ifError(result.error)
  assert.strictEqual(result.status, 0, result.stderr)
})

test('an incompatible non-configurable legacy property does not prevent import', () => {
  const packagePath = require.resolve('..')
  const result = spawnSync(process.execPath, ['--eval', `
    const assert = require('node:assert/strict')
    const collision = Object.freeze({ unrelated: true })
    Object.defineProperty(globalThis, '__undici_sockets', {
      configurable: false,
      value: collision
    })

    require(${JSON.stringify(packagePath)})

    const sockets = globalThis[Symbol.for('@nxtedition/undici/sockets')]
    assert.ok(sockets instanceof Map)
    assert.strictEqual(globalThis.__undici_sockets, collision)
  `], { encoding: 'utf8', timeout: 5000 })

  assert.ifError(result.error)
  assert.strictEqual(result.status, 0, result.stderr)
})
