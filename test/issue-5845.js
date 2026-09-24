'use strict'

// https://github.com/nodejs/undici/issues/5845
//
// Aborting a request while its response is streaming destroys the socket with
// an informational error. The close handler then puts the request back in the
// pending segment, and the client used to open a fresh connection for it, only
// discovering after connecting that the request had already been aborted.

const { tspl } = require('@matteo.collina/tspl')
const { test, after } = require('node:test')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Client } = require('..')
const { kSize, kConnecting } = require('../lib/core/symbols')

test('aborting a streaming response does not reconnect for it', async (t) => {
  t = tspl(t, { plan: 4 })

  let connections = 0
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {}\n\n')
  })
  server.on('connection', () => { connections++ })
  after(() => {
    server.closeAllConnections()
    server.close()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const client = new Client(`http://127.0.0.1:${server.address().port}`)
  after(() => client.destroy())

  let connects = 0
  client.on('connect', () => { connects++ })

  const ac = new AbortController()
  const { body } = await client.request({ path: '/', method: 'GET', signal: ac.signal })
  body.on('error', () => {})
  await once(body, 'data')

  const disconnected = once(client, 'disconnect')
  ac.abort()
  await disconnected

  // The disconnect handler resumes the client synchronously; a reconnect for
  // the aborted request would already be in flight here.
  await new Promise((resolve) => setImmediate(resolve))
  t.strictEqual(client[kSize], 0)
  t.ok(!client[kConnecting])

  // Give an erroneous connection attempt time to reach the server.
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.strictEqual(connects, 1)
  t.strictEqual(connections, 1)
  await t.completed
})
