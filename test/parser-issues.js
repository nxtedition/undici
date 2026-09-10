'use strict'

const { tspl } = require('@matteo.collina/tspl')
const { once } = require('node:events')
const { test } = require('node:test')
const net = require('node:net')
const { Client, errors } = require('..')

function createTrackedServer (onConnection) {
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
    })
    onConnection(socket)
  })

  return {
    server,
    async [Symbol.asyncDispose] () {
      for (const socket of sockets) {
        socket.destroy()
      }

      if (server.listening) {
        await server[Symbol.asyncDispose]()
      }
    }
  }
}

async function listen (server) {
  const listening = once(server, 'listening')
  server.listen(0)
  await listening
}

const truncatedChunkedResponse = Buffer.from(
  'HTTP/1.1 200 OK\r\n' +
  'Transfer-Encoding: chunked\r\n' +
  'Connection: close\r\n' +
  '\r\n' +
  '3\r\n' +
  'hel\r\n'
)

test('truncated chunked responses terminated by EOF error the response body', async (testContext) => {
  const t = tspl(testContext, { plan: 3 })
  const resources = new globalThis.AsyncDisposableStack()
  testContext.after(() => resources.disposeAsync())

  const { server } = resources.use(createTrackedServer(socket => {
    socket.end(truncatedChunkedResponse)
  }))

  await listen(server)

  const client = resources.use(new Client(`http://localhost:${server.address().port}`))

  client.request({
    method: 'GET',
    path: '/'
  }, (err, { body } = {}) => {
    t.ifError(err)
    if (err) {
      return
    }

    body
      .on('end', () => {
        t.fail('expected the truncated chunked body to fail')
      })
      .on('error', (err) => {
        t.strictEqual(err.name, 'HTTPParserError')
        t.strictEqual(err.message, 'Response does not match the HTTP/1.1 protocol (Invalid EOF state)')
      })
      .resume()
  })

  await t.completed
})

test('https://github.com/mcollina/undici/issues/268', async (testContext) => {
  const t = tspl(testContext, { plan: 2 })
  const resources = new globalThis.AsyncDisposableStack()
  testContext.after(() => resources.disposeAsync())

  const { server } = resources.use(createTrackedServer(socket => {
    socket.write('HTTP/1.1 200 OK\r\n')
    socket.write('Transfer-Encoding: chunked\r\n\r\n')
    setTimeout(() => {
      socket.write('1\r\n')
      socket.write('\n\r\n')
      setTimeout(() => {
        socket.write('1\r\n')
        socket.write('\n\r\n')
      }, 500)
    }, 500)
  }))

  await listen(server)

  const client = resources.use(new Client(`http://localhost:${server.address().port}`))
  client.on('disconnect', () => {
    if (!client.closed && !client.destroyed) {
      t.fail('unexpected disconnect')
    }
  })

  client.request({
    method: 'GET',
    path: '/nxt/_changes?feed=continuous&heartbeat=5000',
    headersTimeout: 1e3
  }, (err, data) => {
    t.ifError(err)
    if (err) {
      return
    }

    data.body.on('error', () => {})
    data.body.resume()
    setTimeout(() => {
      t.ok(true, 'pass')
    }, 2e3)
  })

  await t.completed
})

test('parser fail', async (testContext) => {
  const t = tspl(testContext, { plan: 2 })
  const resources = new globalThis.AsyncDisposableStack()
  testContext.after(() => resources.disposeAsync())

  const { server } = resources.use(createTrackedServer(socket => {
    socket.end('HTT/1.1 200 OK\r\n')
  }))

  await listen(server)

  const client = resources.use(new Client(`http://localhost:${server.address().port}`))
  client.request({
    method: 'GET',
    path: '/'
  }, (err, data) => {
    t.ok(err)
    t.ok(err instanceof errors.HTTPParserError)
  })

  await t.completed
})

test('split header field', async (testContext) => {
  const t = tspl(testContext, { plan: 2 })
  const resources = new globalThis.AsyncDisposableStack()
  testContext.after(() => resources.disposeAsync())

  const { server } = resources.use(createTrackedServer(socket => {
    socket.write('HTTP/1.1 200 OK\r\nA')
    setTimeout(() => {
      socket.end('SD: asd,asd\r\nContent-Length: 0\r\n\r\n')
    }, 100)
  }))

  await listen(server)

  const client = resources.use(new Client(`http://localhost:${server.address().port}`))
  client.request({
    method: 'GET',
    path: '/'
  }, (err, data) => {
    t.ifError(err)
    if (err) {
      return
    }

    t.equal(data.headers.asd, 'asd,asd')
    data.body.resume()
  })

  await t.completed
})

test('split header value', async (testContext) => {
  const t = tspl(testContext, { plan: 2 })
  const resources = new globalThis.AsyncDisposableStack()
  testContext.after(() => resources.disposeAsync())

  const { server } = resources.use(createTrackedServer(socket => {
    socket.write('HTTP/1.1 200 OK\r\nASD: asd')
    setTimeout(() => {
      socket.end(',asd\r\nContent-Length: 0\r\n\r\n')
    }, 100)
  }))

  await listen(server)

  const client = resources.use(new Client(`http://localhost:${server.address().port}`))
  client.request({
    method: 'GET',
    path: '/'
  }, (err, data) => {
    t.ifError(err)
    if (err) {
      return
    }

    t.equal(data.headers.asd, 'asd,asd')
    data.body.resume()
  })

  await t.completed
})

test('refreshes wasm input view after reallocating parser buffer', async (testContext) => {
  const t = tspl(testContext, { plan: 4 })
  const resources = new globalThis.AsyncDisposableStack()
  testContext.after(() => resources.disposeAsync())

  const smallBody = Buffer.from('ok')
  const largeBody = Buffer.alloc(8192, 'a')
  const responses = [
    Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${smallBody.length}\r\n\r\n`),
      smallBody
    ]),
    Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${largeBody.length}\r\n\r\n`),
      largeBody
    ])
  ]

  const server = resources.use(net.createServer(socket => {
    let responseIndex = 0
    let requestBuffer = ''

    socket.setEncoding('latin1')
    socket.on('data', chunk => {
      requestBuffer += chunk

      let requestEnd
      while ((requestEnd = requestBuffer.indexOf('\r\n\r\n')) !== -1) {
        requestBuffer = requestBuffer.slice(requestEnd + 4)

        const response = responses[responseIndex++]
        if (response === undefined) {
          t.fail('received an unexpected request')
          return
        }

        socket.write(response)
      }
    })
  }))

  await new Promise(resolve => server.listen(0, resolve))

  const client = resources.use(new Client(`http://localhost:${server.address().port}`))

  async function request () {
    const { statusCode, body } = await client.request({
      method: 'GET',
      path: '/'
    })

    return {
      statusCode,
      body: await body.text()
    }
  }

  const smallResponse = await request()
  t.strictEqual(smallResponse.statusCode, 200)
  t.strictEqual(smallResponse.body, smallBody.toString())

  const largeResponse = await request()
  t.strictEqual(largeResponse.statusCode, 200)
  t.strictEqual(largeResponse.body, largeBody.toString())

  await t.completed
})
