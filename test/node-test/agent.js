'use strict'

const { describe, test, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const {
  Agent,
  errors,
  request,
  Pool,
  setGlobalDispatcher,
  getGlobalDispatcher
} = require('../..')
const { tspl } = require('@matteo.collina/tspl')
const { closeServerAsPromise } = require('../utils/node-http')

describe('setGlobalDispatcher', () => {
  after(() => {
    // reset globalAgent to a fresh Agent instance for later tests
    setGlobalDispatcher(new Agent())
  })
  test('fails if agent does not implement `get` method', t => {
    const p = tspl(t, { plan: 1 })
    p.throws(() => setGlobalDispatcher({ dispatch: 'not a function' }), errors.InvalidArgumentError)
  })
  test('sets global agent', async t => {
    const p = tspl(t, { plan: 2 })
    p.doesNotThrow(() => setGlobalDispatcher(new Agent()))
    p.doesNotThrow(() => setGlobalDispatcher({ dispatch: () => {} }))
  })
})

test('Agent', t => {
  const p = tspl(t, { plan: 1 })

  p.doesNotThrow(() => new Agent())
})

test('agent should call callback after closing internal pools', async (t) => {
  const p = tspl(t, { plan: 2 })

  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.after(closeServerAsPromise(server))

  server.listen(0, () => {
    const dispatcher = new Agent()

    const origin = `http://localhost:${server.address().port}`

    request(origin, { dispatcher })
      .then(() => {
        // first request should resolve
        p.ok(1)
      })
      .catch(err => {
        p.fail(err)
      })

    dispatcher.once('connect', () => {
      dispatcher.close(() => {
        request(origin, { dispatcher })
          .then(() => {
            p.fail('second request should not resolve')
          })
          .catch(err => {
            p.ok(err instanceof errors.ClientDestroyedError)
          })
      })
    })
  })

  await p.completed
})

test('agent close throws when callback is not a function', t => {
  const p = tspl(t, { plan: 1 })
  const dispatcher = new Agent()
  try {
    dispatcher.close({})
  } catch (err) {
    p.ok(err instanceof errors.InvalidArgumentError)
  }
})

test('agent should close internal pools', async (t) => {
  const p = tspl(t, { plan: 2 })

  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.after(closeServerAsPromise(server))

  server.listen(0, () => {
    const dispatcher = new Agent()

    const origin = `http://localhost:${server.address().port}`

    request(origin, { dispatcher })
      .then(() => {
        // first request should resolve
        p.ok(1)
      })
      .catch(err => {
        p.fail(err)
      })

    dispatcher.once('connect', () => {
      dispatcher.close()
        .then(() => request(origin, { dispatcher }))
        .then(() => {
          p.fail('second request should not resolve')
        })
        .catch(err => {
          p.ok(err instanceof errors.ClientDestroyedError)
        })
    })
  })

  await p.completed
})

test('agent should destroy internal pools and call callback', async (t) => {
  const p = tspl(t, { plan: 2 })

  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.after(closeServerAsPromise(server))

  server.listen(0, () => {
    const dispatcher = new Agent()

    const origin = `http://localhost:${server.address().port}`

    request(origin, { dispatcher })
      .then(() => {
        p.fail()
      })
      .catch(err => {
        p.ok(err instanceof errors.ClientDestroyedError)
      })

    dispatcher.once('connect', () => {
      dispatcher.destroy(() => {
        request(origin, { dispatcher })
          .then(() => {
            p.fail()
          })
          .catch(err => {
            p.ok(err instanceof errors.ClientDestroyedError)
          })
      })
    })
  })

  await p.completed
})

test('agent destroy throws when callback is not a function', t => {
  const p = tspl(t, { plan: 1 })
  const dispatcher = new Agent()
  try {
    dispatcher.destroy(new Error('mock error'), {})
  } catch (err) {
    p.ok(err instanceof errors.InvalidArgumentError)
  }
})

test('agent close/destroy callback with error', t => {
  const p = tspl(t, { plan: 4 })
  const dispatcher = new Agent()
  p.strictEqual(dispatcher.closed, false)
  dispatcher.close()
  p.strictEqual(dispatcher.closed, true)
  p.strictEqual(dispatcher.destroyed, false)
  dispatcher.destroy(new Error('mock error'))
  p.strictEqual(dispatcher.destroyed, true)
})

test('agent should destroy internal pools', async t => {
  const p = tspl(t, { plan: 2 })

  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.after(closeServerAsPromise(server))

  server.listen(0, () => {
    const dispatcher = new Agent()

    const origin = `http://localhost:${server.address().port}`

    request(origin, { dispatcher })
      .then(() => {
        p.fail()
      })
      .catch(err => {
        p.ok(err instanceof errors.ClientDestroyedError)
      })

    dispatcher.once('connect', () => {
      dispatcher.destroy()
        .then(() => request(origin, { dispatcher }))
        .then(() => {
          p.fail()
        })
        .catch(err => {
          p.ok(err instanceof errors.ClientDestroyedError)
        })
    })
  })

  await p.completed
})

test('multiple connections', async t => {
  const connections = 3
  const p = tspl(t, { plan: 6 * connections })

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=1s'
    })
    res.end('ok')
  })
  t.after(closeServerAsPromise(server))

  server.listen(0, async () => {
    const origin = `http://localhost:${server.address().port}`
    const dispatcher = new Agent({ connections })

    t.after(() => { dispatcher.close.bind(dispatcher)() })

    dispatcher.on('connect', (origin, [dispatcher]) => {
      p.ok(dispatcher)
    })
    dispatcher.on('disconnect', (origin, [dispatcher], error) => {
      p.ok(dispatcher)
      p.ok(error instanceof errors.InformationalError)
      p.strictEqual(error.code, 'UND_ERR_INFO')
      p.strictEqual(error.message, 'reset')
    })

    for (let i = 0; i < connections; i++) {
      try {
        await request(origin, { dispatcher })
        p.ok(1)
      } catch (err) {
        p.fail(err)
      }
    }
  })

  await p.completed
})

test('agent factory supports URL parameter', async (t) => {
  const p = tspl(t, { plan: 2 })

  const noopHandler = {
    onConnect () {},
    onHeaders () {},
    onData () {},
    onComplete () {
      server.close()
    },
    onError (err) {
      throw err
    }
  }

  const dispatcher = new Agent({
    factory: (origin, opts) => {
      p.ok(origin instanceof URL)
      return new Pool(origin, opts)
    }
  })

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end('asd')
  })

  server.listen(0, () => {
    p.doesNotThrow(() => dispatcher.dispatch({
      origin: new URL(`http://localhost:${server.address().port}`),
      path: '/',
      method: 'GET'
    }, noopHandler))
  })

  await p.completed
})

test('agent factory supports string parameter', async (t) => {
  const p = tspl(t, { plan: 2 })

  const noopHandler = {
    onConnect () {},
    onHeaders () {},
    onData () {},
    onComplete () {
      server.close()
    },
    onError (err) {
      throw err
    }
  }

  const dispatcher = new Agent({
    factory: (origin, opts) => {
      p.ok(typeof origin === 'string')
      return new Pool(origin, opts)
    }
  })

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end('asd')
  })

  server.listen(0, () => {
    p.doesNotThrow(() => dispatcher.dispatch({
      origin: `http://localhost:${server.address().port}`,
      path: '/',
      method: 'GET'
    }, noopHandler))
  })

  await p.completed
})

test('with globalAgent', async t => {
  const p = tspl(t, { plan: 6 })
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    p.strictEqual('/', req.url)
    p.strictEqual('GET', req.method)
    p.strictEqual(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.after(closeServerAsPromise(server))

  server.listen(0, () => {
    request(`http://localhost:${server.address().port}`)
      .then(({ statusCode, headers, body }) => {
        p.strictEqual(statusCode, 200)
        p.strictEqual(headers['content-type'], 'text/plain')
        const bufs = []
        body.on('data', (buf) => {
          bufs.push(buf)
        })
        body.on('end', () => {
          p.strictEqual(wanted, Buffer.concat(bufs).toString('utf8'))
        })
      })
      .catch(err => {
        p.fail(err)
      })
  })

  await p.completed
})

test('fails with invalid args', t => {
  assert.throws(() => request(), errors.InvalidArgumentError, 'throws on missing url argument')
  assert.throws(() => request(''), errors.InvalidArgumentError, 'throws on invalid url')
  assert.throws(() => request({}), errors.InvalidArgumentError, 'throws on missing url.origin argument')
  assert.throws(() => request({ origin: '' }), errors.InvalidArgumentError, 'throws on invalid url.origin argument')
  assert.throws(() => request('https://example.com', { path: 0 }), errors.InvalidArgumentError, 'throws on opts.path argument')
  assert.throws(() => request('https://example.com', { agent: new Agent() }), errors.InvalidArgumentError, 'throws on opts.path argument')
  assert.throws(() => request('https://example.com', 'asd'), errors.InvalidArgumentError, 'throws on non object opts argument')
})

test('with a local agent', async t => {
  const p = tspl(t, { plan: 6 })
  const wanted = 'payload'

  const server = http.createServer((req, res) => {
    p.strictEqual('/', req.url)
    p.strictEqual('GET', req.method)
    p.strictEqual(`localhost:${server.address().port}`, req.headers.host)
    res.setHeader('Content-Type', 'text/plain')
    res.end(wanted)
  })

  t.after(closeServerAsPromise(server))

  const dispatcher = new Agent()

  server.listen(0, () => {
    const bufs = []

    request(
      `http://localhost:${server.address().port}`,
      { dispatcher }).then(
      ({ statusCode, headers, body }) => {
        p.strictEqual(statusCode, 200)
        p.strictEqual(headers['content-type'], 'text/plain')
        body
          .on('data', buf => {
            bufs.push(buf)
          })
          .on('end', () => {
            p.strictEqual(wanted, Buffer.concat(bufs).toString('utf8'))
          })
          .on('error', () => {
            p.fail()
          })
      }
    )
  })

  await p.completed
})

test('constructor validations', t => {
  const p = tspl(t, { plan: 1 })
  p.throws(() => new Agent({ factory: 'ASD' }), errors.InvalidArgumentError, 'throws on invalid opts argument')
})

test('dispatch validations', async t => {
  const dispatcher = new Agent()

  const noopHandler = {
    onConnect () {},
    onHeaders () {},
    onData () {},
    onComplete () {
      server.close()
    },
    onError (err) {
      throw err
    }
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end('asd')
  })

  const p = tspl(t, { plan: 6 })
  p.throws(() => dispatcher.dispatch('ASD'), errors.InvalidArgumentError, 'throws on missing handler')
  p.throws(() => dispatcher.dispatch('ASD', noopHandler), errors.InvalidArgumentError, 'throws on invalid opts argument type')
  p.throws(() => dispatcher.dispatch({}, noopHandler), errors.InvalidArgumentError, 'throws on invalid opts.origin argument')
  p.throws(() => dispatcher.dispatch({ origin: '' }, noopHandler), errors.InvalidArgumentError, 'throws on invalid opts.origin argument')
  p.throws(() => dispatcher.dispatch({}, {}), errors.InvalidArgumentError, 'throws on invalid handler.onError')

  server.listen(0, () => {
    p.doesNotThrow(() => dispatcher.dispatch({
      origin: new URL(`http://localhost:${server.address().port}`),
      path: '/',
      method: 'GET'
    }, noopHandler))
  })

  await p.completed
})

test('drain', async t => {
  const p = tspl(t, { plan: 2 })

  const dispatcher = new Agent({
    connections: 1,
    pipelining: 1
  })

  dispatcher.on('drain', () => {
    p.ok(1)
  })

  class Handler {
    onConnect () {}
    onHeaders () {}
    onData () {}
    onComplete () {}
    onError () {
      p.fail()
    }
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end('asd')
  })

  t.after(closeServerAsPromise(server))

  server.listen(0, () => {
    p.strictEqual(dispatcher.dispatch({
      origin: `http://localhost:${server.address().port}`,
      method: 'GET',
      path: '/'
    }, new Handler()), false)
  })

  await p.completed
})

test('global api', async t => {
  const p = tspl(t, { plan: 5 * 2 })

  const server = http.createServer((req, res) => {
    if (req.url === '/bar') {
      p.strictEqual(req.method, 'PUT')
      p.strictEqual(req.url, '/bar')
    } else {
      p.strictEqual(req.method, 'GET')
      p.strictEqual(req.url, '/foo')
    }
    req.pipe(res)
  })

  t.after(closeServerAsPromise(server))

  server.listen(0, async () => {
    const origin = `http://localhost:${server.address().port}`
    await request(origin, { path: '/foo' }).then(({ body }) => body.dump())
    await request(`${origin}/foo`).then(({ body }) => body.dump())
    await request({ origin, path: '/foo' }).then(({ body }) => body.dump())
    await request({ protocol: 'http:', hostname: 'localhost', port: server.address().port, path: '/foo' }).then(({ body }) => body.dump())
    await request(`${origin}/bar`, { body: 'asd' }).then(({ body }) => body.dump())
  })

  await p.completed
})

test('global api throws', t => {
  const origin = 'http://asd'
  assert.throws(() => request(`${origin}/foo`, { path: '/foo' }), errors.InvalidArgumentError)
  assert.throws(() => request({ origin, path: 0 }, { path: '/foo' }), errors.InvalidArgumentError)
  assert.throws(() => request({ origin, pathname: 0 }, { path: '/foo' }), errors.InvalidArgumentError)
  assert.throws(() => request({ origin: 0 }, { path: '/foo' }), errors.InvalidArgumentError)
  assert.throws(() => request(0), errors.InvalidArgumentError)
  assert.throws(() => request(1), errors.InvalidArgumentError)
})

test('unreachable request rejects and can be caught', async t => {
  const p = tspl(t, { plan: 1 })

  request('https://thisis.not/avalid/url').catch(() => {
    p.ok(1)
  })

  await p.completed
})

test('connect is not valid', t => {
  const p = tspl(t, { plan: 1 })

  p.throws(() => new Agent({ connect: false }), errors.InvalidArgumentError, 'connect must be a function or an object')
})

test('the dispatcher is truly global', t => {
  const agent = getGlobalDispatcher()
  assert.ok(require.resolve('../../index.js') in require.cache)
  delete require.cache[require.resolve('../../index.js')]
  assert.strictEqual(require.resolve('../../index.js') in require.cache, false)
  const undiciFresh = require('../../index.js')
  assert.ok(require.resolve('../../index.js') in require.cache)
  assert.strictEqual(agent, undiciFresh.getGlobalDispatcher())
})
