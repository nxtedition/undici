'use strict'

const { tspl } = require('@matteo.collina/tspl')
const { test, after } = require('node:test')
const net = require('node:net')
const { Client, errors } = require('..')

const truncatedChunkedResponse = Buffer.from(
  'HTTP/1.1 200 OK\r\n' +
  'Transfer-Encoding: chunked\r\n' +
  'Connection: close\r\n' +
  '\r\n' +
  '3\r\n' +
  'hel\r\n'
)

test('truncated chunked responses terminated by EOF error the response body', async (t) => {
  t = tspl(t, { plan: 3 })

  const server = net.createServer((socket) => {
    socket.end(truncatedChunkedResponse)
  })
  after(() => server.close())

  await new Promise(resolve => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.destroy())

  client.request({
    method: 'GET',
    path: '/'
  }, (err, { body } = {}) => {
    t.ifError(err)
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

test('https://github.com/mcollina/undici/issues/268', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = net.createServer(socket => {
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
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    client.request({
      method: 'GET',
      path: '/nxt/_changes?feed=continuous&heartbeat=5000',
      headersTimeout: 1e3
    }, (err, data) => {
      t.ifError(err)
      data.body
        .resume()
      setTimeout(() => {
        t.ok(true, 'pass')
        data.body.on('error', () => {})
      }, 2e3)
    })
  })

  await t.completed
})

test('parser fail', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = net.createServer(socket => {
    socket.write('HTT/1.1 200 OK\r\n')
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    client.request({
      method: 'GET',
      path: '/'
    }, (err, data) => {
      t.ok(err)
      t.ok(err instanceof errors.HTTPParserError)
    })
  })

  await t.completed
})

test('split header field', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = net.createServer(socket => {
    socket.write('HTTP/1.1 200 OK\r\nA')
    setTimeout(() => {
      socket.write('SD: asd,asd\r\n\r\n\r\n')
    }, 100)
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    client.request({
      method: 'GET',
      path: '/'
    }, (err, data) => {
      t.ifError(err)
      t.equal(data.headers.asd, 'asd,asd')
      data.body.destroy().on('error', () => {})
    })
  })

  await t.completed
})

test('split header value', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = net.createServer(socket => {
    socket.write('HTTP/1.1 200 OK\r\nASD: asd')
    setTimeout(() => {
      socket.write(',asd\r\n\r\n\r\n')
    }, 100)
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    client.request({
      method: 'GET',
      path: '/'
    }, (err, data) => {
      t.ifError(err)
      t.equal(data.headers.asd, 'asd,asd')
      data.body.destroy().on('error', () => {})
    })
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
})
