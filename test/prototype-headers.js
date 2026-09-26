'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { promisify } = require('node:util')
const net = require('node:net')
const { Duplex } = require('node:stream')
const { Client, Dispatcher, errors } = require('..')

function createRawServer (response) {
  return net.createServer((socket) => {
    socket.once('data', () => {
      socket.end(response)
    })
  })
}

// Answers the request with the given chunks, one per read, so llhttp hands
// over any field name or value cut by a chunk boundary in pieces.
function connectChunks (chunks, { end = false } = {}) {
  return (opts, callback) => {
    const socket = new Duplex({
      read () {},
      write (chunk, encoding, cb) {
        cb()
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
    callback(null, socket)
  }
}

function connectBytewise (response, options) {
  return connectChunks(Array.from(response, (byte) => Buffer.from([byte])), options)
}

test('request drops a __proto__ response header and keeps other shadowing names', async (t) => {
  const server = createRawServer([
    'HTTP/1.1 200 OK',
    '__proto__: pwned',
    '__PROTO__: repeated',
    'constructor: built-in',
    'Content-Length: 2',
    'Content-Type: text/Plain',
    'X-Test: First',
    'x-TEST: Second',
    'connection: close',
    '',
    'OK'
  ].join('\r\n'))

  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })

  await promisify(server.listen.bind(server))(0)

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(() => client.close())

  const { statusCode, headers, body } = await client.request({
    path: '/',
    method: 'GET'
  })

  assert.strictEqual(statusCode, 200)
  // `__proto__` is a valid field-name token, so a peer can send one, but it is
  // dropped rather than returned: consumers copying this map into a plain
  // object must not have to guard Object.prototype's setter themselves.
  assert.strictEqual(Object.getOwnPropertyDescriptor(headers, '__proto__'), undefined)
  assert.strictEqual(Object.getPrototypeOf(headers), Object.prototype)
  // Other Object.prototype names are ordinary data properties and are kept.
  assert.strictEqual(Object.getOwnPropertyDescriptor(headers, 'constructor').value, 'built-in')
  assert.ok(Object.keys(headers).every(key => key === key.toLowerCase()))
  assert.strictEqual(headers['content-type'], 'text/Plain')
  assert.deepStrictEqual(headers['x-test'], ['First', 'Second'])
  assert.strictEqual(await body.text(), 'OK')
})

test('request drops a __proto__ response trailer and keeps other shadowing names', async (t) => {
  const server = createRawServer([
    'HTTP/1.1 200 OK',
    'transfer-encoding: chunked',
    'trailer: __proto__, constructor, X-Test',
    'connection: close',
    '',
    '2',
    'OK',
    '0',
    '__proto__: trailer',
    '__PROTO__: repeated-trailer',
    'constructor: built-in-trailer',
    'X-Test: First',
    'x-TEST: Second',
    '',
    ''
  ].join('\r\n'))

  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })

  await promisify(server.listen.bind(server))(0)

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(() => client.close())

  const { statusCode, trailers, body } = await client.request({
    path: '/',
    method: 'GET'
  })

  assert.strictEqual(statusCode, 200)
  assert.strictEqual(await body.text(), 'OK')
  assert.strictEqual(Object.getOwnPropertyDescriptor(trailers, '__proto__'), undefined)
  assert.strictEqual(Object.getPrototypeOf(trailers), Object.prototype)
  assert.strictEqual(Object.getOwnPropertyDescriptor(trailers, 'constructor').value, 'built-in-trailer')
  assert.ok(Object.keys(trailers).every(key => key === key.toLowerCase()))
  assert.deepStrictEqual(trailers['x-test'], ['First', 'Second'])
})

test('dispatch receives lowercase informational headers, final headers and trailers', async (t) => {
  const server = createRawServer([
    'HTTP/1.1 103 Early Hints',
    'X-Hint: First',
    'x-HINT: Second',
    '',
    'HTTP/1.1 200 OK',
    'Transfer-Encoding: chunked',
    'Trailer: X-Trailer',
    'Connection: close',
    'X-Test: First',
    'x-TEST: Second',
    '',
    '2',
    'OK',
    '0',
    'X-Trailer: First',
    'x-TRAILER: Second',
    '',
    ''
  ].join('\r\n'))
  t.after(() => server.close())
  await promisify(server.listen.bind(server))(0)

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(() => client.destroy())
  const sections = []
  const trailers = await new Promise((resolve, reject) => {
    client.dispatch({ path: '/', method: 'GET' }, {
      onConnect () {},
      onHeaders (statusCode, headers) {
        sections.push({ statusCode, headers })
      },
      onData () {},
      onComplete: resolve,
      onError: reject
    })
  })

  assert.deepStrictEqual(sections, [
    { statusCode: 103, headers: { 'x-hint': ['First', 'Second'] } },
    {
      statusCode: 200,
      headers: {
        'transfer-encoding': 'chunked',
        trailer: 'X-Trailer',
        connection: 'close',
        'x-test': ['First', 'Second']
      }
    }
  ])
  assert.deepStrictEqual(trailers, { 'x-trailer': ['First', 'Second'] })
})

for (const method of ['GET', 'CONNECT']) {
  test(`${method} onUpgrade receives a lowercase HeaderMap`, async (t) => {
    const isConnect = method === 'CONNECT'
    const server = createRawServer([
      isConnect ? 'HTTP/1.1 200 Connection Established' : 'HTTP/1.1 101 Switching Protocols',
      ...isConnect ? [] : ['Connection: Upgrade', 'Upgrade: Test'],
      'X-Test: First',
      'x-TEST: Second',
      '',
      ''
    ].join('\r\n'))
    t.after(() => server.close())
    await promisify(server.listen.bind(server))(0)

    const client = new Client(`http://localhost:${server.address().port}`)
    t.after(() => client.destroy())
    const result = await new Promise((resolve, reject) => {
      client.dispatch({ path: '/', method, upgrade: isConnect ? undefined : 'Test' }, {
        onConnect () {},
        onUpgrade (statusCode, headers, socket) {
          socket.destroy()
          resolve({ statusCode, headers })
        },
        onError: reject
      })
    })

    assert.strictEqual(result.statusCode, isConnect ? 200 : 101)
    assert.deepStrictEqual(result.headers, {
      ...isConnect ? {} : { connection: 'Upgrade', upgrade: 'Test' },
      'x-test': ['First', 'Second']
    })
  })
}

test('request drops __proto__ from synthesized trailers', async () => {
  class SyntheticDispatcher extends Dispatcher {
    dispatch (_opts, handler) {
      handler.onConnect(() => {})
      handler.onHeaders(200, {}, () => {})
      handler.onComplete(JSON.parse('{"__proto__":["a","b"],"constructor":"built-in-trailer"}'))
      return true
    }
  }

  const { body, trailers } = await new SyntheticDispatcher().request({
    path: '/',
    method: 'GET'
  })

  assert.strictEqual(await body.text(), '')
  assert.strictEqual(Object.hasOwn(trailers, '__proto__'), false)
  assert.strictEqual(Object.getPrototypeOf(trailers), Object.prototype)
  assert.strictEqual(trailers.constructor, 'built-in-trailer')
})

test('header map is assembled from field lines split across reads', async (t) => {
  const response = Buffer.from([
    'HTTP/1.1 200 OK',
    'X-A: 1',
    'CONTENT-LENGTH: 2',
    'X-Header-Name-Longer-Than-One-Simd-Block: Long Value',
    'x-a: 2',
    'ToString: Str',
    '__Proto__: dropped',
    'X-A: 3',
    '',
    'OK'
  ].join('\r\n'))

  const client = new Client('http://localhost', { connect: connectBytewise(response) })
  t.after(() => client.destroy())

  const { statusCode, headers, body } = await client.request({ path: '/', method: 'GET' })

  assert.strictEqual(statusCode, 200)
  assert.deepStrictEqual(headers, {
    'x-a': ['1', '2', '3'],
    'content-length': '2',
    'x-header-name-longer-than-one-simd-block': 'Long Value',
    tostring: 'Str'
  })
  assert.strictEqual(await body.text(), 'OK')
})

test('a split upper-case Content-Length is tracked for early close', async (t) => {
  const response = Buffer.from([
    'HTTP/1.1 200 OK',
    'CONTENT-LENGTH: 4',
    'Connection: close',
    '',
    'OK'
  ].join('\r\n'))

  const client = new Client('http://localhost', { connect: connectBytewise(response, { end: true }) })
  t.after(() => client.destroy())

  const { body } = await client.request({ path: '/', method: 'GET' })

  await assert.rejects(body.text(), errors.ResponseContentLengthMismatchError)
})

test('a name cut after a well-known prefix is completed by the next read', async (t) => {
  // `Accept` and `Content` are cut where the first is a well-known name and the
  // second is not; the header map must key the whole names.
  const chunks = [
    'HTTP/1.1 200 OK\r\nAccept',
    '-Ranges: bytes\r\nContent',
    '-Type: text/plain\r\nContent-Length: 2\r\nETAG',
    ': "x"\r\n\r\nOK'
  ].map((chunk) => Buffer.from(chunk))

  const client = new Client('http://localhost', { connect: connectChunks(chunks) })
  t.after(() => client.destroy())

  const { headers, body } = await client.request({ path: '/', method: 'GET' })

  assert.deepStrictEqual(headers, {
    'accept-ranges': 'bytes',
    'content-type': 'text/plain',
    'content-length': '2',
    etag: '"x"'
  })
  assert.strictEqual(await body.text(), 'OK')
})
