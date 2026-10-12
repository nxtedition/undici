'use strict'

const assert = require('node:assert')
const { test } = require('node:test')
const { once } = require('node:events')
const net = require('node:net')
const { createServer } = require('node:http')
const { Readable } = require('node:stream')
const { Client } = require('..')

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
