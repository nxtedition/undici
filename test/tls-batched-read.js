'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const net = require('node:net')
const tls = require('node:tls')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { once } = require('node:events')
const { Client, buildConnector } = require('..')

const key = readFileSync(join(__dirname, 'fixtures', 'key.pem'), 'utf8')
const cert = readFileSync(join(__dirname, 'fixtures', 'cert.pem'), 'utf8')
const ca = readFileSync(join(__dirname, 'fixtures', 'ca.pem'), 'utf8')

const RECORD_SIZE = 1024

function body (records) {
  const buf = Buffer.allocUnsafe(records * RECORD_SIZE)
  for (let i = 0; i < records; i++) {
    buf.fill(i & 0xff, i * RECORD_SIZE, (i + 1) * RECORD_SIZE)
  }
  return buf
}

// The client reads TLS sockets from the default connector through onread
// (SocketReader); a connector that drops onread leaves it reading the socket's
// Readable side. Each test using startServer runs in both modes.
const MODES = ['onread', 'readable']

function testModes (name, fn) {
  for (const mode of MODES) {
    test(`${name} (${mode})`, (t) => fn(t, mode))
  }
}

// Fails the socket with readError once its first bytes were received, as soon
// as the client could otherwise read them (or, with afterRead, after it did).
function failSocket (socket, readError, buffered) {
  readError.buffered = buffered
  const fail = () => socket.destroy(readError.error || Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }))
  if (readError.afterRead) {
    setImmediate(() => setImmediate(fail))
  } else {
    fail()
  }
}

// Answers the first request with `head` + `data` in 1 KiB TLS records, written
// at once so they reach the client together, and optionally resets the
// connection (RST) as soon as the kernel has the last byte.
async function startServer (t, { mode, head, data, reset = false, readError, connectOptions, ...options }) {
  assert.ok(MODES.includes(mode))
  const server = net.createServer((raw) => {
    const socket = new tls.TLSSocket(raw, { isServer: true, key, cert })
    socket.on('error', () => {})
    socket.once('data', () => {
      assert.ok(socket.setMaxSendFragment(RECORD_SIZE))
      socket.write(Buffer.concat([Buffer.from(head), data]), () => {
        if (reset) {
          raw.resetAndDestroy()
        }
      })
    })
  })
  server.listen(0)
  await once(server, 'listening')
  t.after(() => server.close())

  const connector = buildConnector({ ca, servername: 'agent1', ...connectOptions })
  const client = new Client(`https://localhost:${server.address().port}`, {
    ...options,
    connect (opts, callback) {
      assert.ok(opts.onread)
      if (mode === 'readable') {
        opts = { ...opts, onread: undefined }
      } else if (readError) {
        // Like the Readable side's 'readable' event, act on the next tick.
        const { buffer, callback: onRead } = opts.onread
        let received = 0
        opts = {
          ...opts,
          onread: {
            buffer,
            callback (nread, buf) {
              if (received === 0) {
                process.nextTick(() => failSocket(this, readError, received))
              }
              received += nread
              return onRead.call(this, nread, buf)
            }
          }
        }
      }
      connector(opts, (err, socket) => {
        if (readError && mode === 'readable') {
          socket?.on('readable', function onReadable () {
            if (this.readableLength > 0) {
              this.off('readable', onReadable)
              failSocket(this, readError, this.readableLength)
            }
          })
        }
        callback(err, socket)
      })
    }
  })
  t.after(() => client.destroy())

  return client
}

async function readChunks (body) {
  const chunks = []
  for await (const chunk of body) {
    chunks.push(chunk)
  }
  return chunks
}

testModes('TLS records that arrive together are parsed and delivered as one chunk', async (t, mode) => {
  const data = body(256)
  const client = await startServer(t, {
    mode,
    head: `HTTP/1.1 200 OK\r\ncontent-length: ${data.length}\r\n\r\n`,
    data
  })

  const { statusCode, body: res } = await client.request({ path: '/', method: 'GET' })
  const chunks = await readChunks(res)

  assert.strictEqual(statusCode, 200)
  assert.deepStrictEqual(Buffer.concat(chunks), data)
  // One chunk per 1 KiB record without batching; a handful with it.
  assert.ok(chunks.length <= 32, `${chunks.length} chunks for 256 records`)
})

testModes('a close-delimited body is complete when the peer resets right after it', async (t, mode) => {
  const data = body(64)
  const client = await startServer(t, {
    mode,
    head: 'HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n',
    data,
    reset: true
  })

  const { statusCode, body: res } = await client.request({ path: '/', method: 'GET' })
  const chunks = await readChunks(res)

  assert.strictEqual(statusCode, 200)
  assert.deepStrictEqual(Buffer.concat(chunks), data)
})

testModes('a content-length body is complete when the peer resets right after it', async (t, mode) => {
  const data = body(64)
  const client = await startServer(t, {
    mode,
    head: `HTTP/1.1 200 OK\r\nconnection: close\r\ncontent-length: ${data.length}\r\n\r\n`,
    data,
    reset: true
  })

  const { statusCode, body: res } = await client.request({ path: '/', method: 'GET' })
  const chunks = await readChunks(res)

  assert.strictEqual(statusCode, 200)
  assert.deepStrictEqual(Buffer.concat(chunks), data)
})

for (const highWaterMark of [undefined, 32 * 1024]) {
  test(`TLS sockets preserve ${highWaterMark == null ? 'default' : 'custom'} read and write highWaterMarks`, async (t) => {
    const server = tls.createServer({ key, cert }, (socket) => socket.end())
    server.listen(0)
    await once(server, 'listening')
    t.after(() => server.close())

    const connector = buildConnector({ ca, servername: 'agent1', ...(highWaterMark == null ? {} : { highWaterMark }) })
    const socket = await new Promise((resolve, reject) => {
      connector({ hostname: 'localhost', host: 'localhost', protocol: 'https:', port: server.address().port }, (err, socket) => {
        if (err) reject(err)
        else resolve(socket)
      })
    })
    t.after(() => socket.destroy())

    assert.strictEqual(socket.readableHighWaterMark, highWaterMark ?? 256 * 1024)
    assert.strictEqual(socket.writableHighWaterMark, highWaterMark ?? 16 * 1024)
  })
}

testModes('bytes buffered before a socket read error are still parsed', async (t, mode) => {
  const data = body(64)
  const head = 'HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n'
  // Fail the socket with a read error as soon as the first record is buffered,
  // while the client's deferred read is still pending: the error must not drop
  // the bytes that arrived before it.
  const readError = {}
  const client = await startServer(t, { mode, head, data, readError })

  const { statusCode, body: res } = await client.request({ path: '/', method: 'GET' })
  const chunks = await readChunks(res)

  assert.ok(readError.buffered > head.length, `${readError.buffered} bytes buffered`)
  assert.strictEqual(statusCode, 200)
  assert.deepStrictEqual(Buffer.concat(chunks), data.subarray(0, readError.buffered - head.length))
})

testModes('a local socket error does not drain a buffered response', async (t, mode) => {
  const error = new Error('local abort')
  const client = await startServer(t, {
    mode,
    head: 'HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n',
    data: Buffer.from('body'),
    readError: { error }
  })

  await assert.rejects(client.request({ path: '/', method: 'GET' }), (err) => err === error)
})

testModes('a complete keep-alive chunked response survives a buffered read error', async (t, mode) => {
  const client = await startServer(t, {
    mode,
    head: 'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n',
    data: Buffer.from('2\r\nok\r\n0\r\n\r\n'),
    readError: {}
  })

  const { body: res } = await client.request({ path: '/', method: 'GET' })
  assert.strictEqual(await res.text(), 'ok')
})

testModes('a successful response drain reconnects requests queued behind it', async (t, mode) => {
  const client = await startServer(t, {
    mode,
    head: 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n',
    data: Buffer.from('ok'),
    readError: {}
  })

  const responses = await Promise.all([
    client.request({ path: '/first', method: 'GET' }),
    client.request({ path: '/second', method: 'GET' })
  ])
  assert.deepStrictEqual(await Promise.all(responses.map(({ body: res }) => res.text())), ['ok', 'ok'])
})

testModes('a response size limit still errors while draining a buffered read error', async (t, mode) => {
  const client = await startServer(t, {
    mode,
    head: 'HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n',
    data: Buffer.from('too big'),
    readError: {},
    maxResponseSize: 2
  })

  const { body: res } = await client.request({ path: '/', method: 'GET' })
  await assert.rejects(res.text(), { code: 'UND_ERR_RES_EXCEEDED_MAX_SIZE' })
})

testModes('a header size limit still errors while draining a buffered read error', async (t, mode) => {
  const client = await startServer(t, {
    mode,
    head: `HTTP/1.1 200 OK\r\nx-long: ${'x'.repeat(128)}\r\nconnection: close\r\n\r\n`,
    data: Buffer.from('body'),
    readError: {},
    maxHeaderSize: 64
  })

  await assert.rejects(client.request({ path: '/', method: 'GET' }), { code: 'UND_ERR_HEADERS_OVERFLOW' })
})

testModes('an oversized trailer cannot complete a response during reset draining', async (t, mode) => {
  const client = await startServer(t, {
    mode,
    head: 'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n',
    data: Buffer.from(`2\r\nok\r\n0\r\nx-long: ${'x'.repeat(128)}\r\n\r\n`),
    readError: {},
    maxHeaderSize: 64
  })

  const { body: res } = await client.request({ path: '/', method: 'GET' })
  await assert.rejects(res.text(), { code: 'UND_ERR_HEADERS_OVERFLOW' })
})

for (const afterRead of [false, true]) {
  for (const framing of ['content-length', 'chunked', 'close']) {
    testModes(`a ${framing} response paused ${afterRead ? 'before' : 'during'} a read error preserves buffered bytes`, async (t, mode) => {
      const data = Buffer.from('body')
      const client = await startServer(t, {
        mode,
        head: 'HTTP/1.1 200 OK\r\n' + (framing === 'content-length'
          ? `content-length: ${data.length}\r\n\r\n`
          : framing === 'chunked' ? 'transfer-encoding: chunked\r\n\r\n' : 'connection: close\r\n\r\n'),
        data: framing === 'chunked' ? Buffer.from('4\r\nbody\r\n0\r\n\r\n') : data,
        readError: { afterRead }
      })
      const chunks = []
      await new Promise((resolve, reject) => {
        client.dispatch({ path: '/', method: 'GET' }, {
          onConnect () {},
          onHeaders () { return false },
          onData (chunk) {
            chunks.push(chunk)
            return false
          },
          onComplete () { resolve() },
          onError (err) { reject(err) }
        })
      })
      assert.deepStrictEqual(Buffer.concat(chunks), data)
    })
  }
}

for (const framing of ['content-length', 'chunked']) {
  testModes(`an incomplete ${framing} response still fails after a buffered read error`, async (t, mode) => {
    const client = await startServer(t, {
      mode,
      head: 'HTTP/1.1 200 OK\r\nconnection: close\r\n' + (framing === 'content-length'
        ? 'content-length: 8\r\n\r\n'
        : 'transfer-encoding: chunked\r\n\r\n'),
      data: Buffer.from(framing === 'content-length' ? 'body' : '4\r\nbody'),
      readError: {}
    })

    const { body: res } = await client.request({ path: '/', method: 'GET' })
    await assert.rejects(res.text(), { code: framing === 'content-length' ? 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' : 'HPE_INVALID_EOF_STATE' })
  })
}

for (const framing of ['content-length', 'chunked', 'close']) {
  testModes(`a paused ${framing} response drains bytes beyond the capped batch`, async (t, mode) => {
    const data = Buffer.alloc(800, 0x61)
    const readError = {}
    const client = await startServer(t, {
      mode,
      head: 'HTTP/1.1 200 OK\r\n' + (framing === 'content-length'
        ? `content-length: ${data.length}\r\n\r\n`
        : framing === 'chunked' ? 'transfer-encoding: chunked\r\n\r\n' : 'connection: close\r\n\r\n'),
      data: framing === 'chunked'
        ? Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from('\r\n0\r\n\r\n')])
        : data,
      readError,
      connectOptions: { highWaterMark: 128 }
    })

    const { body: res } = await client.request({ path: '/', method: 'GET', highWaterMark: 1 })
    assert.ok(readError.buffered > 128)
    assert.deepStrictEqual(Buffer.concat(await readChunks(res)), data)
  })
}

for (const method of ['GET', 'CONNECT']) {
  testModes(`a destroyed socket cannot be handed off for ${method}`, async (t, mode) => {
    const client = await startServer(t, {
      mode,
      head: method === 'CONNECT' ? 'HTTP/1.1 200 OK\r\n\r\n' : 'HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: test\r\n\r\n',
      data: Buffer.from('upgraded data'),
      readError: {}
    })

    await assert.rejects(new Promise((resolve, reject) => {
      client.dispatch({ path: '/', method, ...(method === 'GET' ? { upgrade: 'test' } : {}) }, {
        onConnect () {},
        onUpgrade () { resolve() },
        onError (err) { reject(err) }
      })
    }), { code: 'ECONNRESET' })
  })
}

testModes('a handler failure while draining a buffered read error does not complete the response', async (t, mode) => {
  const client = await startServer(t, {
    mode,
    head: 'HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n',
    data: Buffer.from('body'),
    readError: {}
  })
  const failure = new Error('handler failed')

  await new Promise((resolve, reject) => {
    client.dispatch({ path: '/', method: 'GET' }, {
      onConnect () {},
      onHeaders () {},
      onData () { throw failure },
      onComplete () { reject(new Error('aborted response completed')) },
      onError (err) {
        assert.strictEqual(err, failure)
        resolve()
      }
    })
  })
})
