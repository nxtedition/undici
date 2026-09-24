'use strict'

const { EventEmitter } = require('node:events')
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { Agent, Pool, request } = require('../..')
const net = require('node:net')
const { once } = require('node:events')
const {
  kBusy,
  kConnected,
  kPending,
  kRunning,
  kUrl
} = require('../../lib/core/symbols')

class FakeDispatcher extends EventEmitter {
  constructor (origin) {
    super()
    this[kBusy] = false
    this[kConnected] = 0
    this[kRunning] = 0
    this[kUrl] = new URL(origin)
    this.closed = false
    this.destroyed = false
  }

  dispatch () {
    return true
  }

  close () {
    this.closed = true
    return Promise.resolve()
  }

  destroy () {
    this.destroyed = true
    return Promise.resolve()
  }
}

const handler = {
  onError (err) {
    throw err
  }
}

describe('Agent dispatcher lifecycle', () => {
  for (const eventName of ['disconnect', 'connectionError']) {
    test(`removes an inactive dispatcher after ${eventName}`, async t => {
      const dispatchers = []
      const agent = new Agent({
        factory (origin) {
          const dispatcher = new FakeDispatcher(origin)
          dispatchers.push(dispatcher)
          return dispatcher
        }
      })
      t.after(() => agent.destroy())

      const opts = {
        origin: 'http://example.test',
        path: '/',
        method: 'GET'
      }

      assert.equal(agent.dispatch(opts, handler), true)
      assert.equal(dispatchers.length, 1)

      dispatchers[0].emit(
        eventName,
        new URL(opts.origin),
        [dispatchers[0]],
        new Error(eventName)
      )

      assert.equal(dispatchers[0].closed, true)

      assert.equal(agent.dispatch(opts, handler), true)
      assert.equal(dispatchers.length, 2)
    })
  }

  test('keeps a dispatcher while connected or busy and releases it after drain', async t => {
    const dispatchers = []
    const agent = new Agent({
      factory (origin) {
        const dispatcher = new FakeDispatcher(origin)
        dispatchers.push(dispatcher)
        return dispatcher
      }
    })
    t.after(() => agent.destroy())

    const opts = {
      origin: 'http://example.test',
      path: '/',
      method: 'GET'
    }

    agent.dispatch(opts, handler)

    dispatchers[0][kConnected] = 1
    dispatchers[0].emit(
      'disconnect',
      new URL(opts.origin),
      [dispatchers[0]],
      new Error('one connection closed')
    )

    assert.equal(dispatchers[0].closed, false)

    dispatchers[0][kConnected] = 0
    dispatchers[0][kBusy] = true
    dispatchers[0].emit(
      'connectionError',
      new URL(opts.origin),
      [dispatchers[0]],
      new Error('replacement is pending')
    )

    assert.equal(dispatchers[0].closed, false)
    assert.equal(agent.dispatch(opts, handler), true)
    assert.equal(dispatchers.length, 1)

    dispatchers[0][kBusy] = false
    dispatchers[0].emit('drain', new URL(opts.origin), [dispatchers[0]])

    assert.equal(dispatchers[0].closed, true)
    assert.equal(agent.dispatch(opts, handler), true)
    assert.equal(dispatchers.length, 2)
  })

  test('keeps a dispatcher that still has pending requests', async t => {
    const dispatchers = []
    const agent = new Agent({
      factory (origin) {
        const dispatcher = new FakeDispatcher(origin)
        dispatchers.push(dispatcher)
        return dispatcher
      }
    })
    t.after(() => agent.destroy())

    const opts = {
      origin: 'http://example.test',
      path: '/',
      method: 'GET'
    }

    agent.dispatch(opts, handler)

    // Disconnected and not busy, but requests were requeued for a
    // replacement connection.
    dispatchers[0][kPending] = 1
    dispatchers[0].emit(
      'disconnect',
      new URL(opts.origin),
      [dispatchers[0]],
      new Error('connection closed')
    )

    assert.equal(dispatchers[0].closed, false)
    assert.equal(agent.dispatch(opts, handler), true)
    assert.equal(dispatchers.length, 1)

    dispatchers[0][kPending] = 0
    dispatchers[0].emit('drain', new URL(opts.origin), [dispatchers[0]])

    assert.equal(dispatchers[0].closed, true)
  })

  test('keeps a Pool whose pipelined requests were requeued after connection: close', async t => {
    // The first connection answers only the first of two pipelined requests,
    // with `connection: close`. The second is requeued on the pool's client,
    // which reconnects for it. The Agent must keep that pool rather than close
    // it on 'disconnect' and build a new one for the next request.
    let connections = 0
    const server = net.createServer((socket) => {
      const first = connections++ === 0
      let buf = ''
      let warm = !first
      socket.on('error', () => {})
      socket.on('data', (chunk) => {
        buf += chunk
        if (!warm) {
          warm = true
          buf = ''
          socket.write('HTTP/1.1 200 OK\r\ncontent-length: 1\r\n\r\nw')
          return
        }
        if (first) {
          if (buf.split('\r\n\r\n').length - 1 < 2 || socket.replied) {
            return
          }
          socket.replied = true
          socket.end('HTTP/1.1 200 OK\r\ncontent-length: 1\r\nconnection: close\r\n\r\na')
          return
        }
        while (buf.includes('\r\n\r\n')) {
          buf = buf.slice(buf.indexOf('\r\n\r\n') + 4)
          socket.write('HTTP/1.1 200 OK\r\ncontent-length: 1\r\n\r\nb')
        }
      })
    })
    t.after(() => server.close())
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    const pools = []
    const agent = new Agent({
      pipelining: 10,
      factory (origin, opts) {
        const pool = new Pool(origin, { ...opts, connections: 1 })
        pools.push(pool)
        return pool
      }
    })
    t.after(() => agent.destroy())

    const origin = `http://127.0.0.1:${server.address().port}`
    await agent.request({ origin, path: '/warm', method: 'GET' }).then((r) => r.body.text())
    await new Promise((resolve) => setImmediate(resolve))

    const results = await Promise.all([
      agent.request({ origin, path: '/1', method: 'GET', blocking: false }).then((r) => r.body.text()),
      agent.request({ origin, path: '/2', method: 'GET', blocking: false }).then((r) => r.body.text())
    ])
    assert.deepEqual(results, ['a', 'b'])
    assert.equal(pools[0].closed, false)

    assert.equal(await agent.request({ origin, path: '/3', method: 'GET' }).then((r) => r.body.text()), 'b')
    assert.equal(pools.length, 1)
    assert.equal(connections, 2)
  })

  test('keeps a custom dispatcher without private lifecycle symbols', async t => {
    const dispatchers = []

    class PublicDispatcher extends EventEmitter {
      constructor () {
        super()
        this.closed = false
        this.destroyed = false
        this.dispatchCount = 0
      }

      dispatch () {
        this.dispatchCount++
        return true
      }

      close () {
        this.closed = true
        return Promise.resolve()
      }

      destroy () {
        this.destroyed = true
        return Promise.resolve()
      }
    }

    const agent = new Agent({
      factory () {
        const dispatcher = new PublicDispatcher()
        dispatchers.push(dispatcher)
        return dispatcher
      }
    })
    t.after(() => agent.destroy())

    const opts = {
      origin: 'http://example.test',
      path: '/',
      method: 'GET'
    }

    assert.equal(agent.dispatch(opts, handler), true)
    const dispatcher = dispatchers[0]
    dispatcher.emit('connect', new URL(opts.origin), [dispatcher])
    dispatcher.emit('drain', new URL(opts.origin), [dispatcher])

    assert.equal(dispatcher.closed, false)
    assert.equal(agent.dispatch(opts, handler), true)
    assert.equal(dispatchers.length, 1)
    assert.equal(dispatcher.dispatchCount, 2)

    dispatcher.closed = true
    dispatcher.emit('drain', new URL(opts.origin), [dispatcher])
    assert.equal(agent.dispatch(opts, handler), true)
    assert.equal(dispatchers.length, 2)

    await agent.close()
    assert.equal(dispatchers[1].closed, true)
  })

  test('releases a Pool after a failed connection settles', async t => {
    const dispatchers = []
    const connectError = Object.assign(new Error('connect failed'), {
      code: 'ECONNREFUSED'
    })
    const agent = new Agent({
      connections: 1,
      connect (_opts, callback) {
        queueMicrotask(() => callback(connectError))
      },
      factory (origin, opts) {
        const dispatcher = new Pool(origin, opts)
        dispatchers.push(dispatcher)
        return dispatcher
      }
    })
    t.after(() => agent.destroy())

    await assert.rejects(
      request('http://example.test', { dispatcher: agent }),
      connectError
    )

    for (let i = 0; i < 10 && !dispatchers[0].destroyed; i++) {
      await new Promise(resolve => setImmediate(resolve))
    }

    assert.equal(dispatchers.length, 1)
    assert.equal(dispatchers[0].destroyed, true)
  })
})
