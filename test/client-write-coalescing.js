'use strict'

const assert = require('node:assert')
const { test } = require('node:test')
const { once } = require('node:events')
const net = require('node:net')
const { createServer } = require('node:http')
const { Readable } = require('node:stream')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { Client } = require('..')
const timers = require('../lib/util/timers')

const execFileAsync = promisify(execFile)

async function startEchoServer (t, onData) {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
      onData?.(chunk)
    })
    req.on('end', () => res.end(Buffer.concat(chunks)))
  })
  t.after(() => server.close())
  server.listen(0)
  await once(server, 'listening')
  return server
}

async function echo (client, body, headers) {
  const res = await client.request({ path: '/', method: 'POST', body, headers })
  return Buffer.from(await res.body.arrayBuffer())
}

test('coalesces small body chunks into a few socket writes', async (t) => {
  const server = await startEchoServer(t)

  let writes = 0
  const client = new Client(`http://localhost:${server.address().port}`, {
    connect (opts, callback) {
      const socket = net.connect(Number(opts.port), opts.hostname)
      const write = socket.write
      socket.write = function (...args) {
        writes++
        return write.apply(this, args)
      }
      socket.once('connect', () => callback(null, socket))
      socket.once('error', (err) => callback(err, null))
      return socket
    }
  })
  t.after(() => client.close())

  const parts = Array.from({ length: 256 }, (_, i) => `${i},`)
  const body = await echo(client, (function * () {
    for (let i = 0; i < parts.length; i++) {
      yield i % 2 ? parts[i] : Buffer.from(parts[i])
    }
  })())

  assert.strictEqual(body.toString(), parts.join(''))
  // Without coalescing, every chunk costs two socket writes: its size line
  // and the chunk itself.
  assert.ok(writes <= 4, `expected at most 4 socket writes, got ${writes}`)
})

test('flushes buffered chunks before the body produces more data', { timeout: 10000 }, async (t) => {
  let onFirstChunk
  const server = await startEchoServer(t, () => onFirstChunk?.())

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(() => client.close())

  const makeBodies = (received) => ({
    iterable: (async function * () {
      yield 'first,'
      await received
      yield 'second'
    })(),
    stream: new Readable({
      read () {
        if (!this.started) {
          this.started = true
          this.push('first,')
          received.then(() => {
            this.push('second')
            this.push(null)
          })
        }
      }
    })
  })

  for (const kind of ['iterable', 'stream']) {
    const received = new Promise((resolve) => { onFirstChunk = resolve })
    const body = await echo(client, makeBodies(received)[kind])
    assert.strictEqual(body.toString(), 'first,second', kind)
  }
})

test('copies small chunks so that the body can reuse its buffer', async (t) => {
  const server = await startEchoServer(t)

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(() => client.close())

  const body = await echo(client, (function * () {
    const buf = Buffer.alloc(16)
    for (const c of 'abc') {
      buf.fill(c)
      yield buf
    }
  })())

  assert.strictEqual(body.toString(), 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(16))
})

test('writes array buffers and views of any type as bytes', async (t) => {
  const server = await startEchoServer(t)

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(() => client.close())

  const bytes = (str) => new Uint8Array(Buffer.from(str))
  const padded = Buffer.from('xxcdxx')
  const shared = new SharedArrayBuffer(2)
  new Uint8Array(shared).set(bytes('ij'))

  const body = await echo(client, (function * () {
    yield new Uint16Array(bytes('ab').buffer)
    yield new DataView(padded.buffer, padded.byteOffset + 2, 2)
    yield bytes('ef').buffer
    yield new Float32Array(bytes('gh\0\0').buffer)
    yield shared
    yield 'é'
  })())

  assert.strictEqual(body.toString(), 'abcdefgh\0\0ijé')
})

test('interleaves large and small chunks in order', async (t) => {
  const server = await startEchoServer(t)

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(() => client.close())

  const large = Buffer.alloc(100 * 1024, 'b')
  const expected = Buffer.concat([Buffer.from('a'), large, Buffer.from('c'), large, Buffer.from('d')])

  for (const headers of [undefined, { 'content-length': String(expected.length) }]) {
    const body = await echo(client, (function * () {
      yield 'a'
      yield large
      yield 'c'
      yield large.toString()
      yield Buffer.from('d')
    })(), headers)
    assert.ok(body.equals(expected), headers ? 'content-length' : 'chunked')
  }
})

test('later requests on a connection share its slab without overwriting earlier writes', async (t) => {
  const server = await startEchoServer(t)

  // Keep the views that the socket was given, without copying them, like a
  // connector that holds on to written chunks would.
  const written = []
  const client = new Client(`http://localhost:${server.address().port}`, {
    connect (opts, callback) {
      const socket = net.connect(Number(opts.port), opts.hostname)
      const write = socket.write
      socket.write = function (chunk, ...args) {
        written.push(chunk)
        return write.call(this, chunk, ...args)
      }
      socket.once('connect', () => callback(null, socket))
      socket.once('error', (err) => callback(err, null))
      return socket
    }
  })
  t.after(() => client.close())

  const snapshots = []
  for (let i = 0; i < 3; i++) {
    const body = await echo(client, (function * () {
      yield `request ${i}`
    })())
    assert.strictEqual(body.toString(), `request ${i}`)
    snapshots.push(written.map((chunk) => Buffer.from(chunk).toString('latin1')))
  }

  const slabs = new Set(written.filter(Buffer.isBuffer).map((chunk) => chunk.buffer))
  assert.strictEqual(slabs.size, 1, 'requests should share one slab')
  for (const snapshot of snapshots) {
    assert.deepStrictEqual(written.slice(0, snapshot.length).map((chunk) => Buffer.from(chunk).toString('latin1')), snapshot)
  }
})

test('socket write failures abort the request without escaping from a deferred flush or cleanup', async (t) => {
  for (const kind of ['iterable', 'stream', 'stream-error']) {
    await t.test(kind, async () => {
      // An uncaught nextTick exception must fail the child, rather than being
      // swallowed by the test runner's own exception handler.
      const script = `
        const assert = require('node:assert/strict')
        const net = require('node:net')
        const { once, EventEmitter } = require('node:events')
        const { createServer } = require('node:http')
        const { Readable } = require('node:stream')
        const { Client } = require(${JSON.stringify(require.resolve('..'))})
        ;(async () => {
          const server = createServer()
          server.listen(0)
          await once(server, 'listening')
          const writeError = new Error('socket write failed')
          const bodyError = new Error('body failed')
          let writes = 0
          const client = new Client('http://localhost:' + server.address().port, {
            connect (opts, callback) {
              const socket = net.connect(Number(opts.port), opts.hostname)
              socket.write = () => { writes++; throw writeError }
              socket.once('connect', () => callback(null, socket))
              socket.once('error', (err) => callback(err, null))
              return socket
            }
          })
          const kind = ${JSON.stringify(kind)}
          const body = kind === 'iterable'
            ? (async function * () {
                yield 'first'
                await new Promise((resolve) => setImmediate(resolve))
                yield 'second'
              })()
            : kind === 'stream-error'
              ? Object.assign(new EventEmitter(), {
                  pipe () {},
                  destroy () { this.destroyed = true; queueMicrotask(() => this.emit('close')) }
                })
              : new Readable({ read () {} })
          if (kind === 'stream') {
            body.push('first')
          } else if (kind === 'stream-error') {
            body.resume = function () {
              this.emit('data', Buffer.from('first'))
              this.emit('error', bodyError)
            }
          }
          try {
            await assert.rejects(client.request({ path: '/', method: 'POST', body }),
              kind === 'stream-error' ? bodyError : writeError)
            assert.equal(writes, 1)
            if (kind !== 'iterable') assert.equal(body.destroyed, true)
          } finally {
            await client.destroy()
            server.close()
          }
        })().catch((err) => { console.error(err); process.exitCode = 1 })
      `
      await execFileAsync(process.execPath, ['-e', script], { timeout: 10000 })
    })
  }
})

test('accepts stream-like bodies without prependListener', async (t) => {
  const server = await startEchoServer(t)
  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(() => client.destroy())

  const stream = Readable.from(['first,', 'second'])
  stream.prependListener = undefined
  assert.strictEqual((await echo(client, stream)).toString(), 'first,second')
})

test('deferred flush backpressure refreshes the headers timeout', async (t) => {
  timers.reset()
  t.after(() => timers.reset())
  const server = await startEchoServer(t)
  let socket
  let backpressured = false
  const client = new Client(`http://localhost:${server.address().port}`, {
    headersTimeout: 1000,
    connect (opts, callback) {
      socket = net.connect(Number(opts.port), opts.hostname)
      const write = socket.write
      Object.defineProperty(socket, 'writableNeedDrain', { get: () => backpressured })
      socket.write = function (...args) {
        backpressured = true
        return write.apply(this, args)
      }
      socket.once('connect', () => callback(null, socket))
      socket.once('error', (err) => callback(err, null))
      return socket
    }
  })
  t.after(() => client.destroy())

  const body = await echo(client, (async function * () {
    // Let dispatch arm the parser's headers timer before advancing it.
    await new Promise((resolve) => setImmediate(resolve))
    timers.tick(800)
    yield 'first,'
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(backpressured, true)
    timers.tick(300)
    assert.strictEqual(socket.destroyed, false, 'progress must restart the headers timeout')
    backpressured = false
    yield 'second'
  })())
  assert.strictEqual(body.toString(), 'first,second')
})

test('large request headers do not create oversized connection slabs', async (t) => {
  const server = createServer({ maxHeaderSize: 128 * 1024 }, (req, res) => {
    req.resume()
    req.on('end', () => res.end('ok'))
  })
  server.listen(0)
  await once(server, 'listening')
  t.after(() => server.close())

  const slabs = []
  // A passthrough chunk can belong to the caller's larger Buffer pool. Only
  // check buffers allocated by the coalescing writer itself.
  const bodyChunk = Buffer.from('small body')
  const client = new Client(`http://localhost:${server.address().port}`, {
    connect (opts, callback) {
      const socket = net.connect(Number(opts.port), opts.hostname)
      const write = socket.write
      socket.write = function (chunk, ...args) {
        if (Buffer.isBuffer(chunk) && chunk !== bodyChunk) slabs.push(chunk.buffer)
        return write.call(this, chunk, ...args)
      }
      socket.once('connect', () => callback(null, socket))
      socket.once('error', (err) => callback(err, null))
      return socket
    }
  })
  t.after(() => client.destroy())

  const body = (function * () { yield bodyChunk })()
  assert.strictEqual((await echo(client, body, { 'x-large': 'x'.repeat(70 * 1024) })).toString(), 'ok')
  assert.strictEqual((await echo(client, (function * () { yield 'next request' })())).toString(), 'ok')
  assert.ok(slabs.length > 0)
  assert.ok(slabs.every((slab) => slab.byteLength <= 64 * 1024), 'connection slabs must stay within 64 KiB')
})
