'use strict'

const assert = require('node:assert/strict')
const { tspl } = require('@matteo.collina/tspl')
const { test, after } = require('node:test')
const { Client, errors } = require('..')
const { createServer } = require('node:http')
const net = require('node:net')
const { once } = require('node:events')

test('ignore informational response', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((req, res) => {
    res.writeProcessing()
    req.pipe(res)
  })
  after(() => server.close())
  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  client.request({
    path: '/',
    method: 'POST',
    body: 'hello'
  }, (err, response) => {
    t.ifError(err)
    const bufs = []
    response.body.on('data', (buf) => {
      bufs.push(buf)
    })
    response.body.on('end', () => {
      t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
    })
  })

  await t.completed
})

test('error 103 body', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = net.createServer((socket) => {
    socket.write('HTTP/1.1 103 Early Hints\r\n')
    socket.write('Content-Length: 1\r\n')
    socket.write('\r\n')
    socket.write('a\r\n')
  })
  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`)

  after(() => server.close())
  after(() => client.close())

  client.on('disconnect', () => {
    t.ok(true, 'pass')
  })

  t.rejects(client.request({
    path: '/',
    method: 'GET'
  }), errors.HTTPParserError)

  await t.completed
})

test('ignore unsolicited 100 Continue response', async (t) => {
  t = tspl(t, { plan: 5 })

  let connections = 0
  const server = net.createServer({ joinDuplicateHeaders: true }, (socket) => {
    connections++
    let requests = 0
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk
      if (!received.includes('\r\n\r\n')) {
        return
      }

      received = ''
      requests++
      if (requests === 1) {
        socket.write(
          'HTTP/1.1 100 Continue\r\n\r\n' +
          'HTTP/1.1 200 OK\r\n' +
          'content-length: 5\r\n' +
          'connection: keep-alive\r\n\r\n' +
          'hello'
        )
      } else {
        socket.end(
          'HTTP/1.1 200 OK\r\n' +
          'content-length: 5\r\n' +
          'connection: close\r\n\r\n' +
          'world'
        )
      }
    })
  })
  after(() => server.close())
  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  const first = await client.request({ path: '/', method: 'GET' })
  t.strictEqual(first.statusCode, 200)
  t.strictEqual(await first.body.text(), 'hello')

  const second = await client.request({ path: '/', method: 'GET' })
  t.strictEqual(second.statusCode, 200)
  t.strictEqual(await second.body.text(), 'world')
  t.strictEqual(connections, 1)

  await t.completed
})

test('error 101 upgrade', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = net.createServer((socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: example/1\r\nConnection: Upgrade\r\n')
    socket.write('\r\n')
  })
  after(() => server.close())
  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  client.request({
    path: '/',
    method: 'GET'
  }, (err) => {
    t.strictEqual(err.message, 'bad upgrade')
  })
  client.on('disconnect', () => {
    t.ok(true, 'pass')
  })
  await t.completed
})

test('1xx response without timeouts', async t => {
  t = tspl(t, { plan: 2 })

  const server = createServer((req, res) => {
    res.writeProcessing()
    setTimeout(() => req.pipe(res), 2000)
  })
  after(() => server.close())
  server.listen(0)

  await once(server, 'listening')
  const client = new Client(`http://localhost:${server.address().port}`, {
    bodyTimeout: 0,
    headersTimeout: 0
  })
  after(() => client.close())

  client.request({
    path: '/',
    method: 'POST',
    body: 'hello'
  }, (err, response) => {
    t.ifError(err)
    const bufs = []
    response.body.on('data', (buf) => {
      bufs.push(buf)
    })
    response.body.on('end', () => {
      t.strictEqual('hello', Buffer.concat(bufs).toString('utf8'))
    })
  })
  await t.completed
})

for (const informationalStatus of [100, 103]) {
  test(`CONNECT waits for its final response after ${informationalStatus}`, async (t) => {
    const server = net.createServer((socket) => {
      t.after(() => socket.destroy())
      socket.once('data', () => {
        socket.end(
          `HTTP/1.1 ${informationalStatus} Informational\r\n\r\n` +
          'HTTP/1.1 200 Connection Established\r\nx-tunnel: established\r\n\r\ntunnel'
        )
      })
    })
    t.after(() => server.close())
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    const client = new Client(`http://127.0.0.1:${server.address().port}`)
    t.after(() => client.destroy())
    const informational = []
    const { statusCode, headers, socket } = await new Promise((resolve, reject) => {
      client.dispatch({ path: 'localhost:80', method: 'CONNECT' }, {
        onConnect () {},
        onHeaders (code) { informational.push(code) },
        onUpgrade (statusCode, headers, socket) { resolve({ statusCode, headers, socket }) },
        onComplete () { reject(new Error('unexpected normal response completion')) },
        onError: reject
      })
    })
    t.after(() => socket.destroy())
    assert.strictEqual(statusCode, 200)
    assert.deepStrictEqual(informational, [informationalStatus])
    assert.strictEqual(headers['x-tunnel'], 'established')
    const chunks = []
    for await (const chunk of socket) chunks.push(chunk)
    assert.strictEqual(Buffer.concat(chunks).toString(), 'tunnel')
  })
}
