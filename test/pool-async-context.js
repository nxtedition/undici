'use strict'

const assert = require('node:assert')
const { AsyncLocalStorage } = require('node:async_hooks')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { test } = require('node:test')
const { Client, Pool } = require('..')

// https://github.com/nodejs/undici/issues/5981
test('requests queued in a Pool keep their async context', async (t) => {
  const storage = new AsyncLocalStorage()
  const contexts = {}

  class ContextClient extends Client {
    dispatch (opts, handler) {
      contexts[opts.path] = storage.getStore()
      return super.dispatch(opts, handler)
    }
  }

  const server = createServer((req, res) => res.end('ok'))
  server.listen(0)
  await once(server, 'listening')
  t.after(() => server.close())

  const pool = new Pool(`http://localhost:${server.address().port}`, {
    connections: 1,
    factory: (origin, opts) => new ContextClient(origin, opts)
  })
  t.after(() => pool.close())

  await Promise.all(['a', 'b', 'c'].map((name) => storage.run(name, async () => {
    const { body } = await pool.request({ path: `/${name}`, method: 'GET' })
    await body.dump()
  })))

  assert.deepStrictEqual(contexts, { '/a': 'a', '/b': 'b', '/c': 'c' })
})
