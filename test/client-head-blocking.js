'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { test } = require('node:test')
const { setImmediate: waitImmediate } = require('node:timers/promises')
const { Agent, Client, Pool } = require('..')

async function deadline (promise) {
  const { promise: expired, reject } = Promise.withResolvers()
  const timer = setTimeout(() => reject(new Error('request did not complete within 2 seconds')), 2000)
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

async function fixture (t, Dispatcher, handler, pipelining = 1) {
  const sockets = new Set()
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req)
    handler(req, res)
  })
  server.keepAliveTimeout = 60000
  server.on('connection', socket => sockets.add(socket))
  await once(server.listen(0, '127.0.0.1'), 'listening')

  const origin = `http://127.0.0.1:${server.address().port}`
  const options = { connections: 1, pipelining }
  const dispatcher = Dispatcher === Agent ? new Agent(options) : new Dispatcher(origin, options)
  t.after(async () => {
    await dispatcher.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return { dispatcher, origin, requests, sockets }
}

for (const Dispatcher of [Agent, Client, Pool]) {
  test(`blocking HEAD releases a reusable ${Dispatcher.name} connection`, async (t) => {
    const { dispatcher, origin, requests, sockets } = await fixture(t, Dispatcher, (req, res) => {
      res.setHeader('content-length', '3')
      res.end(req.method === 'HEAD' ? undefined : 'get')
    })

    for (const method of ['HEAD', 'GET']) {
      const response = await deadline(dispatcher.request({
        origin, path: '/', method, blocking: true, reset: false
      }))
      assert.strictEqual(response.statusCode, 200)
      assert.strictEqual(await deadline(response.body.text()), method === 'HEAD' ? '' : 'get')
    }
    assert.deepStrictEqual(requests.map(req => req.method), ['HEAD', 'GET'])
    assert.strictEqual(sockets.size, 1)
    assert.strictEqual(requests[0].socket, requests[1].socket)
  })
}

for (const close of ['default HEAD reset', 'peer Connection: close']) {
  test(`blocking HEAD preserves ${close}`, async (t) => {
    const { dispatcher, origin, sockets } = await fixture(t, Agent, (req, res) => {
      if (req.method === 'HEAD' && close === 'peer Connection: close') {
        res.setHeader('connection', 'close')
      }
      res.end(req.method === 'HEAD' ? undefined : 'get')
    })
    const head = await deadline(dispatcher.request({
      origin,
      path: '/',
      method: 'HEAD',
      blocking: true,
      reset: close === 'default HEAD reset' ? undefined : false
    }))
    assert.strictEqual(await deadline(head.body.text()), '')
    const get = await deadline(dispatcher.request({ origin, path: '/', method: 'GET' }))
    assert.strictEqual(await deadline(get.body.text()), 'get')
    assert.strictEqual(sockets.size, 2)
  })
}

function dispatch (dispatcher, options, callbacks = {}) {
  return new Promise((resolve, reject) => {
    dispatcher.dispatch(options, {
      onConnect () { callbacks.onConnect?.() },
      onHeaders (statusCode) {
        callbacks.onHeaders?.(statusCode)
        return true
      },
      onData () { return true },
      onComplete () { resolve() },
      onError: reject
    })
  })
}

for (const [method, blocking, reentrant] of [
  ['HEAD', true, true],
  ['HEAD', false, true],
  ['GET', false, true],
  ['HEAD', false, false],
  ['GET', false, false]
]) {
  test(`${reentrant ? 'reentrant' : 'pipelined'} ${blocking ? 'blocking' : 'nonblocking'} ${method} preserves the next HEAD blocking`, async (t) => {
    const informational = Promise.withResolvers()
    const admitted = []
    let secondResponse
    const { dispatcher, origin, requests, sockets } = await fixture(t, Client, (req, res) => {
      if (req.url === '/second') {
        secondResponse = res
        res.writeEarlyHints({ link: '</style.css>; rel=preload' })
      } else {
        res.end()
      }
    }, 3)

    let second
    let get
    function queueRemaining () {
      second = dispatch(dispatcher, {
        origin, path: '/second', method: 'HEAD', blocking: true, reset: false
      }, {
        onConnect () { admitted.push('second') },
        onHeaders (statusCode) {
          if (statusCode === 103) informational.resolve()
        }
      })
      get = dispatch(dispatcher, { origin, path: '/get', method: 'GET', blocking: true }, {
        onConnect () { admitted.push('get') }
      })
      second.catch(informational.reject)
      get.catch(informational.reject)
    }
    const first = dispatch(dispatcher, {
      origin, path: '/first', method, blocking, reset: false
    }, {
      onConnect () { admitted.push('first') },
      onHeaders (statusCode) {
        assert.strictEqual(statusCode, 200)
        if (reentrant) queueRemaining()
      }
    })
    first.catch(informational.reject)
    if (!reentrant) queueRemaining()

    await deadline(informational.promise)
    await waitImmediate()
    assert.deepStrictEqual(admitted, ['first', 'second'])
    secondResponse.end()
    await deadline(Promise.all([first, second, get]))
    assert.deepStrictEqual(admitted, ['first', 'second', 'get'])
    assert.deepStrictEqual(requests.map(req => req.url), ['/first', '/second', '/get'])
    assert.strictEqual(sockets.size, 1)
  })
}
