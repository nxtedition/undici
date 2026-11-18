'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { test } = require('node:test')
const { Client } = require('../..')

for (const firstStatus of [200, 103]) {
  test(`pipeline interruption after ${firstStatus} headers`, { timeout: 5000 }, async (t) => {
    // Only a request still waiting for its final headers may restart.
    const neighbourReceived = Promise.withResolvers()
    let attempts = 0
    const server = createServer((req, res) => {
      if (req.url === '/cancel') {
        neighbourReceived.resolve()
      } else if (req.url === '/next') {
        res.end('next')
      } else if (++attempts > 1) {
        res.end('complete')
      } else if (firstStatus === 103) {
        res.writeEarlyHints({ link: '</style.css>; rel=preload; as=style' })
      } else {
        res.write('partial')
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => {
      server.closeAllConnections()
      return new Promise(resolve => server.close(resolve))
    })

    const client = new Client(`http://127.0.0.1:${server.address().port}`, { pipelining: 2 })
    t.after(() => client.destroy())
    const received = Promise.withResolvers()
    const statuses = []
    const chunks = []
    const result = new Promise((resolve, reject) => {
      client.dispatch({ method: 'GET', path: '/head', blocking: false }, {
        onConnect () {},
        onHeaders (status) {
          statuses.push(status)
          if (status === 103) received.resolve()
          return true
        },
        onData (chunk) {
          chunks.push(chunk)
          received.resolve()
          return true
        },
        onComplete: resolve,
        onError: reject
      })
    })
    const controller = new AbortController()
    const neighbour = client.request({ method: 'GET', path: '/cancel', signal: controller.signal })
    await Promise.all([received.promise, neighbourReceived.promise])
    const outcome = firstStatus === 200 ? assert.rejects(result, { code: 'UND_ERR_SOCKET' }) : result
    const cancelled = assert.rejects(neighbour, { name: 'AbortError' })
    controller.abort()
    await Promise.all([outcome, cancelled])

    assert.deepEqual(statuses, firstStatus === 200 ? [200] : [103, 200])
    assert.equal(Buffer.concat(chunks).toString(), firstStatus === 200 ? 'partial' : 'complete')
    assert.equal(attempts, firstStatus === 200 ? 1 : 2)
    const next = await client.request({ method: 'GET', path: '/next' })
    assert.equal(await next.body.text(), 'next')
    await client.close()
  })
}
