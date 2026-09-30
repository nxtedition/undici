'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { once } = require('node:events')
const net = require('node:net')
const { Duplex } = require('node:stream')
const { Client, errors } = require('..')

// Answers every request on a connection with `onRequest(index)`.
async function serve (t, onRequest) {
  const sockets = new Set()
  let connections = 0
  const server = net.createServer((socket) => {
    connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffered = ''
    let index = 0
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1')
      let end
      while ((end = buffered.indexOf('\r\n\r\n')) !== -1) {
        buffered = buffered.slice(end + 4)
        onRequest(socket, index++)
      }
    })
  })
  t.after(() => {
    for (const socket of sockets) {
      socket.destroy()
    }
    server.close()
  })
  server.listen(0)
  await once(server, 'listening')
  return {
    origin: `http://localhost:${server.address().port}`,
    get connections () {
      return connections
    }
  }
}

// Answers the first request with the given chunks, one per read.
function connectChunks (chunks, { end = false } = {}) {
  return (opts, callback) => {
    let written = false
    const socket = new Duplex({
      read () {},
      write (chunk, encoding, cb) {
        cb()
        if (written) {
          return
        }
        written = true
        let i = 0
        const push = () => {
          if (i < chunks.length) {
            socket.push(chunks[i++])
            setImmediate(push)
          } else if (end) {
            socket.push(null)
          }
        }
        push()
      }
    })
    process.nextTick(callback, null, socket)
  }
}

async function requestError (t, response) {
  const { origin } = await serve(t, (socket) => socket.end(response))
  const client = new Client(origin)
  t.after(() => client.destroy())
  return client.request({ method: 'GET', path: '/' })
    .then(({ body }) => body.text())
    .then(() => null, (err) => err)
}

const long = 'a'.repeat(20)

// The SIMD build of milo 0.8.0 accepts these, see build/README.md.
for (const [name, response] of [
  ['a bare LF in a header value', `HTTP/1.1 200 OK\r\nX-Long: ${long}\n${long}\r\nContent-Length: 0\r\n\r\n`],
  ['a NUL in a header value', `HTTP/1.1 200 OK\r\nX-Long: ${long}\0${long}\r\nContent-Length: 0\r\n\r\n`],
  ['a DEL in a header value', `HTTP/1.1 200 OK\r\nX-Long: ${long}\x7f${long}\r\nContent-Length: 0\r\n\r\n`],
  ['a bare LF in the reason phrase', `HTTP/1.1 200 ${long}\n${long}\r\nContent-Length: 0\r\n\r\n`],
  [
    'a NUL in a trailer value',
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\nX-Long: ${long}\0${long}\r\n\r\n`
  ]
]) {
  test(`rejects ${name} past the first 16 bytes`, async (t) => {
    const err = await requestError(t, response)
    assert.ok(err instanceof errors.HTTPParserError, `expected an HTTPParserError, got ${err}`)
    assert.strictEqual(err.code, 'HPE_UNEXPECTED_CHARACTER')
  })
}

test('field values lose all surrounding whitespace', async (t) => {
  // milo 0.8.0 drops only one leading SP from a value that does not end in
  // whitespace.
  const { origin } = await serve(t, (socket) => {
    socket.end([
      'HTTP/1.1 200 OK',
      'X-Spaces:  two',
      'X-Tab: \tspace-tab',
      'X-Both: \t both \t',
      'Transfer-Encoding: chunked',
      '',
      '0',
      'X-Trailer:  \ttrailer',
      '',
      ''
    ].join('\r\n'))
  })
  const client = new Client(origin)
  t.after(() => client.destroy())

  const { headers, body, trailers } = await client.request({ method: 'GET', path: '/' })
  assert.strictEqual(headers['x-spaces'], 'two')
  assert.strictEqual(headers['x-tab'], 'space-tab')
  assert.strictEqual(headers['x-both'], 'both')
  await body.text()
  assert.strictEqual(trailers['x-trailer'], 'trailer')
})

test('rejects an HTTP/1.0 response', async (t) => {
  const err = await requestError(t, 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok')
  assert.ok(err instanceof errors.HTTPParserError)
  assert.strictEqual(err.code, 'HPE_UNSUPPORTED_HTTP_VERSION')
})

test('rejects a status code below 100', async (t) => {
  const err = await requestError(t, 'HTTP/1.1 099 Low\r\nContent-Length: 0\r\n\r\n')
  assert.ok(err instanceof errors.HTTPParserError)
  assert.strictEqual(err.code, 'HPE_INVALID_STATUS')
})

for (const [name, header, code] of [
  ['Upgrade without Connection: upgrade', 'Upgrade: h2c', 'HPE_MISSING_CONNECTION_UPGRADE'],
  ['Trailer without chunked encoding', 'Trailer: X-Checksum', 'HPE_UNEXPECTED_TRAILERS']
]) {
  test(`${name} fails the request, not its body`, async (t) => {
    const { origin } = await serve(t, (socket) => {
      socket.end(`HTTP/1.1 200 OK\r\n${header}\r\nContent-Length: 2\r\n\r\nok`)
    })
    const client = new Client(origin)
    t.after(() => client.destroy())

    await assert.rejects(client.request({ method: 'GET', path: '/' }), { name: 'HTTPParserError', code })
  })
}

test('empty lines between responses do not end a keep-alive connection', async (t) => {
  const server = await serve(t, (socket, index) => {
    socket.write(`HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n${index}\r\n\r\n`)
  })
  const client = new Client(server.origin)
  t.after(() => client.close())

  for (let i = 0; i < 3; i++) {
    const { body } = await client.request({ method: 'GET', path: '/' })
    assert.strictEqual(await body.text(), String(i))
  }
  assert.strictEqual(server.connections, 1)
})

test('a Content-Length response completes before the bytes after it are parsed', async (t) => {
  const { origin } = await serve(t, (socket) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokHTTP/9.9 garbage\r\n\r\n')
  })
  const client = new Client(origin)
  t.after(() => client.destroy())

  const disconnected = once(client, 'disconnect')
  const { body } = await client.request({ method: 'GET', path: '/' })
  assert.strictEqual(await body.text(), 'ok')
  const [, , err] = await disconnected
  assert.ok(err instanceof errors.HTTPParserError || err instanceof errors.SocketError, `unexpected ${err}`)
})

test('a response without a body completes before the bytes after it are parsed', async (t) => {
  const { origin } = await serve(t, (socket) => {
    socket.write('HTTP/1.1 204 No Content\r\n\r\n\x00garbage')
  })
  const client = new Client(origin)
  t.after(() => client.destroy())

  const { statusCode, body } = await client.request({ method: 'GET', path: '/' })
  assert.strictEqual(statusCode, 204)
  assert.strictEqual(await body.text(), '')
})

test('Upgrade on a response other than 101 does not switch protocols', async (t) => {
  const { origin } = await serve(t, (socket) => {
    socket.write('HTTP/1.1 200 OK\r\nConnection: upgrade\r\nUpgrade: h2c\r\nContent-Length: 2\r\n\r\nok')
  })
  const client = new Client(origin)
  t.after(() => client.destroy())

  const { statusCode, headers, body } = await client.request({ method: 'GET', path: '/' })
  assert.strictEqual(statusCode, 200)
  assert.strictEqual(headers.upgrade, 'h2c')
  assert.strictEqual(await body.text(), 'ok')
})

test('a body delimited by EOF completes without Connection: close', async (t) => {
  const { origin } = await serve(t, (socket) => {
    socket.write('HTTP/1.1 200 OK\r\n\r\nhel')
    setTimeout(() => socket.end('lo'), 10)
  })
  const client = new Client(origin)
  t.after(() => client.destroy())

  const { body } = await client.request({ method: 'GET', path: '/' })
  assert.strictEqual(await body.text(), 'hello')
})

test('an incomplete header line longer than maxHeaderSize overflows', async (t) => {
  const client = new Client('http://localhost', {
    maxHeaderSize: 1024,
    connect: connectChunks([`HTTP/1.1 200 OK\r\nX-Long: ${'a'.repeat(2048)}`])
  })
  t.after(() => client.destroy())

  await assert.rejects(client.request({ method: 'GET', path: '/' }), { code: 'UND_ERR_HEADERS_OVERFLOW' })
})

test('a response split across two reads at any offset parses the same', async (t) => {
  const response = Buffer.from([
    'HTTP/1.1 200 OK',
    'Content-Type: text/plain',
    'X-Custom-Header: Value',
    'Transfer-Encoding: chunked',
    'Trailer: X-Checksum',
    '',
    '5;ext=1',
    'hello',
    '6',
    ' world',
    '0',
    'X-Checksum: abc',
    '',
    ''
  ].join('\r\n'), 'latin1')

  for (let i = 1; i < response.length; i++) {
    const client = new Client('http://localhost', {
      connect: connectChunks([response.subarray(0, i), response.subarray(i)])
    })

    try {
      const { statusCode, headers, body, trailers } = await client.request({ method: 'GET', path: '/' })
      assert.strictEqual(statusCode, 200, `split at ${i}`)
      assert.deepStrictEqual({ ...headers }, {
        'content-type': 'text/plain',
        'x-custom-header': 'Value',
        'transfer-encoding': 'chunked',
        trailer: 'X-Checksum'
      }, `split at ${i}`)
      assert.strictEqual(await body.text(), 'hello world', `split at ${i}`)
      assert.deepStrictEqual({ ...trailers }, { 'x-checksum': 'abc' }, `split at ${i}`)
    } finally {
      await client.destroy()
    }
  }
})

test('a Content-Length body split across reads is followed by a pipelined response', async (t) => {
  const client = new Client('http://localhost', {
    pipelining: 2,
    connect: connectChunks([
      'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n01234',
      '56',
      '789HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc'
    ])
  })
  t.after(() => client.destroy())

  const [first, second] = await Promise.all([
    client.request({ method: 'GET', path: '/' }),
    client.request({ method: 'GET', path: '/' })
  ])
  assert.strictEqual(await first.body.text(), '0123456789')
  assert.strictEqual(await second.body.text(), 'abc')
})
