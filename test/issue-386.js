'use strict'

const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { Readable } = require('node:stream')
const { test } = require('node:test')

const { Client, Pool } = require('..')

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

for (const Dispatcher of [Client, Pool]) {
  test(`${Dispatcher.name} reports a queued abort before the active request completes`, async (t) => {
    let finish
    const paths = []
    const server = createServer((req, res) => {
      paths.push(req.url)
      if (req.url === '/hold') {
        res.write('held')
        finish = () => res.end()
      } else {
        res.end('ok')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new Dispatcher(`http://127.0.0.1:${server.address().port}`, { connections: 1, pipelining: 1 })
    t.after(async () => {
      finish?.()
      await client.destroy()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    })

    const held = await client.request({ path: '/hold', method: 'GET' })
    const controller = new AbortController()
    const reason = new Error('cancel queued upload')
    const body = Readable.from(['upload'])
    const errors = []
    client.request({ path: '/cancel', method: 'POST', body, signal: controller.signal }, err => errors.push(err))
    controller.abort(reason)
    await new Promise(setImmediate)
    assert.deepStrictEqual(errors, [reason])
    assert.strictEqual(body.destroyed, true)

    finish()
    await held.body.dump()
    const next = await client.request({ path: '/next', method: 'GET' })
    assert.strictEqual(await next.body.text(), 'ok')
    assert.deepStrictEqual(paths, ['/hold', '/next'])
    assert.deepStrictEqual(errors, [reason])
  })
}
