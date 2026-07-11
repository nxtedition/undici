'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { test } = require('node:test')
const { Client } = require('..')
const { kRunning } = require('../lib/core/symbols')

async function setup (t) {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`, {
    pipelining: 2
  })

  t.after(async () => {
    await client.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  return { client, server }
}

test('Client pipelines QUERY requests by default', async (t) => {
  const { client, server } = await setup(t)

  const firstRequest = once(server, 'request')
  const firstResponse = client.request({
    method: 'GET',
    path: '/first',
    blocking: false
  })
  const [firstIncoming, firstOutgoing] = await firstRequest

  assert.equal(firstIncoming.method, 'GET')

  const secondRequest = once(server, 'request', {
    signal: AbortSignal.timeout(5_000)
  })
  const secondResponse = client.request({
    method: 'QUERY',
    path: '/second',
    blocking: false
  })

  assert.equal(client[kRunning], 2)

  const [secondIncoming, secondOutgoing] = await secondRequest
  assert.equal(secondIncoming.method, 'QUERY')

  firstOutgoing.end('first')
  secondOutgoing.end('second')

  const [first, second] = await Promise.all([firstResponse, secondResponse])
  assert.equal(await first.body.text(), 'first')
  assert.equal(await second.body.text(), 'second')
})

test('Client honors idempotent: false for QUERY requests', async (t) => {
  const { client, server } = await setup(t)

  const firstRequest = once(server, 'request')
  const firstResponse = client.request({
    method: 'GET',
    path: '/first',
    blocking: false
  })
  const [firstIncoming, firstOutgoing] = await firstRequest

  assert.equal(firstIncoming.method, 'GET')

  const secondRequest = once(server, 'request', {
    signal: AbortSignal.timeout(5_000)
  })
  const secondResponse = client.request({
    method: 'QUERY',
    path: '/second',
    blocking: false,
    idempotent: false
  })

  assert.equal(client[kRunning], 1)

  firstOutgoing.end('first')

  const [secondIncoming, secondOutgoing] = await secondRequest
  assert.equal(secondIncoming.method, 'QUERY')
  secondOutgoing.end('second')

  const [first, second] = await Promise.all([firstResponse, secondResponse])
  assert.equal(await first.body.text(), 'first')
  assert.equal(await second.body.text(), 'second')
})
