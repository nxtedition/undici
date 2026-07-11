'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const net = require('node:net')
const { test } = require('node:test')
const { Client } = require('..')

async function listen (server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}

async function readBody (body) {
  const chunks = []

  for await (const chunk of body) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString()
}

function countRequests (socket, onRequest) {
  let buffered = ''

  socket.on('data', (chunk) => {
    buffered += chunk.toString('latin1')

    let end
    while ((end = buffered.indexOf('\r\n\r\n')) !== -1) {
      buffered = buffered.slice(end + 4)
      onRequest()
    }
  })
}

test('304 Content-Length describes the selected representation, not a response body', async (t) => {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end(
        'HTTP/1.1 304 Not Modified\r\n' +
        'Content-Length: 123\r\n' +
        'Connection: close\r\n' +
        '\r\n'
      )
    })
  })

  await listen(server)
  t.after(() => server.close())

  const client = new Client(`http://127.0.0.1:${server.address().port}`)
  t.after(() => client.close())

  const response = await client.request({ path: '/', method: 'GET' })

  assert.strictEqual(response.statusCode, 304)
  assert.strictEqual(response.headers['content-length'], '123')
  assert.strictEqual(await readBody(response.body), '')
})

test('keeps a connection reusable after a 304 with Content-Length', async (t) => {
  let connections = 0
  let requests = 0

  const server = net.createServer((socket) => {
    connections++
    countRequests(socket, () => {
      requests++

      if (requests === 1) {
        socket.write(
          'HTTP/1.1 304 Not Modified\r\n' +
          'Content-Length: 123\r\n' +
          'Connection: keep-alive\r\n' +
          '\r\n'
        )
      } else {
        socket.end(
          'HTTP/1.1 200 OK\r\n' +
          'Content-Length: 4\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          'next'
        )
      }
    })
  })

  await listen(server)
  t.after(() => server.close())

  const client = new Client(`http://127.0.0.1:${server.address().port}`)
  t.after(() => client.close())

  const response1 = await client.request({ path: '/first', method: 'GET' })
  assert.strictEqual(response1.statusCode, 304)
  assert.strictEqual(await readBody(response1.body), '')

  const response2 = await client.request({ path: '/second', method: 'GET' })
  assert.strictEqual(response2.statusCode, 200)
  assert.strictEqual(await readBody(response2.body), 'next')
  assert.strictEqual(connections, 1)
})

test('does not consume a pipelined response as 304 content', async (t) => {
  let requests = 0

  const server = net.createServer((socket) => {
    countRequests(socket, () => {
      if (++requests === 2) {
        socket.end(
          'HTTP/1.1 304 Not Modified\r\n' +
          'Content-Length: 5\r\n' +
          'Connection: keep-alive\r\n' +
          '\r\n' +
          'HTTP/1.1 200 OK\r\n' +
          'Content-Length: 5\r\n' +
          'Connection: close\r\n' +
          'X-Response: second\r\n' +
          '\r\n' +
          'hello'
        )
      }
    })
  })

  await listen(server)
  t.after(() => server.close())

  const client = new Client(`http://127.0.0.1:${server.address().port}`, {
    pipelining: 2
  })
  t.after(() => client.close())

  const response1Promise = client.request({ path: '/first', method: 'GET', blocking: false })
  const response2Promise = client.request({ path: '/second', method: 'GET', blocking: false })
  const [response1, response2] = await Promise.all([response1Promise, response2Promise])

  assert.strictEqual(response1.statusCode, 304)
  assert.strictEqual(response1.headers['content-length'], '5')
  assert.strictEqual(await readBody(response1.body), '')
  assert.strictEqual(response2.statusCode, 200)
  assert.strictEqual(response2.headers['x-response'], 'second')
  assert.strictEqual(await readBody(response2.body), 'hello')
})

test('preserves HEAD and 204 Content-Length handling', async (t) => {
  let requests = 0

  const server = net.createServer((socket) => {
    countRequests(socket, () => {
      if (++requests === 1) {
        socket.write(
          'HTTP/1.1 200 OK\r\n' +
          'Content-Length: 5\r\n' +
          'Connection: keep-alive\r\n' +
          '\r\n'
        )
      } else {
        socket.end(
          'HTTP/1.1 204 No Content\r\n' +
          'Content-Length: 5\r\n' +
          'Connection: close\r\n' +
          '\r\n'
        )
      }
    })
  })

  await listen(server)
  t.after(() => server.close())

  const client = new Client(`http://127.0.0.1:${server.address().port}`)
  t.after(() => client.close())

  const headResponse = await client.request({ path: '/head', method: 'HEAD' })
  assert.strictEqual(headResponse.statusCode, 200)
  assert.strictEqual(headResponse.headers['content-length'], '5')
  assert.strictEqual(await readBody(headResponse.body), '')

  const noContentResponse = await client.request({ path: '/no-content', method: 'GET' })
  await assert.rejects(readBody(noContentResponse.body), {
    code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH'
  })
})
