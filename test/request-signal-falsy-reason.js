'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { test } = require('node:test')
const { Client } = require('..')

const reasons = [false, 0, 0n, '', NaN]

async function createTestClient (t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, resolve))
  t.after(() => server.close())

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(() => client.destroy())

  return { client, server }
}

async function capture (promise) {
  return promise.then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason })
  )
}

test('a pre-aborted request Promise preserves falsy reasons', async (t) => {
  let requestCount = 0
  const { client } = await createTestClient(t, (req, res) => {
    requestCount++
    res.end('unexpected request')
  })

  for (const reason of reasons) {
    const controller = new AbortController()
    controller.abort(reason)

    const result = await capture(client.request({
      path: '/',
      method: 'GET',
      signal: controller.signal
    }))

    assert.strictEqual(result.status, 'rejected')
    assert(Object.is(result.reason, reason))
  }

  assert.strictEqual(requestCount, 0)
})

test('a pre-aborted request callback preserves falsy reasons', async (t) => {
  let requestCount = 0
  const { client } = await createTestClient(t, (req, res) => {
    requestCount++
    res.end('unexpected request')
  })

  for (const reason of reasons) {
    const controller = new AbortController()
    controller.abort(reason)

    const result = await new Promise(resolve => {
      client.request({
        path: '/',
        method: 'GET',
        signal: controller.signal
      }, (err, data) => resolve({ err, data }))
    })

    assert(Object.is(result.err, reason))
    assert.deepStrictEqual(result.data, { opaque: null })
  }

  assert.strictEqual(requestCount, 0)
})

test('an in-flight request Promise preserves falsy abort reasons', async (t) => {
  const { client, server } = await createTestClient(t, () => {})

  for (const reason of reasons) {
    const controller = new AbortController()
    const requestReceived = once(server, 'request')
    const request = client.request({
      path: '/',
      method: 'GET',
      signal: controller.signal
    })

    await requestReceived
    controller.abort(reason)

    const result = await capture(request)
    assert.strictEqual(result.status, 'rejected')
    assert(Object.is(result.reason, reason))
  }
})

test('an in-flight request callback preserves falsy abort reasons', async (t) => {
  const { client, server } = await createTestClient(t, () => {})

  for (const reason of reasons) {
    const controller = new AbortController()
    const requestReceived = once(server, 'request')
    const result = new Promise(resolve => {
      client.request({
        path: '/',
        method: 'GET',
        signal: controller.signal
      }, (err, data) => resolve({ err, data }))
    })

    await requestReceived
    controller.abort(reason)

    const { err, data } = await result
    assert(Object.is(err, reason))
    assert.deepStrictEqual(data, { opaque: null })
  }
})
