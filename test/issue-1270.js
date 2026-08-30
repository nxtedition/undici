'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  Agent,
  Client,
  Pool,
  errors,
  request
} = require('..')

function isInstanceDispatcherError (err) {
  assert.ok(err instanceof errors.InvalidArgumentError)
  assert.match(err.message, /opts\.dispatcher is not supported by instance methods/)
  return true
}

// Ported from nodejs/undici PR #5007 / issue #1270.
test('Pool.request rejects opts.dispatcher without connecting', async (t) => {
  const pool = new Pool('http://localhost')
  const otherAgent = new Agent()
  t.after(() => pool.destroy())
  t.after(() => otherAgent.destroy())

  await assert.rejects(pool.request({
    path: '/',
    method: 'GET',
    dispatcher: otherAgent
  }), isInstanceDispatcherError)
})

test('Client.request rejects opts.dispatcher without connecting', async (t) => {
  const client = new Client('http://localhost')
  const otherAgent = new Agent()
  t.after(() => client.destroy())
  t.after(() => otherAgent.destroy())

  await assert.rejects(client.request({
    path: '/',
    method: 'GET',
    dispatcher: otherAgent
  }), isInstanceDispatcherError)
})

test('top-level request consumes opts.dispatcher without forwarding it', async () => {
  const dispatcher = {
    dispatch (opts, handler) {
      assert.equal(Object.hasOwn(opts, 'dispatcher'), false)
      assert.equal(opts.origin, 'http://localhost')
      assert.equal(opts.path, '/resource?key=value')
      assert.equal(opts.method, 'GET')

      handler.onConnect(() => {}, null)
      handler.onHeaders(200, { 'content-type': 'text/plain' }, () => {})
      handler.onData(Buffer.from('hello'))
      handler.onComplete(null)
      return true
    }
  }

  const { statusCode, body } = await request('http://localhost/resource?key=value', {
    dispatcher
  })

  assert.equal(statusCode, 200)
  assert.equal(await body.text(), 'hello')
})
