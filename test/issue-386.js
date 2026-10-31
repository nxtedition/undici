'use strict'

const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { test } = require('node:test')

const { Client } = require('..')

function createClient (t) {
  let connections = 0
  const client = new Client('http://localhost', {
    connect (_opts, callback) {
      connections++
      callback(new Error('unexpected connection'), null)
    }
  })
  t.after(() => client.destroy())

  return {
    client,
    connections: () => connections
  }
}

test('an already aborted request rejects without connecting', async (t) => {
  const { client, connections } = createClient(t)
  const reason = new Error('aborted before dispatch')
  const controller = new AbortController()
  controller.abort(reason)

  const error = await client.request({
    path: '/',
    method: 'GET',
    signal: controller.signal
  }).then(() => null, (error) => error)

  assert.strictEqual(error, reason)
  assert.strictEqual(connections(), 0)
})

test('an already aborted request destroys a stream body', async (t) => {
  const { client, connections } = createClient(t)
  const body = new Readable({ read () {} })
  const controller = new AbortController()
  controller.abort()

  const error = await client.request({
    path: '/',
    method: 'POST',
    body,
    signal: controller.signal
  }).then(() => null, (error) => error)

  assert.strictEqual(error?.name, 'AbortError')
  assert.strictEqual(body.destroyed, true)
  assert.strictEqual(connections(), 0)
})
