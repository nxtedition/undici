'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Pool, Agent, errors } = require('../..')

const factories = [
  ['Pool', (origin, options) => new Pool(origin, options)],
  ['Agent with one connection', (origin, options) => new Agent({ ...options, connections: 1 })],
  ['Agent with a pool', (origin, options) => new Agent(options)]
]

for (const [name, createDispatcher] of factories) {
  test(`${name} preserves invalid pipelining values for Client validation`, async () => {
    const origin = 'http://localhost:200'
    const invalid = ['x', '1', -1, 1.5, NaN, Infinity, -Infinity, true, {}, Symbol('pipelining'), () => 1, 1n, { toJSON: () => 1 }]

    for (const pipelining of invalid) {
      let connects = 0
      const dispatcher = createDispatcher(origin, {
        pipelining,
        connect (options, callback) {
          connects++
          callback(new Error('unexpected connection'))
        }
      })
      const checkError = (err) => err instanceof errors.InvalidArgumentError &&
        err.message === 'pipelining must be a positive integer or zero'

      try {
        await assert.rejects(dispatcher.request({ origin, method: 'GET', path: '/' }), checkError)
        await assert.rejects(new Promise((resolve, reject) => {
          dispatcher.request({ origin, method: 'GET', path: '/' }, (err) => {
            if (err) reject(err)
            else resolve()
          })
        }), checkError)
        assert.equal(connects, 0)
      } finally {
        await dispatcher.destroy()
      }
    }
  })

  test(`${name} accepts valid and nullish pipelining values`, async (t) => {
    const server = createServer((req, res) => res.end('ok'))
    t.after(() => new Promise((resolve) => server.close(resolve)))
    server.listen(0)
    await once(server, 'listening')
    const origin = `http://localhost:${server.address().port}`

    for (const pipelining of [0, 1, 10, null, undefined]) {
      const dispatcher = createDispatcher(origin, { pipelining })
      try {
        const response = await dispatcher.request({ origin, method: 'GET', path: '/' })
        assert.equal(response.statusCode, 200)
        assert.equal(await response.body.text(), 'ok')
      } finally {
        await dispatcher.destroy()
      }
    }
  })
}
