'use strict'

const { tspl } = require('@matteo.collina/tspl')
const { test } = require('node:test')
const { request } = require('..')
const http = require('node:http')
const { once } = require('node:events')

test('inflight and close', async (t) => {
  const p = tspl(t, { plan: 3 })

  const server = http.createServer((req, res) => {
    res.writeHead(200)
    res.end('Response body')
    res.socket.end() // Close the connection immediately with every response
  })
  t.after(() => server.close())

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const url = `http://127.0.0.1:${server.address().port}`

  const first = await request(url)
  p.ok(true, 'first response')

  const firstBodyClosed = once(first.body, 'close').then(() => {
    p.ok(true, 'first body closed')
  })
  first.body.resume()

  const second = await request(url)
  p.ok(true, 'second response')

  const secondBodyClosed = once(second.body, 'close')
  second.body.resume()

  await Promise.all([
    firstBodyClosed,
    secondBodyClosed
  ])

  await p.completed
})
