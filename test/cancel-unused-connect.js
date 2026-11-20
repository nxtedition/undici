'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const https = require('node:https')
const net = require('node:net')
const { test } = require('node:test')
const pem = require('@metcoder95/https-pem')

const { Client, Pool, buildConnector } = require('..')
const { kConnect } = require('../lib/core/symbols')

function settlesWithin (promise, ms = 2000) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

async function startServer (t) {
  const server = https.createServer(pem, (req, res) => res.end('ok'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const sockets = []
  let accepted = 0
  const first = Promise.withResolvers()
  const front = net.createServer(socket => {
    accepted++
    sockets.push(socket)

    const forward = () => {
      const upstream = net.connect(server.address().port, '127.0.0.1')
      sockets.push(upstream)
      socket.pipe(upstream).pipe(socket)
      socket.on('error', () => upstream.destroy())
      upstream.on('error', () => socket.destroy())
    }

    if (accepted === 1) {
      first.resolve({ socket, forward })
    } else {
      forward()
    }
  })
  front.listen(0, '127.0.0.1')
  await once(front, 'listening')

  t.after(() => {
    for (const socket of sockets) socket.destroy()
    front.close()
    server.close()
  })

  return {
    origin: `https://localhost:${front.address().port}`,
    accepted: () => accepted,
    firstAccepted: first.promise,
    async firstClosed () {
      const { socket } = await first.promise
      socket.resume()
      if (!socket.destroyed) await once(socket, 'close')
    }
  }
}

for (const connectTimeout of [undefined, 0]) {
  test(`an unused connection attempt is destroyed with connectTimeout ${connectTimeout}`, async (t) => {
    const server = await startServer(t)
    const pool = new Pool(server.origin, {
      connections: 1,
      connectTimeout,
      connect: { rejectUnauthorized: false }
    })
    t.after(() => pool.destroy())

    const connectionErrors = []
    pool.on('connectionError', (origin, targets, err) => connectionErrors.push(err))

    const controller = new AbortController()
    const first = pool.request({ path: '/', method: 'GET', signal: controller.signal })
    await settlesWithin(server.firstAccepted)
    controller.abort()
    await assert.rejects(settlesWithin(first), { name: 'AbortError' })
    await settlesWithin(server.firstClosed())

    const { statusCode, body } = await settlesWithin(pool.request({ path: '/', method: 'GET' }))
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(await body.text(), 'ok')
    assert.strictEqual(server.accepted(), 2)
    assert.deepStrictEqual(connectionErrors, [])
  })
}

test('a request queued in the Pool keeps the connection attempt', async (t) => {
  const server = await startServer(t)
  const pool = new Pool(server.origin, {
    connections: 1,
    connect: { rejectUnauthorized: false }
  })
  t.after(() => pool.destroy())

  const controller = new AbortController()
  const first = pool.request({ path: '/', method: 'GET', signal: controller.signal })
  const second = pool.request({ path: '/', method: 'GET' })
  const { forward } = await settlesWithin(server.firstAccepted)
  assert.strictEqual(pool.stats.queued, 1)

  controller.abort()
  await assert.rejects(settlesWithin(first), { name: 'AbortError' })

  forward()
  const { statusCode, body } = await settlesWithin(second)
  assert.strictEqual(statusCode, 200)
  assert.strictEqual(await body.text(), 'ok')
  assert.strictEqual(server.accepted(), 1)
})

test('another pipelined request keeps the connection attempt', async (t) => {
  const server = await startServer(t)
  const client = new Client(server.origin, {
    pipelining: 2,
    connect: { rejectUnauthorized: false }
  })
  t.after(() => client.destroy())

  const controller = new AbortController()
  const first = client.request({ path: '/', method: 'GET', signal: controller.signal })
  const second = client.request({ path: '/', method: 'GET' })
  const { forward } = await settlesWithin(server.firstAccepted)
  controller.abort()
  await assert.rejects(settlesWithin(first), { name: 'AbortError' })

  forward()
  const { statusCode, body } = await settlesWithin(second)
  assert.strictEqual(statusCode, 200)
  assert.strictEqual(await body.text(), 'ok')
  assert.strictEqual(server.accepted(), 1)
})

test('a request dispatched in the aborting turn keeps the connection attempt', async (t) => {
  const server = await startServer(t)
  const client = new Client(server.origin, {
    connect: { rejectUnauthorized: false }
  })
  t.after(() => client.destroy())

  const controller = new AbortController()
  const first = client.request({ path: '/', method: 'GET', signal: controller.signal })
  const { forward } = await settlesWithin(server.firstAccepted)

  controller.abort()
  const second = client.request({ path: '/', method: 'GET' })
  await assert.rejects(settlesWithin(first), { name: 'AbortError' })

  forward()
  const { statusCode, body } = await settlesWithin(second)
  assert.strictEqual(statusCode, 200)
  assert.strictEqual(await body.text(), 'ok')
  assert.strictEqual(server.accepted(), 1)
})

for (const returnsSocket of [true, false]) {
  test(`a custom connector that ${returnsSocket ? 'returns' : 'does not return'} its socket`, async (t) => {
    const server = await startServer(t)
    const connector = buildConnector({ rejectUnauthorized: false })
    const client = new Client(server.origin, {
      connect (opts, callback) {
        const socket = connector(opts, callback)
        if (returnsSocket) return socket
      }
    })
    t.after(() => client.destroy())

    const controller = new AbortController()
    const first = client.request({ path: '/', method: 'GET', signal: controller.signal })
    const { forward } = await settlesWithin(server.firstAccepted)
    controller.abort()
    await assert.rejects(settlesWithin(first), { name: 'AbortError' })

    if (returnsSocket) {
      await settlesWithin(server.firstClosed())
      return
    }

    forward()
    const { statusCode, body } = await settlesWithin(client.request({ path: '/', method: 'GET' }))
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(await body.text(), 'ok')
    assert.strictEqual(server.accepted(), 1)
  })
}

for (const Dispatcher of [Client, Pool]) {
  test(`destroying a ${Dispatcher.name} cancels its pending connection`, async (t) => {
    // A stalled connector may never call back, even after its socket is destroyed.
    const socket = new net.Socket()
    t.after(() => socket.destroy())
    const dispatcher = new Dispatcher('http://localhost', { connect: () => socket })
    const request = dispatcher.request({ path: '/', method: 'GET' })
    const rejected = assert.rejects(request, { code: 'UND_ERR_DESTROYED' })
    await dispatcher.destroy()
    await rejected
    assert.ok(socket.destroyed)
  })
}

test('an explicit preconnect survives a request abort until the client is destroyed', async (t) => {
  // A request can join and leave an attempt that was started independently.
  const socket = new net.Socket()
  t.after(() => socket.destroy())
  const client = new Client('http://localhost', { connect: () => socket })
  client[kConnect](() => {})
  const controller = new AbortController()
  const request = client.request({ path: '/', method: 'GET', signal: controller.signal })
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  assert.ok(!socket.destroyed)
  await client.destroy()
  assert.ok(socket.destroyed)
})

test('shutdown during a connector call disposes both returned and late sockets', async (t) => {
  // The connector can hand back a different socket after the client has shut down.
  const connecting = new net.Socket()
  const late = new net.Socket()
  t.after(() => {
    connecting.destroy()
    late.destroy()
  })
  let finish
  const client = new Client('http://localhost', {
    connect (opts, callback) {
      finish = callback
      client.destroy()
      return connecting
    }
  })
  const request = client.request({ path: '/', method: 'GET' })
  await assert.rejects(request, { code: 'UND_ERR_DESTROYED' })
  await client.destroy()
  assert.ok(connecting.destroyed)
  finish(null, late)
  assert.ok(late.destroyed)
})
