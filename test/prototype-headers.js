'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { promisify } = require('node:util')
const net = require('node:net')
const { Client, Dispatcher } = require('..')

function createRawServer (response) {
  return net.createServer((socket) => {
    socket.once('data', () => {
      socket.end(response)
    })
  })
}

test('request drops a __proto__ response header and keeps other shadowing names', async (t) => {
  const server = createRawServer([
    'HTTP/1.1 200 OK',
    '__proto__: pwned',
    '__PROTO__: repeated',
    'constructor: built-in',
    'content-length: 2',
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
  assert.strictEqual(await body.text(), 'OK')
})

test('request drops a __proto__ response trailer and keeps other shadowing names', async (t) => {
  const server = createRawServer([
    'HTTP/1.1 200 OK',
    'transfer-encoding: chunked',
    'trailer: __proto__, constructor',
    'connection: close',
    '',
    '2',
    'OK',
    '0',
    '__proto__: trailer',
    '__PROTO__: repeated-trailer',
    'constructor: built-in-trailer',
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
})

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
