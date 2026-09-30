'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const net = require('node:net')
const { PassThrough } = require('node:stream')
const { test } = require('node:test')
const { Client } = require('..')
const Request = require('../lib/core/request')

// Adapted from nodejs/undici#5761 for the fork's legacy handler interface.
for (const [method, upgrade, statusCode] of [
  ['CONNECT', undefined, 200],
  ['GET', 'websocket', 101]
]) {
  test(`${method} upgrade completes the request and releases body listeners`, (t) => {
    const body = new PassThrough({ autoDestroy: false })
    t.after(() => body.destroy())
    const onEnd = () => {}
    const onError = () => {}
    body.on('end', onEnd)
    body.on('error', onError)
    const socket = new PassThrough()
    t.after(() => socket.destroy())
    const result = Symbol('result')
    const request = new Request('http://localhost', {
      method,
      path: method === 'CONNECT' ? 'localhost:80' : '/',
      upgrade,
      body
    }, {
      onConnect () {},
      onUpgrade (code, headers, upgradedSocket) {
        assert.equal(code, statusCode)
        assert.deepEqual(headers, { upgrade: 'websocket' })
        assert.equal(upgradedSocket, socket)
        assert.deepEqual(body.listeners('end'), [onEnd])
        assert.deepEqual(body.listeners('error'), [onError])
        return result
      },
      onComplete () { assert.fail('upgrade must not deliver a normal response completion') },
      onError (err) { assert.fail(err) }
    })

    assert.equal(body.listenerCount('end'), 2)
    assert.equal(body.listenerCount('error'), 2)
    assert.equal(request.onUpgrade(statusCode, ['upgrade', 'websocket'], socket), result)
    assert.equal(request.completed, true)
    assert.equal(request.aborted, false)
    assert.equal(body.destroyed, false)
    assert.equal(socket.destroyed, false)
  })

  test(`${method} upgrade handler errors reach onError and destroy the socket`, { timeout: 5000 }, async (t) => {
    const server = net.createServer((socket) => {
      t.after(() => socket.destroy())
      socket.once('data', () => {
        socket.write(method === 'CONNECT'
          ? 'HTTP/1.1 200 Connection Established\r\n\r\n'
          : 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      })
    })
    t.after(() => server.close())
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    const client = new Client(`http://127.0.0.1:${server.address().port}`)
    t.after(() => client.destroy())
    const failure = new Error('upgrade handler failed')
    const requestErrors = []
    const socketErrors = []
    let upgradedSocket

    await new Promise((resolve, reject) => {
      client.dispatch({
        method,
        path: method === 'CONNECT' ? 'localhost:80' : '/',
        upgrade
      }, {
        onConnect () {},
        onUpgrade (code, headers, socket) {
          assert.equal(code, statusCode)
          upgradedSocket = socket
          socket.on('error', (err) => socketErrors.push(err))
          socket.once('close', resolve)
          throw failure
        },
        onComplete () { reject(new Error('unexpected normal response completion')) },
        onError (err) {
          requestErrors.push(err)
          if (err !== failure) reject(err)
        }
      })
    })

    assert.deepEqual(requestErrors, [failure])
    assert.deepEqual(socketErrors, [failure])
    assert.equal(upgradedSocket.destroyed, true)
  })
}

test('an aborted upgrade remains an error terminal', (t) => {
  const body = new PassThrough({ autoDestroy: false })
  t.after(() => body.destroy())
  const failure = new Error('upgrade aborted')
  const errors = []
  let abort
  const request = new Request('http://localhost', {
    method: 'GET', path: '/', upgrade: 'websocket', body
  }, {
    onConnect (callback) { abort = callback },
    onUpgrade () { abort(failure) },
    onError (err) { errors.push(err) }
  })
  request.onConnect((err) => request.onError(err))
  request.onUpgrade(101, [], null)

  assert.deepEqual(errors, [failure])
  assert.equal(request.aborted, true)
  assert.equal(request.completed, false)
  assert.equal(body.listenerCount('end'), 0)
  assert.equal(body.listenerCount('error'), 0)
})

test('a throwing upgrade handler releases body listeners and preserves its error', (t) => {
  const body = new PassThrough({ autoDestroy: false })
  t.after(() => body.destroy())
  const failure = new Error('upgrade handler failed')
  const request = new Request('http://localhost', {
    method: 'GET', path: '/', upgrade: 'websocket', body
  }, {
    onConnect () {},
    onUpgrade () { throw failure },
    onError () { assert.fail('the transport owns the handler error') }
  })

  assert.throws(() => request.onUpgrade(101, [], null), (err) => err === failure)
  assert.equal(request.completed, false)
  assert.equal(body.listenerCount('end'), 0)
  assert.equal(body.listenerCount('error'), 0)
})
