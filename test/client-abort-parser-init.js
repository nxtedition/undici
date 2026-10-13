'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const net = require('node:net')
const { test } = require('node:test')

// Hold the first parser compilation open to cover cancellation after the
// connector succeeds but before connectH1 installs its socket handlers.
const compile = WebAssembly.compile
let releaseParser
const parserGate = new Promise((resolve) => { releaseParser = resolve })
WebAssembly.compile = async (...args) => {
  const module = await compile(...args)
  await parserGate
  return module
}
const { Client } = require('..')
WebAssembly.compile = compile

test('abort and destroy during parser initialization preserve the next connection', async (t) => {
  t.after(() => releaseParser())
  const server = createServer((req, res) => res.end('ok'))
  t.after(() => server.close())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const sockets = []
  let connected
  const client = new Client(`http://127.0.0.1:${server.address().port}`, {
    connect (opts, callback) {
      const socket = net.connect({ host: opts.hostname, port: opts.port })
      sockets.push(socket)
      socket.once('connect', () => {
        callback(null, socket)
        connected?.()
      })
    }
  })
  t.after(() => client.destroy())

  const controller = new AbortController()
  const reason = new Error('abort during parser initialization')
  const firstConnected = new Promise((resolve) => { connected = resolve })
  const first = client.request({ path: '/', method: 'GET', signal: controller.signal }).catch(err => err)
  await firstConnected
  connected = null
  controller.abort(reason)
  assert.strictEqual(await first, reason)
  assert.strictEqual(sockets[0].destroyed, true)

  const destroyedSockets = []
  let destroyingConnected
  const destroying = new Client(`http://127.0.0.1:${server.address().port}`, {
    connect (opts, callback) {
      const socket = net.connect({ host: opts.hostname, port: opts.port })
      destroyedSockets.push(socket)
      socket.once('connect', () => {
        callback(null, socket)
        destroyingConnected()
      })
    }
  })
  t.after(() => destroying.destroy())
  const destructionConnected = new Promise((resolve) => { destroyingConnected = resolve })
  const destructionReason = new Error('destroy during parser initialization')
  const destroyedRequest = destroying.request({ path: '/', method: 'GET' }).catch(err => err)
  await destructionConnected
  await destroying.destroy(destructionReason)
  assert.strictEqual(await destroyedRequest, destructionReason)
  assert.strictEqual(destroyedSockets[0].destroyed, true)

  const second = client.request({ path: '/', method: 'GET' })
  releaseParser()
  const response = await second
  assert.strictEqual(await response.body.text(), 'ok')
  assert.strictEqual(sockets.length, 2)
})

test('destroy during the initialized socket handoff preserves the destruction reason', async (t) => {
  const server = createServer((req, res) => res.end('ok'))
  t.after(() => server.close())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const reason = new Error('destroy during initialized socket handoff')
  let destruction
  const client = new Client(`http://127.0.0.1:${server.address().port}`, {
    connect (opts, callback) {
      const socket = net.connect({ host: opts.hostname, port: opts.port })
      socket.once('connect', () => {
        callback(null, socket)
        // The connector continuation initializes the cached parser first; this
        // microtask destroys the client before its context is handed back.
        queueMicrotask(() => { destruction = client.destroy(reason) })
      })
    }
  })
  t.after(() => client.destroy())

  const outcome = await client.request({ path: '/', method: 'GET' }).catch(err => err)
  assert.strictEqual(outcome, reason)
  await destruction
  await new Promise((resolve) => setImmediate(resolve))
})
