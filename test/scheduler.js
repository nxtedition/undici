'use strict'

const assert = require('node:assert')
const { test } = require('node:test')
const { once } = require('node:events')
const http = require('node:http')
const https = require('node:https')
const { Readable } = require('node:stream')
const { setTimeout: sleep } = require('node:timers/promises')
const pem = require('@metcoder95/https-pem')
const { Client, errors } = require('..')

// Plain sockets are read through their Readable side, TLS sockets through a
// SocketReader.
const PROTOCOLS = ['http', 'https']

const TOTAL = 32 * 1024 * 1024
const CHUNK = Buffer.alloc(64 * 1024, 'a')

// The part of @nxtedition/scheduler a request uses.
class TestScheduler {
  constructor () {
    this.paused = false
    this.running = 0
    this.granted = 0
    this.overReleased = 0
    this.priorities = []
    this.queue = []
  }

  acquire (fn, priority) {
    this.priorities.push(priority)
    if (!this.paused && this.queue.length === 0) {
      this.grant(fn)
      return true
    }
    this.queue.push(fn)
    return false
  }

  release () {
    if (this.running === 0) {
      this.overReleased++
      return
    }
    this.running--
  }

  pause () {
    this.paused = true
  }

  resume () {
    this.paused = false
    while (this.queue.length > 0) {
      this.grant(this.queue.shift())
    }
  }

  grant (fn) {
    this.running++
    this.granted++
    fn()
  }
}

async function waitFor (predicate, message) {
  const deadline = Date.now() + 10e3
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${message}`)
    }
    await sleep(10)
  }
}

// Waits until the value stops changing, i.e. the transfer is held.
async function waitForStable (getValue) {
  let value = getValue()
  for (let i = 0; i < 1000; i++) {
    await sleep(100)
    const next = getValue()
    if (next === value) {
      return value
    }
    value = next
  }
  throw new Error('transfer did not stop')
}

function assertSettled (scheduler) {
  assert.strictEqual(scheduler.queue.length, 0, 'slots still queued')
  assert.strictEqual(scheduler.running, 0, 'slots not released')
  assert.strictEqual(scheduler.overReleased, 0, 'slots released twice')
}

async function startServer (t, protocol, handler, options) {
  const server = protocol === 'https' ? https.createServer(pem, handler) : http.createServer(handler)
  t.after(() => server.close())
  server.listen(0)
  await once(server, 'listening')
  const client = new Client(`${protocol}://localhost:${server.address().port}`, {
    tls: { rejectUnauthorized: false },
    ...options
  })
  t.after(() => client.destroy())
  return client
}

// Counts request body bytes the server received.
async function startUploadServer (t, protocol) {
  const state = { received: 0 }
  const client = await startServer(t, protocol, (req, res) => {
    req
      .on('data', (chunk) => { state.received += chunk.length })
      .on('end', () => res.end(String(state.received)))
      .on('error', () => {})
  })
  return { client, state }
}

// Sends TOTAL bytes, counting those the socket accepted.
async function startDownloadServer (t, protocol) {
  const state = { written: 0 }
  const client = await startServer(t, protocol, (req, res) => {
    res.writeHead(200, { 'content-length': TOTAL })
    const write = () => {
      while (state.written < TOTAL) {
        state.written += CHUNK.length
        if (!res.write(CHUNK)) {
          res.once('drain', write)
          return
        }
      }
      res.end()
    }
    write()
    res.on('error', () => {})
  })
  return { client, state }
}

const bodies = {
  stream: (onFinally) => new Readable({
    read () {
      this.sent ??= 0
      this.push(this.sent < TOTAL ? CHUNK : null)
      this.sent += CHUNK.length
    },
    destroy (err, callback) {
      onFinally?.()
      callback(err)
    }
  }),
  iterable: (onFinally) => (async function * () {
    try {
      for (let sent = 0; sent < TOTAL; sent += CHUNK.length) {
        yield CHUNK
      }
    } finally {
      onFinally?.()
    }
  })()
}

// Written in chunks when scheduled. They have no producer to finalize.
const buffers = {
  buffer: () => Buffer.alloc(TOTAL, 'a'),
  string: () => 'a'.repeat(TOTAL)
}

async function readAll (body) {
  let received = 0
  for await (const chunk of body) {
    received += chunk.length
  }
  return received
}

test('rejects an invalid scheduler or priority', async (t) => {
  const client = new Client('http://localhost:1')
  t.after(() => client.destroy())

  await assert.rejects(
    client.request({ path: '/', method: 'GET', scheduler: { acquire () {} } }),
    errors.InvalidArgumentError
  )
  await assert.rejects(
    client.request({ path: '/', method: 'GET', scheduler: new TestScheduler(), priority: {} }),
    errors.InvalidArgumentError
  )
})

for (const protocol of PROTOCOLS) {
  for (const [kind, createBody] of Object.entries({ ...bodies, ...buffers })) {
    test(`schedules writes of a ${kind} body (${protocol})`, async (t) => {
      const { client } = await startUploadServer(t, protocol)
      const scheduler = new TestScheduler()

      const res = await client.request({
        path: '/',
        method: 'PUT',
        body: createBody(),
        scheduler,
        priority: 'high'
      })

      assert.strictEqual(await res.body.text(), String(TOTAL))
      assert.ok(scheduler.granted > 0, 'no slot was acquired')
      assert.ok(scheduler.priorities.every((priority) => priority === 'high'))
      assertSettled(scheduler)
    })

    test(`holds writes of a ${kind} body until a slot is granted (${protocol})`, async (t) => {
      const { client, state } = await startUploadServer(t, protocol)
      const scheduler = new TestScheduler()
      scheduler.pause()

      const promise = client.request({ path: '/', method: 'PUT', body: createBody(), scheduler })

      await waitFor(() => scheduler.queue.length > 0, 'a queued write')
      const received = await waitForStable(() => state.received)
      assert.ok(received < TOTAL, `server received the whole body: ${received}`)

      scheduler.resume()
      const res = await promise
      assert.strictEqual(await res.body.text(), String(TOTAL))
      assertSettled(scheduler)
    })

    test(`releases a held write slot when a ${kind} body is aborted (${protocol})`, async (t) => {
      // The server never reads, so the socket never drains.
      const client = await startServer(t, protocol, (req) => req.pause())
      const scheduler = new TestScheduler()

      const ac = new AbortController()
      const promise = client.request({ path: '/', method: 'PUT', body: createBody(), scheduler, signal: ac.signal })
      await waitFor(() => scheduler.running === 1, 'a held write')

      ac.abort()
      await assert.rejects(promise, { name: 'AbortError' })
      await waitFor(() => scheduler.running === 0, 'the held slot to be released')
      assertSettled(scheduler)
    })
  }

  for (const [kind, createBody] of Object.entries(bodies)) {
    test(`releases a write slot granted after a ${kind} body was aborted (${protocol})`, async (t) => {
      const { client } = await startUploadServer(t, protocol)
      const scheduler = new TestScheduler()
      scheduler.pause()

      let finalized = false
      const ac = new AbortController()
      const promise = client.request({
        path: '/',
        method: 'PUT',
        body: createBody(() => { finalized = true }),
        scheduler,
        signal: ac.signal
      })

      await waitFor(() => scheduler.queue.length > 0, 'a queued write')
      ac.abort()
      await assert.rejects(promise, { name: 'AbortError' })
      // The body doesn't wait for the slot to fail.
      await waitFor(() => finalized, 'the body to be finalized')

      scheduler.resume()
      assertSettled(scheduler)
    })
  }

  test(`releases a write slot granted after a buffer body was aborted (${protocol})`, async (t) => {
    const { client } = await startUploadServer(t, protocol)
    const scheduler = new TestScheduler()
    scheduler.pause()

    const ac = new AbortController()
    const promise = client.request({ path: '/', method: 'PUT', body: buffers.buffer(), scheduler, signal: ac.signal })

    await waitFor(() => scheduler.queue.length > 0, 'a queued write')
    ac.abort()
    await assert.rejects(promise, { name: 'AbortError' })

    scheduler.resume()
    assertSettled(scheduler)
  })

  test(`writes a buffer body of at most 64 KiB at once (${protocol})`, async (t) => {
    const { client } = await startUploadServer(t, protocol)
    const scheduler = new TestScheduler()
    scheduler.pause()

    const res = await client.request({ path: '/', method: 'PUT', body: Buffer.alloc(64 * 1024), scheduler })
    assert.strictEqual(await res.body.text(), String(64 * 1024))
    assert.deepStrictEqual(scheduler.priorities, [], 'a slot was acquired')
  })

  test(`does not pipeline a scheduled buffer body behind other requests (${protocol})`, async (t) => {
    let pending = null
    const methods = []
    const client = await startServer(t, protocol, (req, res) => {
      methods.push(req.method)
      if (req.method === 'GET') {
        pending = res
      } else {
        req.resume().on('end', () => res.end())
      }
    }, { pipelining: 2 })

    const get = client.request({ path: '/', method: 'GET' })
    await waitFor(() => pending !== null, 'the GET to reach the server')
    const put = client.request({
      path: '/',
      method: 'PUT',
      body: buffers.buffer(),
      idempotent: true,
      scheduler: new TestScheduler()
    })

    // Written behind the GET, the body would still be writing when the GET's
    // response completes, which fails the PUT.
    await sleep(200)
    assert.deepStrictEqual(methods, ['GET'])

    pending.end('ok')
    assert.strictEqual(await (await get).body.text(), 'ok')
    assert.strictEqual(await (await put).body.text(), '')
    assert.deepStrictEqual(methods, ['GET', 'PUT'])
  })

  for (const scheduled of [true, false]) {
    test(`finalizes an iterable body waiting ${scheduled ? 'for a slot' : 'to drain'} when its socket closes (${protocol})`, async (t) => {
      // The server never reads, so the socket never drains.
      const client = await startServer(t, protocol, (req) => req.pause())
      const scheduler = new TestScheduler()
      scheduler.pause()

      let waiting = false
      let finalized = false
      const body = (async function * () {
        try {
          while (true) {
            if (waiting) {
              // A producer with nothing more to send yet.
              await new Promise(() => {})
            }
            yield CHUNK
          }
        } finally {
          finalized = true
        }
      })()

      const ac = new AbortController()
      const promise = client.request({
        path: '/',
        method: 'PUT',
        body,
        scheduler: scheduled ? scheduler : null,
        signal: ac.signal
      })

      if (scheduled) {
        await waitFor(() => scheduler.queue.length > 0, 'a queued write')
      } else {
        // Wait for the socket to push back.
        await sleep(500)
      }
      waiting = true

      ac.abort()
      await assert.rejects(promise, { name: 'AbortError' })
      // Without pulling another chunk from the body.
      await waitFor(() => finalized, 'the body to be finalized')

      scheduler.resume()
      assertSettled(scheduler)
    })
  }

  test(`schedules reads of a response body (${protocol})`, async (t) => {
    const { client } = await startDownloadServer(t, protocol)
    const scheduler = new TestScheduler()

    const res = await client.request({ path: '/', method: 'GET', scheduler, priority: -1 })

    assert.strictEqual(await readAll(res.body), TOTAL)
    assert.ok(scheduler.granted > 0, 'no slot was acquired')
    assert.ok(scheduler.priorities.every((priority) => priority === -1))
    assertSettled(scheduler)
  })

  test(`holds reads of a response body until a slot is granted (${protocol})`, async (t) => {
    const { client, state } = await startDownloadServer(t, protocol)
    const scheduler = new TestScheduler()
    scheduler.pause()

    const res = await client.request({ path: '/', method: 'GET', scheduler })
    const promise = readAll(res.body)

    await waitFor(() => scheduler.queue.length > 0, 'a queued read')
    const written = await waitForStable(() => state.written)
    assert.ok(written < TOTAL, `server sent the whole body: ${written}`)

    scheduler.resume()
    assert.strictEqual(await promise, TOTAL)
    assertSettled(scheduler)
  })

  test(`does not time out a response body queued for a slot (${protocol})`, async (t) => {
    const { client } = await startDownloadServer(t, protocol)
    const scheduler = new TestScheduler()
    scheduler.pause()

    const res = await client.request({ path: '/', method: 'GET', scheduler, bodyTimeout: 500 })
    const promise = readAll(res.body)

    await waitFor(() => scheduler.queue.length > 0, 'a queued read')
    // Fast timers fire within about 1s of a 500ms timeout.
    await sleep(2000)

    scheduler.resume()
    assert.strictEqual(await promise, TOTAL)
    assertSettled(scheduler)
  })

  test(`releases read slots when the request is aborted (${protocol})`, async (t) => {
    const client = await startServer(t, protocol, (req, res) => {
      res.writeHead(200, { 'content-length': TOTAL })
      res.write(CHUNK)
      res.on('error', () => {})
    })
    const scheduler = new TestScheduler()

    // Holds a slot while it waits for the rest of the body.
    const ac = new AbortController()
    const res = await client.request({ path: '/', method: 'GET', scheduler, signal: ac.signal })
    const promise = readAll(res.body)
    await waitFor(() => scheduler.running === 1, 'a held read')

    ac.abort()
    await assert.rejects(promise, { name: 'AbortError' })
    await waitFor(() => scheduler.running === 0, 'the held slot to be released')

    // Releases a slot granted once the socket closed.
    scheduler.pause()
    const ac2 = new AbortController()
    const res2 = await client.request({ path: '/', method: 'GET', scheduler, signal: ac2.signal })
    const promise2 = readAll(res2.body)
    await waitFor(() => scheduler.queue.length > 0, 'a queued read')

    const disconnected = once(client, 'disconnect')
    ac2.abort()
    await assert.rejects(promise2, { name: 'AbortError' })
    await disconnected

    scheduler.resume()
    assertSettled(scheduler)
  })

  // A Readable side ends only once its bytes are read, but a SocketReader can
  // still hold bytes when the socket ends.
  if (protocol === 'https') {
    test(`reads a response body that ends while queued for a slot (${protocol})`, async (t) => {
      const scheduler = new TestScheduler()
      const client = await startServer(t, protocol, async (req, res) => {
        res.writeHead(200, { 'content-length': 2 * CHUNK.length, connection: 'close' })
        res.write(CHUNK)
        await waitFor(() => scheduler.queue.length > 0, 'a queued read')
        res.end(CHUNK)
      })
      scheduler.pause()

      const disconnected = once(client, 'disconnect')
      const res = await client.request({ path: '/', method: 'GET', scheduler })

      // No more bytes come once the socket ends, so the slot is not waited for.
      assert.strictEqual(await readAll(res.body), 2 * CHUNK.length)

      await disconnected
      scheduler.resume()
      assertSettled(scheduler)
    })
  }
}
