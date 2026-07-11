'use strict'

const { EventEmitter } = require('node:events')
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { Agent, Pool, request } = require('../..')
const {
  kBusy,
  kConnected,
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
