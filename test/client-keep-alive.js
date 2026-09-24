'use strict'

const { tspl } = require('@matteo.collina/tspl')
const { test, after } = require('node:test')
const { once } = require('node:events')
const { Client } = require('..')
const timers = require('../lib/util/timers')
const { kConnect, kKeepAliveTimeoutValue } = require('../lib/core/symbols')
const { createServer } = require('node:net')
const http = require('node:http')
const FakeTimers = require('@sinonjs/fake-timers')

test('keep-alive header', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((socket) => {
    socket.write('HTTP/1.1 200 OK\r\n')
    socket.write('Content-Length: 0\r\n')
    socket.write('Keep-Alive: timeout=2s\r\n')
    socket.write('Connection: keep-alive\r\n')
    socket.write('\r\n\r\n')
  })
  after(() => server.close())

  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  client.request({
    path: '/',
    method: 'GET'
  }, (err, { body }) => {
    t.ifError(err)
    body.on('end', () => {
      const timeout = setTimeout(() => {
        t.fail()
      }, 4e3)
      client.on('disconnect', () => {
        t.ok(true, 'pass')
        clearTimeout(timeout)
      })
    }).resume()
  })
  await t.completed
})

test('keep-alive header 0', async (t) => {
  t = tspl(t, { plan: 2 })

  const clock = FakeTimers.install()
  after(() => clock.uninstall())

  const orgTimers = { ...timers }
  Object.assign(timers, { setTimeout, clearTimeout })
  after(() => { Object.assign(timers, orgTimers) })

  const server = createServer((socket) => {
    socket.write('HTTP/1.1 200 OK\r\n')
    socket.write('Content-Length: 0\r\n')
    socket.write('Keep-Alive: timeout=1s\r\n')
    socket.write('Connection: keep-alive\r\n')
    socket.write('\r\n\r\n')
  })
  after(() => server.close())

  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeoutThreshold: 500
  })
  after(() => client.close())

  client.request({
    path: '/',
    method: 'GET'
  }, (err, { body }) => {
    t.ifError(err)
    body.on('end', () => {
      client.on('disconnect', () => {
        t.ok(true, 'pass')
      })
      clock.tick(600)
    }).resume()
  })
  await t.completed
})

test('keep-alive header 1', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((socket) => {
    socket.write('HTTP/1.1 200 OK\r\n')
    socket.write('Content-Length: 0\r\n')
    socket.write('Keep-Alive: timeout=1s\r\n')
    socket.write('Connection: keep-alive\r\n')
    socket.write('\r\n\r\n')
  })
  after(() => server.close())

  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  client.request({
    path: '/',
    method: 'GET'
  }, (err, { body }) => {
    t.ifError(err)
    body.on('end', () => {
      const timeout = setTimeout(() => {
        t.fail()
      }, 0)
      client.on('disconnect', () => {
        t.ok(true, 'pass')
        clearTimeout(timeout)
      })
    }).resume()
  })
  await t.completed
})

test('HEAD keep-alive header reuses socket when connection header is fragmented', async (t) => {
  t = tspl(t, { plan: 4 })

  let connections = 0
  let requests = 0

  const server = createServer((socket) => {
    connections++
    socket.setNoDelay(true)

    let request = ''
    let responses = Promise.resolve()
    socket.on('data', (chunk) => {
      request += chunk.toString()

      while (request.includes('\r\n\r\n')) {
        const endOfHeaders = request.indexOf('\r\n\r\n') + 4
        request = request.slice(endOfHeaders)
        requests++
        const requestNumber = requests

        responses = responses.then(async () => {
          socket.write('HTTP/1.1 200 OK\r\n')
          socket.write('Content-Length: 0\r\n')
          await new Promise((resolve) => socket.write('Connection: keep-', resolve))
          await new Promise((resolve) => setImmediate(resolve))
          socket.write('alive\r\n')
          socket.write('\r\n')

          if (requestNumber === 2) {
            socket.end()
          }
        })
      }
    })
  })
  after(() => server.close())
  await once(server.listen(0), 'listening')

  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.destroy())

  const first = await client.request({
    path: '/',
    method: 'HEAD',
    reset: false
  })
  t.strictEqual(first.statusCode, 200)
  await first.body.text()

  const second = await client.request({
    path: '/',
    method: 'HEAD',
    reset: false
  })
  t.strictEqual(second.statusCode, 200)
  await second.body.text()

  t.strictEqual(connections, 1)
  t.strictEqual(requests, 2)

  await t.completed
})

test('keep-alive header no postfix', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((socket) => {
    socket.write('HTTP/1.1 200 OK\r\n')
    socket.write('Content-Length: 0\r\n')
    socket.write('Keep-Alive: timeout=2\r\n')
    socket.write('Connection: keep-alive\r\n')
    socket.write('\r\n\r\n')
  })
  after(() => server.close())

  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  client.request({
    path: '/',
    method: 'GET'
  }, (err, { body }) => {
    t.ifError(err)
    body.on('end', () => {
      const timeout = setTimeout(() => {
        t.fail()
      }, 4e3)
      client.on('disconnect', () => {
        t.ok(true, 'pass')
        clearTimeout(timeout)
      })
    }).resume()
  })
  await t.completed
})

test('keep-alive not timeout', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((socket) => {
    socket.write('HTTP/1.1 200 OK\r\n')
    socket.write('Content-Length: 0\r\n')
    socket.write('Keep-Alive: timeoutasdasd=1s\r\n')
    socket.write('Connection: keep-alive\r\n')
    socket.write('\r\n\r\n')
  })
  after(() => server.close())

  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeout: 1e3
  })
  after(() => client.close())

  client.request({
    path: '/',
    method: 'GET'
  }, (err, { body }) => {
    t.ifError(err)
    body.on('end', () => {
      const timeout = setTimeout(() => {
        t.fail()
      }, 3e3)
      client.on('disconnect', () => {
        t.ok(true, 'pass')
        clearTimeout(timeout)
      })
    }).resume()
  })
  await t.completed
})

test('keep-alive threshold', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((socket) => {
    socket.write('HTTP/1.1 200 OK\r\n')
    socket.write('Content-Length: 0\r\n')
    socket.write('Keep-Alive: timeout=30s\r\n')
    socket.write('Connection: keep-alive\r\n')
    socket.write('\r\n\r\n')
  })
  after(() => server.close())

  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeout: 30e3,
    keepAliveTimeoutThreshold: 29e3
  })
  after(() => client.close())

  client.request({
    path: '/',
    method: 'GET'
  }, (err, { body }) => {
    t.ifError(err)
    body.on('end', () => {
      const timeout = setTimeout(() => {
        t.fail()
      }, 5e3)
      client.on('disconnect', () => {
        t.ok(true, 'pass')
        clearTimeout(timeout)
      })
    }).resume()
  })
  await t.completed
})

test('keep-alive max keepalive', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((socket) => {
    socket.write('HTTP/1.1 200 OK\r\n')
    socket.write('Content-Length: 0\r\n')
    socket.write('Keep-Alive: timeout=30s\r\n')
    socket.write('Connection: keep-alive\r\n')
    socket.write('\r\n\r\n')
  })
  after(() => server.close())

  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeout: 30e3,
    keepAliveMaxTimeout: 1e3
  })
  after(() => client.close())

  client.request({
    path: '/',
    method: 'GET'
  }, (err, { body }) => {
    t.ifError(err)
    body.on('end', () => {
      const timeout = setTimeout(() => {
        t.fail()
      }, 3e3)
      client.on('disconnect', () => {
        t.ok(true, 'pass')
        clearTimeout(timeout)
      })
    }).resume()
  })
  await t.completed
})

test('connection close', async (t) => {
  t = tspl(t, { plan: 4 })

  let close = false
  const server = createServer((socket) => {
    if (close) {
      return
    }
    close = true
    socket.write('HTTP/1.1 200 OK\r\n')
    socket.write('Content-Length: 0\r\n')
    socket.write('Connection: close\r\n')
    socket.write('\r\n\r\n')
  })
  after(() => server.close())

  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`, {
    pipelining: 2
  })
  after(() => client.close())

  client[kConnect](() => {
    client.request({
      path: '/',
      method: 'GET'
    }, (err, { body }) => {
      t.ifError(err)
      body.on('end', () => {
        const timeout = setTimeout(() => {
          t.fail()
        }, 3e3)
        client.once('disconnect', () => {
          close = false
          t.ok(true, 'pass')
          clearTimeout(timeout)
        })
      }).resume()
    })

    client.request({
      path: '/',
      method: 'GET'
    }, (err, { body }) => {
      t.ifError(err)
      body.on('end', () => {
        const timeout = setTimeout(() => {
          t.fail()
        }, 3e3)
        client.once('disconnect', () => {
          t.ok(true, 'pass')
          clearTimeout(timeout)
        })
      }).resume()
    })
  })
  await t.completed
})

test('Disable keep alive', async (t) => {
  t = tspl(t, { plan: 7 })

  const ports = []
  const server = http.createServer((req, res) => {
    t.strictEqual(ports.includes(req.socket.remotePort), false)
    ports.push(req.socket.remotePort)
    t.strictEqual(req.headers.connection, 'close')
    res.writeHead(200, { connection: 'close' })
    res.end()
  })
  after(() => server.close())

  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`, { pipelining: 0 })
  after(() => client.close())

  client.request({
    path: '/',
    method: 'GET'
  }, (err, { body }) => {
    t.ifError(err)
    body.on('end', () => {
      client.request({
        path: '/',
        method: 'GET'
      }, (err, { body }) => {
        t.ifError(err)
        body.on('end', () => {
          t.ok(true, 'pass')
        }).resume()
      })
    }).resume()
  })
  await t.completed
})

test('a reused keep-alive timer only closes the socket while it is idle', async (t) => {
  t = tspl(t, { plan: 6 })

  // The parser keeps its keep-alive timer armed when a request is dispatched
  // onto an idle socket, then refreshes it on the next idle period. A timer left
  // over from the first idle period must not tear down a slow in-flight
  // request, and the refreshed one must still close the socket afterwards.
  const server = http.createServer({ keepAliveTimeout: 60e3 }, (req, res) => {
    const delay = req.url === '/slow' ? 400 : 0
    setTimeout(() => res.end('ok'), delay)
  })
  after(() => server.close())
  server.listen(0)
  await once(server, 'listening')

  // The server advertises Keep-Alive: timeout=60; cap what the client honors.
  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeout: 200,
    keepAliveMaxTimeout: 200
  })
  after(() => client.destroy())

  let connects = 0
  client.on('connect', () => connects++)

  const first = await client.request({ path: '/', method: 'GET' })
  t.strictEqual(await first.body.text(), 'ok')

  // Idle briefly, then outlive the keep-alive timeout while waiting on headers.
  await new Promise(resolve => setTimeout(resolve, 50))
  const second = await client.request({ path: '/slow', method: 'GET' })
  t.strictEqual(await second.body.text(), 'ok')
  t.strictEqual(connects, 1)

  const start = performance.now()
  const [, , err] = await once(client, 'disconnect')
  t.strictEqual(err.code, 'UND_ERR_INFO')
  t.strictEqual(err.message, 'socket idle timeout')
  t.ok(performance.now() - start < 2e3)
  await t.completed
})

test('tracked response headers are matched case-insensitively', async (t) => {
  t = tspl(t, { plan: 4 })

  // Keep-Alive, Connection and Content-Length are recognised by name however
  // the server spells them: a truncated body must be caught through an
  // upper-case Content-Length, and an upper-case Keep-Alive must set the idle
  // timeout.
  const server = createServer((socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nCONTENT-LENGTH: 2\r\nKEEP-ALIVE: timeout=3\r\nCONNECTION: keep-alive\r\n\r\nok')
      socket.once('data', () => {
        socket.end('HTTP/1.1 200 OK\r\nCONTENT-LENGTH: 10\r\nCONNECTION: close\r\n\r\nshort')
      })
    })
  })
  after(() => server.close())
  server.listen(0)
  await once(server, 'listening')

  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeoutThreshold: 2e3
  })
  after(() => client.destroy())

  const first = await client.request({ path: '/', method: 'GET' })
  t.strictEqual(await first.body.text(), 'ok')
  // timeout=3 minus the 2 s threshold.
  t.strictEqual(client[kKeepAliveTimeoutValue], 1e3)

  const second = await client.request({ path: '/', method: 'GET' })
  const err = await second.body.text().then(() => null, (err) => err)
  t.ok(err)
  t.strictEqual(err.code, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH')
  await t.completed
})

test('a changed Keep-Alive timeout on a reused connection is honoured', async (t) => {
  t = tspl(t, { plan: 3 })

  // The parser remembers the last Keep-Alive value it parsed; a different
  // value on a later response of the same connection must still take effect.
  let responses = 0
  const server = createServer((socket) => {
    socket.on('data', () => {
      const timeout = ++responses === 1 ? 60 : 5
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: 0\r\nKeep-Alive: timeout=${timeout}\r\nConnection: keep-alive\r\n\r\n`)
    })
  })
  after(() => server.close())
  server.listen(0)
  await once(server, 'listening')

  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeoutThreshold: 2e3
  })
  after(() => client.destroy())

  await (await client.request({ path: '/', method: 'GET' })).body.dump()
  t.strictEqual(client[kKeepAliveTimeoutValue], 58e3)

  await (await client.request({ path: '/', method: 'GET' })).body.dump()
  t.strictEqual(client[kKeepAliveTimeoutValue], 3e3)
  t.strictEqual(responses, 2)
  await t.completed
})
