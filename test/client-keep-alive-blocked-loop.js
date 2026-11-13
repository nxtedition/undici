'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { once } = require('node:events')
const { stat } = require('node:fs')
const { createServer } = require('node:http')
const { setImmediate: waitImmediate } = require('node:timers/promises')
const { Client } = require('..')

function sleepSync (ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

async function setup (t, keepAliveTimeout) {
  const state = { connections: 0, disconnects: [] }
  const server = createServer((req, res) => res.end('ok'))

  server.keepAliveTimeout = 0
  server.on('connection', () => state.connections++)
  server.listen(0)
  await once(server, 'listening')

  const client = new Client(`http://localhost:${server.address().port}`, {
    keepAliveTimeout
  })
  client.on('disconnect', (origin, targets, err) => {
    state.disconnects.push(err)
  })

  t.after(async () => {
    await client.close()
    server.close()
  })

  const res = await client.request({ path: '/', method: 'GET' })
  assert.strictEqual(await res.body.text(), 'ok')
  await waitImmediate()
  assert.strictEqual(state.connections, 1)

  return { client, state }
}

function requestAfterBlockInPollPhase (client, blockMs) {
  return new Promise((resolve, reject) => {
    stat(__filename, () => {
      sleepSync(blockMs)
      client.request({ path: '/', method: 'GET' }).then(resolve, reject)
    })
  })
}

test('does not reuse an expired idle socket after the event loop was blocked', async (t) => {
  const { client, state } = await setup(t, 200)

  const res = await requestAfterBlockInPollPhase(client, 600)
  assert.strictEqual(await res.body.text(), 'ok')

  assert.strictEqual(state.connections, 2)
  assert.strictEqual(state.disconnects.length, 1)
  assert.strictEqual(state.disconnects[0].code, 'UND_ERR_INFO')
  assert.strictEqual(state.disconnects[0].message, 'socket idle timeout')
})

test('reuses an unexpired idle socket after the event loop was blocked', async (t) => {
  const { client, state } = await setup(t, 60e3)

  const res = await requestAfterBlockInPollPhase(client, 600)
  assert.strictEqual(await res.body.text(), 'ok')

  assert.strictEqual(state.connections, 1)
  assert.strictEqual(state.disconnects.length, 0)
})
