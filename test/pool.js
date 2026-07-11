'use strict'

const assert = require('node:assert')
const { execFile } = require('node:child_process')
const net = require('node:net')
const { join } = require('node:path')
const { tspl } = require('@matteo.collina/tspl')
const { test, after } = require('node:test')
const { EventEmitter } = require('node:events')
const { createServer } = require('node:http')
const { finished, Readable } = require('node:stream')
const { promisify } = require('node:util')
const {
  kBusy,
  kPending,
  kRunning,
  kSize,
  kUrl
} = require('../lib/core/symbols')
const { kClients } = require('../lib/dispatcher/pool-base')
const {
  Client,
  Pool,
  errors
} = require('..')

const execFileAsync = promisify(execFile)

function withTimeout (promise, message) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 10000)
    timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

test('throws when connection is infinite', async (t) => {
  t = tspl(t, { plan: 2 })

  try {
    new Pool(null, { connections: 0 / 0 }) // eslint-disable-line
  } catch (e) {
    t.ok(e instanceof errors.InvalidArgumentError)
    t.strictEqual(e.message, 'invalid connections')
  }
})

test('throws when connections is negative', async (t) => {
  t = tspl(t, { plan: 2 })

  try {
    new Pool(null, { connections: -1 }) // eslint-disable-line no-new
  } catch (e) {
    t.ok(e instanceof errors.InvalidArgumentError)
    t.strictEqual(e.message, 'invalid connections')
  }
})

test('throws when connection is not number', async (t) => {
  t = tspl(t, { plan: 2 })

  try {
    new Pool(null, { connections: true }) // eslint-disable-line no-new
  } catch (e) {
    t.ok(e instanceof errors.InvalidArgumentError)
    t.strictEqual(e.message, 'invalid connections')
  }
})

test('throws when factory is not a function', async (t) => {
  t = tspl(t, { plan: 2 })

  try {
    new Pool(null, { factory: '' }) // eslint-disable-line no-new
  } catch (e) {
    t.ok(e instanceof errors.InvalidArgumentError)
    t.strictEqual(e.message, 'factory must be a function.')
  }
})

test('does not throw when connect is a function', async (t) => {
  t = tspl(t, { plan: 1 })

  t.doesNotThrow(() => new Pool('http://localhost', { connect: () => {} }))
})

test('rejects a non-string socketPath with built-in and custom connectors', () => {
  for (const connect of [undefined, () => {}]) {
    assert.throws(
      () => new Pool('http://localhost', { socketPath: 123, connect }),
      {
        name: 'InvalidArgumentError',
        code: 'UND_ERR_INVALID_ARG',
        message: 'invalid socketPath'
      }
    )
  }
})

test('passes socketPath to a custom connect function', async (t) => {
  const connectError = new Error('custom connect error')
  const socketPath = '/var/run/test.sock'
  let receivedSocketPath
  let receivedThis

  const pool = new Pool('http://localhost', {
    socketPath,
    connect (opts, callback) {
      receivedSocketPath = opts.socketPath
      receivedThis = this
      callback(connectError, null)
    }
  })
  t.after(() => pool.close())

  const err = await new Promise((resolve) => {
    pool.request({ path: '/', method: 'GET' }, resolve)
  })

  assert.strictEqual(err, connectError)
  assert.strictEqual(receivedSocketPath, socketPath)
  assert.ok(receivedThis instanceof Client)
})

test('throws when allowH2 is enabled (HTTP/1.1 only build)', async (t) => {
  t = tspl(t, { plan: 3 })

  try {
    new Pool('http://localhost', { allowH2: true }) // eslint-disable-line no-new
  } catch (e) {
    t.ok(e instanceof errors.InvalidArgumentError)
    t.strictEqual(e.message, 'unsupported allowH2, this build only supports HTTP/1.1')
  }

  // allowH2: false / undefined must NOT throw (it is the default HTTP/1.1 behavior).
  t.doesNotThrow(() => new Pool('http://localhost', { allowH2: false }).destroy())
})

test('close() settles when destroy() is called while a request is queued', async (t) => {
  t = tspl(t, { plan: 1 })

  // Never responds: the first request stays in flight (the single client is
  // busy) so the second request is buffered in the pool's own queue.
  const server = createServer(() => {})
  after(() => server.close())

  await new Promise((resolve) => server.listen(0, resolve))

  const pool = new Pool(`http://localhost:${server.address().port}`, {
    connections: 1,
    pipelining: 1
  })

  pool.request({ path: '/', method: 'GET' }).catch(() => {})
  pool.request({ path: '/', method: 'GET' }).catch(() => {})

  // Let the second request land in the pool's internal queue.
  await new Promise((resolve) => setTimeout(resolve, 100))

  const closed = pool.close()
  // Destroying the pool while a request is still queued must not strand the
  // parked close() promise — it used to hang forever because only kOnDrain
  // (a client 'drain' event, which destroyed clients never emit) resolved it.
  pool.destroy(new Error('boom'))

  const outcome = await Promise.race([
    closed.then(() => 'resolved', (err) => `rejected:${err && err.message}`),
    new Promise((resolve) => setTimeout(() => resolve('hang'), 5000))
  ])
  t.strictEqual(outcome, 'resolved')

  await t.completed
})

test('connect/disconnect event(s)', async (t) => {
  const clients = 2

  t = tspl(t, { plan: clients * 6 })

  const server = createServer((req, res) => {
    res.writeHead(200, {
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=1s'
    })
    res.end('ok')
  })
  after(() => server.close())

  server.listen(0, () => {
    const pool = new Pool(`http://localhost:${server.address().port}`, {
      connections: clients,
      keepAliveTimeoutThreshold: 100
    })
    after(() => pool.close())

    pool.on('connect', (origin, [pool, client]) => {
      t.strictEqual(client instanceof Client, true)
    })
    pool.on('disconnect', (origin, [pool, client], error) => {
      t.ok(client instanceof Client)
      t.ok(error instanceof errors.InformationalError)
      t.strictEqual(error.code, 'UND_ERR_INFO')
      t.strictEqual(error.message, 'socket idle timeout')
    })

    for (let i = 0; i < clients; i++) {
      pool.request({
        path: '/',
        method: 'GET'
      }, (err, { headers, body }) => {
        t.ifError(err)
        body.resume()
      })
    }
  })

  await t.completed
})

test('basic get', async (t) => {
  t = tspl(t, { plan: 14 })

  const server = createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    res.setHeader('content-type', 'text/plain')
    res.end('hello')
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Pool(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    t.strictEqual(client[kUrl].origin, `http://localhost:${server.address().port}`)

    client.request({ path: '/', method: 'GET' }, (err, { statusCode, headers, body }) => {
      t.ifError(err)
      t.strictEqual(statusCode, 200)
      t.strictEqual(headers['content-type'], 'text/plain')
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
      })
    })

    t.strictEqual(client.destroyed, false)
    t.strictEqual(client.closed, false)
    client.close((err) => {
      t.ifError(err)
      t.strictEqual(client.destroyed, true)
      client.destroy((err) => {
        t.ifError(err)
        client.close((err) => {
          t.ok(err instanceof errors.ClientDestroyedError)
        })
      })
    })
    t.strictEqual(client.closed, true)
  })

  await t.completed
})

test('URL as arg', async (t) => {
  t = tspl(t, { plan: 9 })

  const server = createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    res.setHeader('content-type', 'text/plain')
    res.end('hello')
  })
  after(() => server.close())

  server.listen(0, async () => {
    const url = new URL('http://localhost')
    url.port = server.address().port
    const client = new Pool(url)
    after(() => client.destroy())

    client.request({ path: '/', method: 'GET' }, (err, { statusCode, headers, body }) => {
      t.ifError(err)
      t.strictEqual(statusCode, 200)
      t.strictEqual(headers['content-type'], 'text/plain')
      const bufs = []
      body.on('data', (buf) => {
        bufs.push(buf)
      })
      body.on('end', () => {
        t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
      })
    })

    client.close((err) => {
      t.ifError(err)
      client.destroy((err) => {
        t.ifError(err)
        client.close((err) => {
          t.ok(err instanceof errors.ClientDestroyedError)
        })
      })
    })
  })

  await t.completed
})

test('basic get error async/await', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((req, res) => {
    res.destroy()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Pool(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    await client.request({ path: '/', method: 'GET' })
      .catch((err) => {
        t.ok(err)
      })

    await client.destroy()

    await client.close().catch((err) => {
      t.ok(err instanceof errors.ClientDestroyedError)
    })
  })

  await t.completed
})

test('basic get with async/await', async (t) => {
  t = tspl(t, { plan: 4 })

  const server = createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    res.setHeader('content-type', 'text/plain')
    res.end('hello')
  })
  after(() => server.close())

  await promisify(server.listen.bind(server))(0)
  const client = new Pool(`http://localhost:${server.address().port}`)
  after(() => client.destroy())

  const { statusCode, headers, body } = await client.request({ path: '/', method: 'GET' })
  t.strictEqual(statusCode, 200)
  t.strictEqual(headers['content-type'], 'text/plain')

  body.resume()
  await promisify(finished)(body)

  await client.close()
  await client.destroy()
})

test('backpressure algorithm', async (t) => {
  t = tspl(t, { plan: 12 })

  const seen = []
  let total = 0

  let writeMore = true

  class FakeClient extends EventEmitter {
    constructor () {
      super()

      this.id = total++
    }

    dispatch (req, handler) {
      seen.push({ req, client: this, id: this.id })
      return writeMore
    }
  }

  const noopHandler = {
    onError (err) {
      throw err
    }
  }

  const pool = new Pool('http://notahost', {
    factory: () => new FakeClient()
  })

  pool.dispatch({}, noopHandler)
  pool.dispatch({}, noopHandler)

  const d1 = seen.shift() // d1 = c0
  t.strictEqual(d1.id, 0)
  const d2 = seen.shift() // d2 = c0
  t.strictEqual(d2.id, 0)

  t.strictEqual(d1.id, d2.id)

  writeMore = false

  pool.dispatch({}, noopHandler) // d3 = c0

  pool.dispatch({}, noopHandler) // d4 = c1

  const d3 = seen.shift()
  t.strictEqual(d3.id, 0)
  const d4 = seen.shift()
  t.strictEqual(d4.id, 1)

  t.strictEqual(d3.id, d2.id)
  t.notEqual(d3.id, d4.id)

  writeMore = true

  d4.client.emit('drain', new URL('http://notahost'), [])

  pool.dispatch({}, noopHandler) // d5 = c1

  d3.client.emit('drain', new URL('http://notahost'), [])

  pool.dispatch({}, noopHandler) // d6 = c0

  const d5 = seen.shift()
  t.strictEqual(d5.id, 1)
  const d6 = seen.shift()
  t.strictEqual(d6.id, 0)

  t.strictEqual(d5.id, d4.id)
  t.strictEqual(d3.id, d6.id)

  t.strictEqual(total, 3)

  t.end()
})

test('busy', async (t) => {
  t = tspl(t, { plan: 8 * 16 + 2 + 1 })

  const server = createServer((req, res) => {
    t.strictEqual('/', req.url)
    t.strictEqual('GET', req.method)
    res.setHeader('content-type', 'text/plain')
    res.end('hello')
  })
  after(() => server.close())

  const connections = 2

  server.listen(0, async () => {
    const client = new Pool(`http://localhost:${server.address().port}`, {
      connections,
      pipelining: 2
    })
    client.on('drain', () => {
      t.ok(true, 'pass')
    })
    client.on('connect', () => {
      t.ok(true, 'pass')
    })
    after(() => client.destroy())

    for (let n = 1; n <= 8; ++n) {
      client.request({ path: '/', method: 'GET' }, (err, { statusCode, headers, body }) => {
        t.ifError(err)
        t.strictEqual(statusCode, 200)
        t.strictEqual(headers['content-type'], 'text/plain')
        const bufs = []
        body.on('data', (buf) => {
          bufs.push(buf)
        })
        body.on('end', () => {
          t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
        })
      })
      t.strictEqual(client[kPending], n)
      t.strictEqual(client[kBusy], n > 1)
      t.strictEqual(client[kSize], n)
      t.strictEqual(client[kRunning], 0)

      t.strictEqual(client.stats.connected, 0)
      t.strictEqual(client.stats.free, 0)
      t.strictEqual(client.stats.queued, Math.max(n - connections, 0))
      t.strictEqual(client.stats.pending, n)
      t.strictEqual(client.stats.size, n)
      t.strictEqual(client.stats.running, 0)
    }
  })

  await t.completed
})

test('invalid pool dispatch options', async (t) => {
  t = tspl(t, { plan: 2 })
  const pool = new Pool('http://notahost')
  t.throws(() => pool.dispatch({}), errors.InvalidArgumentError, 'throws on invalid handler')
  t.throws(() => pool.dispatch({}, {}), errors.InvalidArgumentError, 'throws on invalid handler')
})

test('pool remains writable after a child rejects before queueing', async (t) => {
  const server = createServer((req, res) => {
    res.end('ok')
  })
  let connections = 0
  server.on('connection', () => { connections++ })
  await new Promise((resolve) => server.listen(0, resolve))

  const pool = new Pool(`http://localhost:${server.address().port}`, {
    connections: 1
  })
  t.after(async () => {
    await pool.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  await assert.rejects(
    pool.request({ path: 123, method: 'GET' }),
    {
      code: 'UND_ERR_INVALID_ARG',
      message: 'path must be a string'
    }
  )
  assert.strictEqual(pool.stats.size, 0)
  assert.strictEqual(connections, 0, 'rejected request must not initiate a connection')

  const { statusCode, body } = await withTimeout(
    pool.request({ path: '/', method: 'GET' }),
    'pool wedged after child rejected before queueing'
  )
  assert.strictEqual(statusCode, 200)
  assert.strictEqual(await body.text(), 'ok')
  assert.strictEqual(connections, 1)

  await withTimeout(
    pool.close(),
    'pool close hung after child rejected before queueing'
  )
})

test('pool drain skips a queued request rejected before queueing', async (t) => {
  let releaseFirst
  const server = createServer((req, res) => {
    if (req.url === '/first') {
      res.writeHead(200)
      res.write('first')
      releaseFirst = () => res.end()
    } else {
      res.end('ok')
    }
  })
  await new Promise((resolve) => server.listen(0, resolve))

  const pool = new Pool(`http://localhost:${server.address().port}`, {
    connections: 1,
    pipelining: 1
  })
  t.after(async () => {
    releaseFirst?.()
    await pool.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const first = await pool.request({ path: '/first', method: 'GET' })
  const rejected = pool.request({ path: 123, method: 'GET' })
  const healthy = pool.request({ path: '/healthy', method: 'GET' })

  assert.strictEqual(pool.stats.queued, 2)
  releaseFirst()
  releaseFirst = null
  assert.strictEqual(await first.body.text(), 'first')
  await assert.rejects(
    withTimeout(rejected, 'queued invalid request did not reject'),
    {
      code: 'UND_ERR_INVALID_ARG',
      message: 'path must be a string'
    }
  )

  const { statusCode, body } = await withTimeout(
    healthy,
    'pool drain stopped after queued request was rejected'
  )
  assert.strictEqual(statusCode, 200)
  assert.strictEqual(await body.text(), 'ok')

  await withTimeout(
    pool.close(),
    'pool close hung after queued request was rejected'
  )
})

test('pool dispatch', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Pool(`http://localhost:${server.address().port}`)
    after(() => client.close())

    let buf = ''
    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        t.strictEqual(statusCode, 200)
      },
      onData (chunk) {
        buf += chunk
      },
      onComplete () {
        t.strictEqual(buf, 'asd')
      },
      onError () {
      }
    })
  })

  await t.completed
})

test('pool promptly dispatches queued requests after idle socket validation', async () => {
  // Isolate the event loop so test-runner activity cannot wake an unref'ed
  // idle-validation Immediate and hide the stall.
  await execFileAsync(process.execPath, [
    join(__dirname, 'fixtures', 'pool-idle-socket-validation.js')
  ], {
    timeout: 2000
  })
})

test('300 requests succeed', async (t) => {
  t = tspl(t, { plan: 300 * 3 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Pool(`http://localhost:${server.address().port}`, {
      connections: 1
    })
    after(() => client.destroy())

    for (let n = 0; n < 300; ++n) {
      client.request({
        path: '/',
        method: 'GET'
      }, (err, data) => {
        t.ifError(err)
        data.body.on('data', (chunk) => {
          t.strictEqual(chunk.toString(), 'asd')
        }).on('end', () => {
          t.ok(true, 'pass')
        })
      })
    }
  })

  await t.completed
})

test('pool connect error', async (t) => {
  t = tspl(t, { plan: 1 })

  const server = createServer((c) => {
    t.fail()
  })
  server.on('connect', (req, socket, firstBodyChunk) => {
    socket.destroy()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Pool(`http://localhost:${server.address().port}`)
    after(() => client.close())

    try {
      await client.connect({
        path: '/'
      })
    } catch (err) {
      t.ok(err)
    }
  })

  await t.completed
})

test('pool dispatch error', async (t) => {
  t = tspl(t, { plan: 3 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Pool(`http://localhost:${server.address().port}`, {
      connections: 1,
      pipelining: 1
    })
    after(() => client.close())

    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        t.strictEqual(statusCode, 200)
      },
      onData (chunk) {
      },
      onComplete () {
        t.ok(true, 'pass')
      },
      onError () {
      }
    })

    client.dispatch({
      path: '/',
      method: 'GET',
      headers: {
        'transfer-encoding': 'fail'
      }
    }, {
      onConnect () {
        t.fail()
      },
      onHeaders (statusCode, headers) {
        t.fail()
      },
      onData (chunk) {
        t.fail()
      },
      onError (err) {
        t.strictEqual(err.code, 'UND_ERR_INVALID_ARG')
      }
    })
  })

  await t.completed
})

test('pool request abort in queue', async (t) => {
  t = tspl(t, { plan: 3 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Pool(`http://localhost:${server.address().port}`, {
      connections: 1,
      pipelining: 1
    })
    after(() => client.close())

    client.dispatch({
      path: '/',
      method: 'GET'
    }, {
      onConnect () {
      },
      onHeaders (statusCode, headers) {
        t.strictEqual(statusCode, 200)
      },
      onData (chunk) {
      },
      onComplete () {
        t.ok(true, 'pass')
      },
      onError () {
      }
    })

    const signal = new EventEmitter()
    client.request({
      path: '/',
      method: 'GET',
      signal
    }, (err) => {
      t.strictEqual(err.code, 'UND_ERR_ABORTED')
    })
    signal.emit('abort')
  })

  await t.completed
})

test('pool request constructor error destroy body', async (t) => {
  t = tspl(t, { plan: 4 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Pool(`http://localhost:${server.address().port}`, {
      connections: 1,
      pipelining: 1
    })
    after(() => client.close())

    {
      const body = new Readable({
        read () {
        }
      })
      client.request({
        path: '/',
        method: 'GET',
        body,
        headers: {
          'transfer-encoding': 'fail'
        }
      }, (err) => {
        t.strictEqual(err.code, 'UND_ERR_INVALID_ARG')
        t.strictEqual(body.destroyed, true)
      })
    }

    {
      const body = new Readable({
        read () {
        }
      })
      client.request({
        path: '/',
        method: 'CONNECT',
        body
      }, (err) => {
        t.strictEqual(err.code, 'UND_ERR_INVALID_ARG')
        t.strictEqual(body.destroyed, true)
      })
    }
  })

  await t.completed
})

test('pool close waits for all requests', async (t) => {
  t = tspl(t, { plan: 5 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Pool(`http://localhost:${server.address().port}`, {
      connections: 1,
      pipelining: 1
    })
    after(() => client.destroy())

    client.request({
      path: '/',
      method: 'GET'
    }, (err) => {
      t.ifError(err)
    })

    client.request({
      path: '/',
      method: 'GET'
    }, (err) => {
      t.ifError(err)
    })

    client.close(() => {
      t.ok(true, 'pass')
    })

    client.close(() => {
      t.ok(true, 'pass')
    })

    client.request({
      path: '/',
      method: 'GET'
    }, (err) => {
      t.ok(err instanceof errors.ClientClosedError)
    })
  })

  await t.completed
})

test('pool destroyed', async (t) => {
  t = tspl(t, { plan: 1 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Pool(`http://localhost:${server.address().port}`, {
      connections: 1,
      pipelining: 1
    })
    after(() => client.destroy())

    client.destroy()
    client.request({
      path: '/',
      method: 'GET'
    }, (err) => {
      t.ok(err instanceof errors.ClientDestroyedError)
    })
  })

  await t.completed
})

test('pool destroy fails queued requests', async (t) => {
  t = tspl(t, { plan: 6 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Pool(`http://localhost:${server.address().port}`, {
      connections: 1,
      pipelining: 1
    })
    after(() => client.destroy())

    const _err = new Error()
    client.request({
      path: '/',
      method: 'GET'
    }, (err) => {
      t.strictEqual(err, _err)
    })

    client.request({
      path: '/',
      method: 'GET'
    }, (err) => {
      t.strictEqual(err, _err)
    })

    t.strictEqual(client.destroyed, false)
    client.destroy(_err, () => {
      t.ok(true, 'pass')
    })
    t.strictEqual(client.destroyed, true)

    client.request({
      path: '/',
      method: 'GET'
    }, (err) => {
      t.ok(err instanceof errors.ClientDestroyedError)
    })
  })
  await t.completed
})

// Regression: PoolBase[kOnDrain] used to be a closure that read `this` to mean
// the client that drained. That works for the 'drain' event (Node binds
// this=client), but kAddClient also calls it directly with this=pool. In that
// path `this.dispatch` re-entered the pool, `this[kNeedDrain]` clobbered the
// pool's own flag, and `!this[kNeedDrain] && pool[kNeedDrain]` collapsed to
// `!pool[kNeedDrain] && pool[kNeedDrain]` (always false) so the pool 'drain'
// event was never emitted from that path. Reproduced by dropping a client via
// connectionError (which leaves the pool backed up) and replacing that client,
// which triggers the kAddClient drain path.
test('pool emits drain after a dropped client is replaced while backed up', async (t) => {
  t = tspl(t, { plan: 7 })

  const seen = []
  let total = 0
  let writeMore = false

  class FakeClient extends EventEmitter {
    constructor () {
      super()
      this.id = total++
      this.destroyed = false
    }

    dispatch (opts, handler) {
      seen.push({ client: this, id: this.id, handler })
      return writeMore
    }

    close (cb) {
      if (cb) cb(null, null)
      return Promise.resolve()
    }

    destroy () {
      this.destroyed = true
      return Promise.resolve()
    }
  }

  const noopHandler = {
    onError (err) {
      throw err
    }
  }

  const pool = new Pool('http://notahost', {
    connections: 1,
    factory: () => new FakeClient()
  })
  after(() => pool.destroy())

  // Saturate c0, then queue a second request at the pool level so the pool is
  // backed up (pool[kNeedDrain] === true).
  pool.dispatch({}, noopHandler) // -> c0 (busy: dispatch returns false)
  pool.dispatch({}, noopHandler) // -> queued (no free client, at connection limit)

  t.strictEqual(seen.length, 1, 'the second request is queued, not dispatched')

  // Drop c0 via a connectionError. Pool splices it out without recomputing its
  // needDrain flag, so the pool stays backed up with an empty client list.
  const c0 = seen[0].client
  c0.emit('connectionError', new URL('http://notahost'), [c0], new Error('boom'))

  // Watch for the pool 'drain', including its dispatcher target chain.
  let drained = false
  let drainedTargets
  pool.on('drain', (origin, targets) => {
    drained = true
    drainedTargets = targets
  })

  // Uses the replacement client created after connectionError. kAddClient saw
  // pool[kNeedDrain] still true and scheduled the kOnDrain microtask. The
  // replacement itself applies backpressure, so that microtask must not
  // dispatch queued work yet.
  pool.dispatch({}, noopHandler) // -> c1 (busy: dispatch returns false)

  // Flush the synthetic drain microtask. It must respect the replacement
  // client's backpressure instead of dispatching the queued request early.
  await new Promise((resolve) => setImmediate(resolve))
  t.strictEqual(seen.length, 2, 'the queued request waits for the replacement client to drain')
  t.strictEqual(drained, false, 'the pool stays backed up while the replacement client is busy')

  // Once the replacement really drains, queued work is flushed and the pool
  // re-emits the same [pool, client] target shape as a normal client drain.
  const c1 = seen[1].client
  writeMore = true
  c1.emit('drain', new URL('http://notahost'), [c1])
  await new Promise((resolve) => setImmediate(resolve))

  t.strictEqual(drained, true, 'pool emits drain after flushing its queue via the replacement client')
  t.strictEqual(seen.length, 3, 'the queued request was dispatched')
  t.strictEqual(seen[2].id, 1, 'the queued request ran on the replacement client')
  t.deepStrictEqual(drainedTargets, [pool, c1], 'the pool drain target chain contains each dispatcher once')

  await t.completed
})

test('pool does not drain queued work through a destroyed replacement client', async (t) => {
  let acceptWork = false
  let nextId = 0
  const seen = []

  class FakeClient extends EventEmitter {
    constructor () {
      super()
      this.id = nextId++
      this.destroyed = false
    }

    dispatch () {
      assert.strictEqual(this.destroyed, false, 'destroyed client must not receive queued work')
      seen.push(this)
      return acceptWork
    }

    close (callback) {
      callback?.(null, null)
      return Promise.resolve()
    }

    destroy () {
      this.destroyed = true
      return Promise.resolve()
    }
  }

  const pool = new Pool('http://notahost', {
    connections: 1,
    factory: () => new FakeClient()
  })
  t.after(() => pool.destroy())

  const handler = { onError () {} }
  pool.dispatch({}, handler)
  pool.dispatch({}, handler)

  const first = seen[0]
  first.emit('connectionError', new URL('http://notahost'), [first], new Error('boom'))

  acceptWork = true
  pool.dispatch({}, handler)
  const replacement = seen[1]
  replacement.destroyed = true

  let drained = false
  pool.on('drain', () => { drained = true })
  await new Promise((resolve) => setImmediate(resolve))

  assert.strictEqual(seen.length, 2)
  assert.strictEqual(drained, false)
})

test('pool detaches a failed client before resuming queued work', async (t) => {
  let acceptWork = false
  const clients = []
  const seen = []

  class FakeClient extends EventEmitter {
    constructor () {
      super()
      this.closed = false
      this.destroyed = false
      clients.push(this)
    }

    dispatch (opts) {
      seen.push({ client: this, opts })
      return acceptWork
    }

    close (callback) {
      this.closed = true
      callback?.(null, null)
      return Promise.resolve()
    }

    destroy () {
      this.destroyed = true
      return Promise.resolve()
    }
  }

  const pool = new Pool('http://notahost', {
    connections: 1,
    factory: () => new FakeClient()
  })
  t.after(() => pool.destroy())

  const handler = { onError () {} }
  assert.strictEqual(pool.dispatch({ path: '/first' }, handler), false)
  assert.strictEqual(pool.dispatch({ path: '/queued' }, handler), false)
  assert.strictEqual(seen.length, 1)
  assert.strictEqual(pool.stats.queued, 1)

  const failed = clients[0]
  failed.emit('connectionError', new URL('http://notahost'), [failed], new Error('boom'))

  assert.strictEqual(clients.length, 2, 'connectionError creates a tracked replacement')
  const replacement = clients[1]
  assert.deepStrictEqual(pool[kClients], [replacement])
  assert.deepStrictEqual(failed.eventNames(), [], 'all pool listeners are detached')

  failed.emit('drain', new URL('http://notahost'), [failed])
  assert.strictEqual(seen.length, 1, 'a removed client cannot drain pool work')

  acceptWork = true
  await new Promise((resolve) => setImmediate(resolve))

  assert.strictEqual(seen.length, 2)
  assert.strictEqual(seen[1].client, replacement, 'queued work uses the tracked replacement')
  assert.strictEqual(seen[1].opts.path, '/queued')
  assert.strictEqual(pool.stats.queued, 0)
})

test('pool keeps retried queued work tracked after a connection error', async (t) => {
  const serverSockets = new Set()
  const paths = []
  const server = createServer((req, res) => {
    paths.push(req.url)
    res.setHeader('connection', 'keep-alive')
    res.end('ok')
  })
  server.keepAliveTimeout = 60e3
  server.on('connection', (socket) => {
    serverSockets.add(socket)
    socket.on('close', () => serverSockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  let attempts = 0
  const pool = new Pool(`http://127.0.0.1:${server.address().port}`, {
    connections: 1,
    connect (opts, callback) {
      if (++attempts === 1) {
        queueMicrotask(() => {
          const err = new Error('synthetic first-connect failure')
          err.code = 'ECONNREFUSED'
          callback(err)
        })
        return
      }

      const socket = net.connect({
        host: opts.hostname,
        port: Number(opts.port)
      })
      const onError = (err) => callback(err)
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        callback(null, socket)
      })
    }
  })
  t.after(async () => {
    await pool.destroy()
    for (const socket of serverSockets) {
      socket.destroy()
    }
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  function completion () {
    let resolve
    const promise = new Promise((_resolve) => { resolve = _resolve })
    return {
      promise,
      handler: {
        onConnect () {},
        onHeaders () { return true },
        onData () { return true },
        onComplete () { resolve(null) },
        onError (err) { resolve(err) }
      }
    }
  }

  const first = completion()
  const second = completion()
  const firstWritable = pool.dispatch({
    path: '/first',
    method: 'POST',
    body: (async function * () { yield Buffer.from('x') })()
  }, first.handler)
  const failed = pool[kClients][0]
  const secondWritable = pool.dispatch({
    path: '/queued',
    method: 'GET'
  }, second.handler)

  assert.strictEqual(firstWritable, false)
  assert.strictEqual(secondWritable, false)
  assert.strictEqual(pool.stats.queued, 1)

  const [firstError, secondError] = await Promise.all([
    first.promise,
    second.promise
  ])

  assert.strictEqual(firstError.code, 'ECONNREFUSED')
  assert.strictEqual(secondError, null)
  assert.strictEqual(attempts, 2)
  assert.deepStrictEqual(paths, ['/queued'])
  assert.strictEqual(pool[kClients].length, 1)
  assert.notStrictEqual(pool[kClients][0], failed, 'the successful retry is tracked')
  assert.deepStrictEqual(failed.eventNames(), [], 'the failed client stays detached')
  assert.strictEqual(serverSockets.size, 1)

  const socketsClosed = Promise.all([...serverSockets].map((socket) => (
    socket.destroyed
      ? Promise.resolve()
      : new Promise((resolve) => socket.once('close', resolve))
  )))
  await pool.destroy()
  await socketsClosed

  assert.strictEqual(serverSockets.size, 0, 'pool.destroy closes the replacement socket')
})
