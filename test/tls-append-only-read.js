'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const net = require('node:net')
const tls = require('node:tls')
const https = require('node:https')
const { Duplex } = require('node:stream')
const { Worker } = require('node:worker_threads')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { once } = require('node:events')
const { Client, buildConnector } = require('..')
const { kSocket, kParser } = require('../lib/core/symbols')
const { SocketReader } = require('../lib/dispatcher/client-h1')

const key = readFileSync(join(__dirname, 'fixtures', 'key.pem'), 'utf8')
const cert = readFileSync(join(__dirname, 'fixtures', 'cert.pem'), 'utf8')
const ca = readFileSync(join(__dirname, 'fixtures', 'ca.pem'), 'utf8')

const SLAB_SIZE = 256 * 1024
const MAX_PENDING = 256 * 1024

// Every 4-byte word holds its own offset, so a byte overwritten by a later read
// cannot go unnoticed.
function pattern (size, seed = 0) {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i + 4 <= size; i += 4) {
    buf.writeUInt32LE((i + seed) >>> 0, i)
  }
  buf.fill(seed & 0xff, size - (size % 4))
  return buf
}

// assert.deepStrictEqual takes very long to describe a difference between
// buffers of several MiB.
function assertBytes (chunks, expected) {
  const actual = Buffer.concat(chunks)
  if (!actual.equals(expected)) {
    let i = 0
    while (i < actual.length && i < expected.length && actual[i] === expected[i]) {
      i++
    }
    assert.fail(`${actual.length} bytes received, ${expected.length} expected, first difference at ${i}`)
  }
}

async function startServer (t, onRequest) {
  const server = tls.createServer({ key, cert }, (socket) => {
    socket.on('error', () => {})
    socket.once('data', (request) => onRequest(socket, request))
  })
  server.listen(0)
  await once(server, 'listening')
  t.after(() => server.close())
  return server.address().port
}

// Runs a TLS server in a worker that answers each request 50 ms after receiving
// it, calling respond(socket, index) with the request's index on its
// connection. holdAcrossAnswer() blocks the client's event loop across the
// answer to the next request, so everything the server writes for it,
// including a close_notify, reaches the client in one poll phase, before the
// client's deferred parse can run.
async function startWorkerServer (t, respond) {
  const received = new Int32Array(new SharedArrayBuffer(4))
  const worker = new Worker(`
    const tls = require('node:tls')
    const { parentPort, workerData } = require('node:worker_threads')
    const respond = ${respond}
    const server = tls.createServer({ key: workerData.key, cert: workerData.cert }, (socket) => {
      let requests = 0
      socket.on('error', () => {})
      socket.on('data', () => {
        Atomics.store(workerData.received, 0, 1)
        setTimeout(respond, 50, socket, requests++)
      })
    })
    server.listen(0, () => parentPort.postMessage(server.address().port))
  `, { eval: true, workerData: { key, cert, received } })
  t.after(() => worker.terminate())
  const [port] = await once(worker, 'message')

  // Call right after dispatching: the client writes the request later.
  function holdAcrossAnswer () {
    Atomics.store(received, 0, 0)
    const deadline = Date.now() + 5000
    const poll = () => {
      if (Atomics.load(received, 0) === 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
      } else if (Date.now() < deadline) {
        setImmediate(poll)
      }
    }
    setImmediate(poll)
  }

  return { port, holdAcrossAnswer }
}

// Wraps the default connector to record how many received bytes the client's
// reader had not parsed yet when the socket reported EOF.
function eofProbe () {
  const probe = { pending: -1, connect: null }
  const connector = buildConnector({ ca, servername: 'agent1' })
  probe.connect = (opts, callback) => {
    connector(opts, (err, socket) => {
      socket?.prependListener('readable', function onReadable () {
        const reader = this[kParser]?.reader
        if (this.readableLength === 0 && reader) {
          probe.pending = reader.pending
          // A 'readable' listener would keep an upgraded socket from flowing.
          this.off('readable', onReadable)
        }
      })
      callback(err, socket)
    })
  }
  return probe
}

function newClient (t, port, options) {
  const client = new Client(`https://localhost:${port}`, {
    connect: { ca, servername: 'agent1' },
    ...options
  })
  t.after(() => client.destroy())
  return client
}

// Collects the body chunks exactly as the parser delivers them. onChunk may
// return false to pause; it receives the resume callback.
function dispatch (client, opts, { onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let statusCode = 0
    let headers = null
    let resume = null
    client.dispatch(opts, {
      onConnect () {},
      onHeaders (code, map, resumeFn) {
        statusCode = code
        headers = map
        resume = resumeFn
        return true
      },
      onData (chunk) {
        chunks.push(chunk)
        return onChunk ? onChunk(chunk, resume) : true
      },
      onComplete () {
        resolve({ statusCode, headers, chunks })
      },
      onError: reject
    })
  })
}

function upgrade (client, opts) {
  return new Promise((resolve, reject) => {
    client.dispatch(opts, {
      onConnect () {},
      onUpgrade (statusCode, headers, socket) {
        resolve({ statusCode, headers, socket })
      },
      onError: reject
    })
  })
}

// Reads an upgraded socket until 'end', keeping every 'data' chunk.
async function readUpgraded (socket, onFirst) {
  const chunks = []
  socket.on('data', (chunk) => {
    if (chunks.push(chunk) === 1) {
      onFirst?.()
    }
  })
  await once(socket, 'end')
  return chunks
}

function readerOf (client) {
  return client[kSocket][kParser].reader
}

test('the reader keeps received and unshifted bytes in order across slabs', () => {
  const reader = new SocketReader()
  const socket = {}
  reader.socket = socket
  const input = pattern(2 * SLAB_SIZE + 12345)
  // Pieces that do not divide a slab, so some continue in the next one.
  for (let i = 0; i < input.length; i += 10000) {
    const piece = input.subarray(i, i + 10000)
    reader.onRead(socket, piece.length, piece)
  }
  assert.strictEqual(reader.pending, input.length)
  assert.strictEqual(reader.queue.length, 2, 'two filled slabs are queued')

  // The parser takes the first slab and pauses after 100 bytes.
  const first = reader.read()
  assert.strictEqual(first.length, SLAB_SIZE)
  reader.unshift(first.subarray(100))
  const chunks = [first.subarray(0, 100)]

  // It takes the latest bytes and pauses again before their last 10.
  while (reader.queue.length > 0) {
    chunks.push(reader.read())
  }
  const last = reader.read()
  reader.unshift(last.subarray(last.length - 10))
  assert.strictEqual(reader.queue.length, 0, 'a tail of the slab region moves its start back')
  chunks.push(last.subarray(0, last.length - 10), reader.read())

  assert.strictEqual(reader.read(), null)
  assert.strictEqual(reader.pending, 0)
  assertBytes(chunks, input)
})

test('small TLS records are appended to a slab and parsed in a few batches', async (t) => {
  const data = pattern(256 * 1024)
  const port = await startServer(t, (socket) => {
    assert.ok(socket.setMaxSendFragment(1024))
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${data.length}\r\n\r\n`), data]))
  })
  const client = newClient(t, port)

  let reader = null
  const { statusCode, chunks } = await dispatch(client, { path: '/', method: 'GET' }, {
    onChunk () {
      reader ??= readerOf(client)
      return true
    }
  })

  assert.strictEqual(statusCode, 200)
  assertBytes(chunks, data)
  assert.ok(reader !== null, 'the socket is read through onread')
  // One chunk per 1 KiB record without batching.
  assert.ok(chunks.length <= 32, `${chunks.length} chunks for 256 records`)
  // Chunks are views into slabs, not into a buffer per record or per batch.
  for (const chunk of chunks) {
    assert.ok(chunk.buffer.byteLength >= SLAB_SIZE, `${chunk.buffer.byteLength} byte ArrayBuffer`)
  }
  assert.ok(new Set(chunks.map((chunk) => chunk.buffer)).size <= 2, 'the response fills one slab and starts another')
})

test('delivered body chunks are never overwritten by later reads', async (t) => {
  const first = pattern(4 * 1024 * 1024, 1)
  const second = pattern(1024 * 1024, 2)
  const server = https.createServer({ key, cert }, (req, res) => {
    res.end(req.url === '/first' ? first : second)
  })
  server.keepAliveTimeout = 60e3
  server.listen(0)
  await once(server, 'listening')
  t.after(() => server.close())
  const client = newClient(t, server.address().port)

  const a = await dispatch(client, { path: '/first', method: 'GET' })
  const b = await dispatch(client, { path: '/second', method: 'GET' })

  assertBytes(b.chunks, second)
  // The first response's chunks were retained across both responses' reads.
  assertBytes(a.chunks, first)
  assert.ok(new Set(a.chunks.map((chunk) => chunk.buffer)).size >= 4, 'the response spans several slabs')
  assert.ok(readerOf(client) !== null, 'the socket is read through onread')
})

test('a paused response stops reading the socket and resumes with an exact body', async (t) => {
  const data = pattern(8 * 1024 * 1024)
  const port = await startServer(t, (socket) => {
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${data.length}\r\n\r\n`), data]))
  })
  const client = newClient(t, port)

  const samples = []
  let first = true
  const { chunks } = await dispatch(client, { path: '/', method: 'GET' }, {
    onChunk (chunk, resume) {
      if (first) {
        // Stay paused long enough for the socket to deliver far more than the
        // reader may buffer if it kept reading.
        first = false
        const reader = readerOf(client)
        setTimeout(() => {
          samples.push({ stopped: reader.stopped, pending: reader.pending })
          setTimeout(() => {
            samples.push({ stopped: reader.stopped, pending: reader.pending })
            resume()
          }, 100)
        }, 100)
      } else {
        setImmediate(resume)
      }
      return false
    }
  })

  assertBytes(chunks, data)
  for (const { stopped, pending } of samples) {
    assert.strictEqual(stopped, true)
    // One TCP read worth of TLS records can follow the read that stopped it.
    assert.ok(pending >= MAX_PENDING && pending <= MAX_PENDING + 128 * 1024, `${pending} bytes pending`)
  }
  assert.strictEqual(samples[0].pending, samples[1].pending, 'nothing is read while stopped')
})

for (const framing of ['close', 'content-length']) {
  test(`a ${framing} response that arrives with the FIN is complete`, async (t) => {
    const head = framing === 'close'
      ? 'HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n'
      : 'HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-length: 32768\r\n\r\n'
    const { port, holdAcrossAnswer } = await startWorkerServer(t, `(socket) => {
      socket.setMaxSendFragment(1024)
      socket.end(${JSON.stringify(head)} + 'x'.repeat(32 * 1024))
    }`)
    const probe = eofProbe()
    const client = newClient(t, port, { connect: probe.connect })

    const response = dispatch(client, { path: '/', method: 'GET' })
    holdAcrossAnswer()
    const { statusCode, chunks } = await response

    assert.strictEqual(statusCode, 200)
    assert.strictEqual(Buffer.concat(chunks).toString(), 'x'.repeat(32 * 1024))
    assert.strictEqual(probe.pending, head.length + 32 * 1024, 'the whole response is pending at EOF')
  })
}

test('bytes buffered before a read error are parsed when the whole response is pending', async (t) => {
  const head = 'HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n'
  const size = 32 * 1024
  const { port, holdAcrossAnswer } = await startWorkerServer(t, `(socket) => {
    socket.setMaxSendFragment(1024)
    socket.write(${JSON.stringify(head)} + 'x'.repeat(${size}))
  }`)

  let pendingAtError = -1
  const connector = buildConnector({ ca, servername: 'agent1' })
  const client = newClient(t, port, {
    connect (opts, callback) {
      const { buffer, callback: onRead } = opts.onread
      let received = 0
      connector({
        ...opts,
        onread: {
          buffer,
          callback (nread, buf) {
            received += nread
            if (received === head.length + size) {
              // Fail the socket before the deferred parse runs.
              process.nextTick(() => {
                const reader = this[kParser].reader
                pendingAtError = reader.pending
                this.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }))
              })
            }
            return onRead.call(this, nread, buf)
          }
        }
      }, callback)
    }
  })

  const response = dispatch(client, { path: '/', method: 'GET' })
  holdAcrossAnswer()
  const { statusCode, chunks } = await response

  assert.strictEqual(statusCode, 200)
  assert.strictEqual(Buffer.concat(chunks).toString(), 'x'.repeat(size))
  assert.strictEqual(pendingAtError, head.length + size, 'the whole response is pending at the error')
})

for (const method of ['GET', 'CONNECT']) {
  test(`a ${method} upgrade hands over the bytes after the response and passes later ones through`, async (t) => {
    const late = pattern(2 * 1024 * 1024, 3)
    const port = await startServer(t, (socket) => {
      socket.setMaxSendFragment(1024)
      socket.write((method === 'CONNECT'
        ? 'HTTP/1.1 200 OK\r\n\r\n'
        : 'HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: test\r\n\r\n') + 'early')
      socket.once('data', (ping) => {
        assert.strictEqual(ping.toString(), 'ping')
        socket.end(late)
      })
    })
    const client = newClient(t, port)

    const { statusCode, socket } = await upgrade(client, method === 'CONNECT'
      ? { path: 'localhost:443', method }
      : { path: '/', method, upgrade: 'test' })
    assert.strictEqual(statusCode, method === 'CONNECT' ? 200 : 101)

    const chunks = await readUpgraded(socket, () => socket.write('ping'))

    // Chunks were retained while later ones were read into the same buffers.
    assertBytes(chunks, Buffer.concat([Buffer.from('early'), late]))
  })
}

for (const method of ['GET', 'CONNECT']) {
  for (const mode of ['flowing', 'iterator']) {
    test(`a stopped ${method} upgrade resumes native reads through ${mode}`, async (t) => {
      const earlySize = 512 * 1024
      const lateSize = 64 * 1024
      const head = method === 'CONNECT'
        ? 'HTTP/1.1 200 OK\r\n\r\n'
        : 'HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: test\r\n\r\n'
      const { port } = await startWorkerServer(t, `(socket, index) => {
        const size = index === 0 ? ${earlySize} : ${lateSize}
        const data = Buffer.allocUnsafe(size)
        for (let i = 0; i < size; i += 4) data.writeUInt32LE(i + index, i)
        if (index === 0) {
          socket.write(Buffer.concat([Buffer.from(${JSON.stringify(head)}), data]))
        } else {
          socket.end(data)
        }
      }`)
      const connector = buildConnector({ ca, servername: 'agent1' })
      let stoppedBeforeUpgrade = false
      let heldParser = false
      const client = newClient(t, port, {
        connect (opts, callback) {
          const { buffer, callback: onRead } = opts.onread
          connector({
            ...opts,
            onread: {
              buffer,
              callback (nread, buf) {
                const parser = this[kParser]
                if (!heldParser && parser != null) {
                  heldParser = true
                  const readMore = parser.readMore
                  // Hold parsing until native reads stop, independently of
                  // how many TLS records the platform delivers per poll.
                  parser.readMore = function () {
                    if (this.reader.pending < MAX_PENDING) {
                      return
                    }
                    this.readMore = readMore
                    readMore.call(this)
                  }
                }
                const result = onRead.call(this, nread, buf)
                if (result === false && this[kParser]?.reader?.passThrough === false) {
                  stoppedBeforeUpgrade = true
                }
                return result
              }
            }
          }, callback)
        }
      })

      const upgraded = upgrade(client, method === 'CONNECT'
        ? { path: 'localhost:443', method }
        : { path: '/', method, upgrade: 'test' })
      const { socket } = await upgraded
      assert.strictEqual(stoppedBeforeUpgrade, true, 'native reads stopped before handoff')

      let chunks
      if (mode === 'flowing') {
        chunks = await readUpgraded(socket, () => socket.write('ping'))
      } else {
        chunks = []
        for await (const chunk of socket) {
          if (chunks.push(chunk) === 1) {
            socket.write('ping')
          }
        }
      }
      assertBytes(chunks, Buffer.concat([pattern(earlySize), pattern(lateSize, 1)]))
    })
  }
}

test('an upgrade response that arrives with the FIN still hands over its bytes', async (t) => {
  const head = 'HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: test\r\n\r\n'
  const { port, holdAcrossAnswer } = await startWorkerServer(t, `(socket) => {
    socket.setMaxSendFragment(1024)
    socket.end(${JSON.stringify(head)} + 'x'.repeat(8 * 1024))
  }`)
  const probe = eofProbe()
  const client = newClient(t, port, { connect: probe.connect })

  const upgraded = upgrade(client, { path: '/', method: 'GET', upgrade: 'test' })
  holdAcrossAnswer()
  const { socket } = await upgraded
  const chunks = await readUpgraded(socket)

  assert.strictEqual(Buffer.concat(chunks).toString(), 'x'.repeat(8 * 1024))
  assert.strictEqual(probe.pending, head.length + 8 * 1024, 'the whole response is pending at EOF')
})

// The first response leaves FIRST_ROOM bytes of the first slab, so the head of
// the next answer, which arrives in one burst, sits in a filled slab and the
// rest continues in a new one.
const FIRST_BODY = 200 * 1024
const FIRST_HEAD = `HTTP/1.1 200 OK\r\ncontent-length: ${FIRST_BODY}\r\n\r\n`
const FIRST_ROOM = SLAB_SIZE - FIRST_HEAD.length - FIRST_BODY

test('a response paused in a filled slab resumes in order across slabs', async (t) => {
  const size = 1024 * 1024
  const { port, holdAcrossAnswer } = await startWorkerServer(t, `(socket, index) => {
    if (index === 0) {
      socket.write(${JSON.stringify(FIRST_HEAD)} + 'a'.repeat(${FIRST_BODY}))
    } else {
      const body = Buffer.allocUnsafe(${size})
      for (let i = 0; i < ${size}; i += 4) body.writeUInt32LE(i, i)
      socket.write(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\\r\\ncontent-length: ${size}\\r\\n\\r\\n'), body]))
    }
  }`)
  const client = newClient(t, port)

  const first = await dispatch(client, { path: '/first', method: 'GET' })
  assert.strictEqual(Buffer.concat(first.chunks).length, FIRST_BODY)
  const reader = readerOf(client)
  assert.strictEqual(reader.slab.length - reader.end, FIRST_ROOM)

  let queuedWhilePaused = -1
  const chunks = []
  const second = new Promise((resolve, reject) => {
    client.dispatch({ path: '/second', method: 'GET' }, {
      onConnect () {},
      onHeaders (statusCode, headers, resume) {
        // Pause after the headers, in the middle of the filled slab.
        setImmediate(() => {
          queuedWhilePaused = reader.queue.length
          resume()
        })
        return false
      },
      onData (chunk) {
        chunks.push(chunk)
        return true
      },
      onComplete: resolve,
      onError: reject
    })
  })
  holdAcrossAnswer()
  await second

  assertBytes(chunks, pattern(size))
  assert.ok(queuedWhilePaused >= 1, 'the unparsed bytes of the filled slab were queued')
})

test('a paused close-delimited response that ends across slabs is complete', async (t) => {
  const size = 128 * 1024
  const { port, holdAcrossAnswer } = await startWorkerServer(t, `(socket, index) => {
    if (index === 0) {
      socket.write(${JSON.stringify(FIRST_HEAD)} + 'a'.repeat(${FIRST_BODY}))
    } else {
      const body = Buffer.allocUnsafe(${size})
      for (let i = 0; i < ${size}; i += 4) body.writeUInt32LE(i, i)
      socket.end(Buffer.concat([Buffer.from('HTTP/1.1 200 OK\\r\\nconnection: close\\r\\n\\r\\n'), body]))
    }
  }`)
  const probe = eofProbe()
  const client = newClient(t, port, { connect: probe.connect })

  const first = await dispatch(client, { path: '/first', method: 'GET' })
  assert.strictEqual(Buffer.concat(first.chunks).length, FIRST_BODY)

  const chunks = []
  const second = new Promise((resolve, reject) => {
    client.dispatch({ path: '/second', method: 'GET' }, {
      onConnect () {},
      // Stays paused: the FIN completes the response regardless.
      onHeaders () {
        return false
      },
      onData (chunk) {
        chunks.push(chunk)
        return true
      },
      onComplete: resolve,
      onError: reject
    })
  })
  holdAcrossAnswer()
  await second

  assertBytes(chunks, pattern(size))
  assert.ok(probe.pending > FIRST_ROOM, 'the response continued in a new slab before EOF')
})

test('an upgrade in a filled slab hands over the bytes that follow in order', async (t) => {
  const size = 128 * 1024
  const { port, holdAcrossAnswer } = await startWorkerServer(t, `(socket, index) => {
    if (index === 0) {
      socket.write(${JSON.stringify(FIRST_HEAD)} + 'a'.repeat(${FIRST_BODY}))
    } else if (index === 1) {
      const data = Buffer.allocUnsafe(${size})
      for (let i = 0; i < ${size}; i += 4) data.writeUInt32LE(i, i)
      socket.end(Buffer.concat([Buffer.from('HTTP/1.1 101 Switching Protocols\\r\\nconnection: upgrade\\r\\nupgrade: test\\r\\n\\r\\n'), data]))
    }
  }`)
  const client = newClient(t, port)

  const first = await dispatch(client, { path: '/first', method: 'GET' })
  assert.strictEqual(Buffer.concat(first.chunks).length, FIRST_BODY)
  const reader = readerOf(client)
  assert.strictEqual(reader.slab.length - reader.end, FIRST_ROOM)

  const upgraded = upgrade(client, { path: '/', method: 'GET', upgrade: 'test' })
  holdAcrossAnswer()
  const { socket } = await upgraded
  const chunks = await readUpgraded(socket)

  assertBytes(chunks, pattern(size))
})

test('a connector that drops onread is read through the Readable side', async (t) => {
  const data = pattern(64 * 1024)
  const port = await startServer(t, (socket) => {
    assert.ok(socket.setMaxSendFragment(1024))
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${data.length}\r\n\r\n`), data]))
  })
  const client = newClient(t, port, {
    connect ({ hostname, port }, callback) {
      const socket = tls.connect({ host: hostname, port, ca, servername: 'agent1' })
      socket.once('secureConnect', () => callback(null, socket)).once('error', (err) => callback(err, null))
    }
  })

  const { chunks } = await dispatch(client, { path: '/', method: 'GET' })

  assertBytes(chunks, data)
  assert.strictEqual(readerOf(client), null)
})

test('a connector that gives onread to a socket it wraps in TLS is read through the Readable side', async (t) => {
  const data = pattern(64 * 1024)
  const port = await startServer(t, (socket) => {
    assert.ok(socket.setMaxSendFragment(1024))
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${data.length}\r\n\r\n`), data]))
  })
  const client = newClient(t, port, {
    connect (opts, callback) {
      // The TCP socket adopts onread, but the TLS socket reads its handle.
      const raw = net.connect({ ...opts, host: opts.hostname })
      const socket = tls.connect({ socket: raw, ca, servername: 'agent1' })
      socket.once('secureConnect', () => callback(null, socket)).once('error', (err) => callback(err, null))
    }
  })

  const { chunks } = await dispatch(client, { path: '/', method: 'GET' })

  assertBytes(chunks, data)
  assert.strictEqual(readerOf(client), null)
})

test('a connector can read an intermediate CONNECT handshake before returning TLS', { timeout: 2000 }, async (t) => {
  const data = pattern(64 * 1024)
  const handshake = 'HTTP/1.1 200 Connection Established\r\n\r\n'
  const server = net.createServer((raw) => {
    t.after(() => raw.destroy())
    raw.on('error', () => {})
    raw.once('data', () => {
      raw.write(handshake, () => {
        const socket = new tls.TLSSocket(raw, { isServer: true, key, cert })
        socket.on('error', () => {})
        socket.once('data', () => {
          socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${data.length}\r\n\r\n`), data]))
        })
      })
    })
  })
  server.listen(0)
  await once(server, 'listening')
  t.after(() => server.close())
  const client = newClient(t, server.address().port, {
    connect (opts, callback) {
      const raw = net.connect({ ...opts, host: opts.hostname })
      t.after(() => raw.destroy())
      raw.once('connect', () => raw.write('CONNECT localhost:443 HTTP/1.1\r\n\r\n'))
      raw.once('data', (head) => {
        assert.strictEqual(head.toString(), handshake)
        const socket = tls.connect({ socket: raw, ca, servername: 'agent1' })
        socket.once('secureConnect', () => callback(null, socket)).once('error', (err) => callback(err, null))
      }).once('error', (err) => callback(err, null))
    }
  })

  const { chunks } = await dispatch(client, { path: '/', method: 'GET' })
  assertBytes(chunks, data)
  assert.strictEqual(readerOf(client), null)
})

test('a connector can wrap an onread TLS socket in a different stream', { timeout: 2000 }, async (t) => {
  const data = pattern(64 * 1024)
  const port = await startServer(t, (socket) => {
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${data.length}\r\n\r\n`), data]))
  })
  const client = newClient(t, port, {
    connect (opts, callback) {
      const inner = tls.connect({ ...opts, host: opts.hostname, ca, servername: 'agent1' })
      t.after(() => inner.destroy())
      const socket = new Duplex({
        read () { inner.resume() },
        write (chunk, encoding, done) { inner.write(chunk, encoding, done) },
        destroy (err, done) {
          inner.destroy()
          done(err)
        }
      })
      inner.on('data', (chunk) => {
        if (!socket.push(chunk)) {
          inner.pause()
        }
      }).on('end', () => socket.push(null)).on('error', (err) => socket.destroy(err))
      inner.once('secureConnect', () => callback(null, socket))
    }
  })

  const { chunks } = await dispatch(client, { path: '/', method: 'GET' })
  assertBytes(chunks, data)
  assert.strictEqual(readerOf(client), null)
})

test('keep-alive responses share slabs and an idle socket with unsolicited bytes is not reused', async (t) => {
  let serverSocket = null
  const server = https.createServer({ key, cert }, (req, res) => {
    serverSocket ??= req.socket
    res.end(req.url)
  })
  server.keepAliveTimeout = 60e3
  server.listen(0)
  await once(server, 'listening')
  t.after(() => server.close())
  const client = newClient(t, server.address().port, { keepAliveTimeout: 60e3 })

  const responses = []
  for (let i = 0; i < 50; i++) {
    responses.push(await dispatch(client, { path: `/${i}`, method: 'GET' }))
  }
  assert.deepStrictEqual(responses.map(({ chunks }) => Buffer.concat(chunks).toString()), responses.map((_, i) => `/${i}`))
  assert.ok(new Set(responses.map(({ chunks }) => chunks[0].buffer)).size === 1, 'small responses share a slab')
  assert.ok(readerOf(client) !== null, 'the socket is read through onread')

  const disconnected = once(client, 'disconnect')
  serverSocket.write('HTTP/1.1 200 OK\r\npoison: true\r\ncontent-length: 0\r\n\r\n')
  await disconnected

  const { headers, chunks } = await dispatch(client, { path: '/after', method: 'GET' })
  assert.strictEqual(headers.poison, undefined)
  assert.strictEqual(Buffer.concat(chunks).toString(), '/after')
})
