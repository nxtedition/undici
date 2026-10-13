'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { test } = require('node:test')

const { Client, buildConnector } = require('..')

test('aborting a streaming response does not reconnect for the aborted request', async (t) => {
  const sockets = new Set()
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: ping\ndata: {}\n\n')
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const port = String(server.address().port)
  const connect = buildConnector()
  let connections = 0
  const client = new Client(`http://127.0.0.1:${port}`, {
    connect (opts, callback) {
      connections++
      return connect(opts, callback)
    }
  })

  t.after(async () => {
    await client.destroy()
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
    })
  })

  const controller = new AbortController()
  const response = await client.request({
    path: '/',
    method: 'POST',
    body: '{}',
    signal: controller.signal
  })
  await once(response.body, 'data')

  const disconnected = once(client, 'disconnect')
  controller.abort()
  await disconnected

  assert.strictEqual(connections, 1)
})
