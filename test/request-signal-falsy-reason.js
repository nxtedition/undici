'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { finished } = require('node:stream/promises')
const { test } = require('node:test')
const { Client } = require('..')

// The request callback API reserves null/undefined for success. These are the
// falsy values that can unambiguously travel through its error position.
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

function assertAbortCarrier (err, reason) {
  assert(err instanceof Error)
  assert.strictEqual(err.name, 'AbortError')
  assert.strictEqual(err.code, 'UND_ERR_ABORTED')
  assert(Object.is(err.cause, reason))
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

test('a late body mixin preserves post-header falsy abort reasons', async (t) => {
  const { client } = await createTestClient(t, (req, res) => {
    res.writeHead(200)
    res.write('partial body')
  })

  for (const reason of reasons) {
    const controller = new AbortController()
    const { body } = await client.request({
      path: '/',
      method: 'GET',
      signal: controller.signal
    })
    const errorEvent = once(body, 'error')
    const closeEvent = new Promise(resolve => body.once('close', resolve))

    controller.abort(reason)

    const [emittedError] = await errorEvent
    await closeEvent
    const result = await capture(body.text())
    assertAbortCarrier(emittedError, reason)
    assert.strictEqual(result.status, 'rejected')
    assert(Object.is(result.reason, reason))
    assert.strictEqual(body.errored, emittedError)
  }
})

test('a pending body mixin preserves post-header falsy abort reasons', async (t) => {
  const { client } = await createTestClient(t, (req, res) => {
    res.writeHead(200)
    res.write('partial body')
  })

  for (const reason of reasons) {
    const controller = new AbortController()
    let callbackCalls = 0
    const { body } = await new Promise((resolve, reject) => {
      client.request({
        path: '/',
        method: 'GET',
        signal: controller.signal
      }, (err, data) => {
        callbackCalls++
        if (err != null) {
          reject(err)
        } else {
          resolve(data)
        }
      })
    })
    const errorEvent = once(body, 'error')
    const consumption = capture(body.text())

    controller.abort(reason)

    const [emittedError] = await errorEvent
    const result = await consumption
    assertAbortCarrier(emittedError, reason)
    assert.strictEqual(result.status, 'rejected')
    assert(Object.is(result.reason, reason))
    assert.strictEqual(callbackCalls, 1)
  }
})

test('post-header falsy abort reasons reject async iteration with an Error carrier', async (t) => {
  const { client } = await createTestClient(t, (req, res) => {
    res.writeHead(200)
    res.write('partial body')
  })

  for (const reason of reasons) {
    const controller = new AbortController()
    const { body } = await client.request({
      path: '/',
      method: 'GET',
      signal: controller.signal
    })
    const consumption = capture((async () => {
      for await (const chunk of body) {
        assert(chunk.length > 0)
      }
    })())

    controller.abort(reason)

    const result = await consumption
    assert.strictEqual(result.status, 'rejected')
    assertAbortCarrier(result.reason, reason)
    assert.strictEqual(body.errored, result.reason)
  }
})

test('post-header falsy abort reasons reject stream.finished with an Error carrier', async (t) => {
  const { client } = await createTestClient(t, (req, res) => {
    res.writeHead(200)
    res.write('partial body')
  })

  for (const reason of reasons) {
    const controller = new AbortController()
    const { body } = await client.request({
      path: '/',
      method: 'GET',
      signal: controller.signal
    })
    const completion = capture(finished(body))

    controller.abort(reason)

    const result = await completion
    assert.strictEqual(result.status, 'rejected')
    assertAbortCarrier(result.reason, reason)
    assert.strictEqual(body.errored, result.reason)
  }
})
