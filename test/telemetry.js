'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { test } = require('node:test')
const { Agent, Client, Pool } = require('..')

function instrumentation () {
  const storage = new AsyncLocalStorage()
  const captures = []
  const attempts = []
  const telemetry = {
    capture () {
      const parent = storage.getStore()
      captures.push(parent)
      if (!parent) return null
      return {
        run: callback => storage.run(parent, callback),
        headers: { traceparent: parent, baggage: undefined, 'Request-Id': 'wrong-parent-id' },
        requestId: parent,
        start (options) {
          const attempt = { parent, origin: options.origin, path: options.path, statuses: [], results: [] }
          attempts.push(attempt)
          return {
            headers: { traceparent: `${parent}:${attempts.length}`, 'request-id': 'wrong-attempt-id' },
            run: callback => storage.run(`${parent}:attempt`, callback),
            onHeaders: code => attempt.statuses.push(code),
            end: result => attempt.results.push(result)
          }
        }
      }
    }
  }
  return { storage, captures, attempts, telemetry }
}

for (const Constructor of [Client, Pool, Agent]) {
  test(`${Constructor.name}: constructor defaults, overrides and capture before shared queues`, async t => {
    const seen = []
    const server = createServer((req, res) => {
      seen.push(req.headers)
      setTimeout(() => res.end(req.url), 5)
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    const hooks = instrumentation()
    const options = { telemetry: hooks.telemetry, connections: 1, pipelining: 1 }
    const client = Constructor === Agent ? new Agent(options) : new Constructor(origin, options)
    t.after(async () => { await client.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
    const request = (parent, telemetry) => hooks.storage.run(parent, () => client.request({
      origin, path: `/${parent}`, method: 'GET', ...(telemetry === undefined ? {} : { telemetry }),
      headers: { TraceParent: 'stale', baggage: 'private=value', 'x-extra': 'kept', connection: undefined }
    }))
    const responses = await Promise.all([request('first'), request('second')])
    assert.deepEqual(await Promise.all(responses.map(response => response.body.text())), ['/first', '/second'])
    assert.deepEqual(hooks.captures, ['first', 'second'])
    assert.deepEqual(seen.map(headers => headers.traceparent), ['first:1', 'second:2'])
    assert.deepEqual(seen.map(headers => headers['request-id']), ['first', 'second'])
    assert.ok(seen.every(headers => !headers.baggage && headers['x-extra'] === 'kept' && headers.connection !== 'undefined'))
    assert.ok(hooks.attempts.every(attempt => String(attempt.origin) === origin && attempt.results.length === 1))
    assert.deepEqual(hooks.attempts.map(attempt => attempt.statuses), [[200], [200]])
    const disabled = await request('disabled', false)
    await disabled.body.dump()
    assert.equal(seen[2].traceparent, 'stale')
    assert.equal(hooks.captures.length, 2)
    const override = instrumentation()
    const explicit = await override.storage.run('override', () => request('unused', override.telemetry))
    await explicit.body.dump()
    assert.deepEqual(override.captures, ['override'])
    assert.equal(seen[3].traceparent, 'override:1')
  })
}

test('callbacks, backpressure and resume/abort retain the submitted context', async t => {
  const hooks = instrumentation()
  const server = createServer((_req, res) => res.end('body')).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = new Client(`http://127.0.0.1:${server.address().port}`, { telemetry: hooks.telemetry })
  t.after(async () => { await client.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const contexts = []
  await new Promise((resolve, reject) => hooks.storage.run('caller', () => client.dispatch({ path: '/', method: 'GET' }, {
    onConnect () { contexts.push(hooks.storage.getStore()) },
    onHeaders (_status, _headers, resume) {
      contexts.push(hooks.storage.getStore())
      hooks.storage.run('other', () => setImmediate(resume))
      return false
    },
    onData () { contexts.push(hooks.storage.getStore()); return true },
    onComplete () { contexts.push(hooks.storage.getStore()); resolve() },
    onError: reject
  })))
  assert.deepEqual(contexts, ['caller', 'caller', 'caller', 'caller'])
  assert.deepEqual(hooks.attempts[0].results, [{ type: 'complete' }])
  const reason = new Error('cancelled')
  await new Promise(resolve => hooks.storage.run('abort', () => client.dispatch({ path: '/', method: 'GET' }, {
    onConnect (abort) { hooks.storage.run('other', () => abort(reason)) },
    onHeaders () {}, onData () {}, onComplete () {},
    onError (error) { assert.equal(error, reason); assert.equal(hooks.storage.getStore(), 'abort'); resolve() }
  })))
  assert.deepEqual(hooks.attempts[1].results, [{ type: 'error', error: reason, aborted: true }])
})

test('invalid hooks and request options fail normally; parentless capture bypasses spans', async t => {
  assert.throws(() => new Client('http://localhost', { telemetry: true }), /capture/)
  const hooks = instrumentation()
  const client = new Client('http://localhost', { telemetry: hooks.telemetry })
  t.after(() => client.destroy())
  await assert.rejects(client.request({ path: '/', method: 'GET', telemetry: true }), /capture/)
  await assert.rejects(hooks.storage.run('parent', () => client.request({ path: 'invalid', method: 'GET' })), /path/)
  assert.equal(hooks.attempts[0].results[0].type, 'error')
  assert.equal(hooks.attempts[0].results.length, 1)
  await assert.rejects(client.request({ path: 'invalid', method: 'GET' }), /path/)
  assert.equal(hooks.attempts.length, 1)
})

test('upgrades finish the attempt and retain the original handler receiver', async t => {
  const hooks = instrumentation()
  const server = createServer().listen(0, '127.0.0.1')
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: test\r\n\r\n'))
  await once(server, 'listening')
  const client = new Client(`http://127.0.0.1:${server.address().port}`)
  t.after(async () => { await client.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await new Promise((resolve, reject) => {
    class Handler {
      #value = 'receiver'
      onConnect () { assert.equal(this.#value, 'receiver') }
      onUpgrade (_status, _headers, socket) {
        assert.equal(this.#value, 'receiver')
        assert.equal(hooks.storage.getStore(), 'parent')
        socket.destroy()
        resolve()
      }
      onError (error) { reject(error) }
    }
    hooks.storage.run('parent', () => client.dispatch({ path: '/', method: 'GET', upgrade: 'test', telemetry: hooks.telemetry }, new Handler()))
  })
  assert.deepEqual(hooks.attempts[0].results, [{ type: 'upgrade' }])
})

test('observer failures do not block completion; aborting a queued request ends its span', async t => {
  const hooks = instrumentation()
  const server = createServer((_req, res) => setTimeout(() => res.end('ok'), 20)).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = new Client(`http://127.0.0.1:${server.address().port}`, { pipelining: 1 })
  t.after(async () => { await client.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const controller = new AbortController()
  const first = hooks.storage.run('first', () => client.request({ path: '/', method: 'GET', telemetry: hooks.telemetry }))
  const second = hooks.storage.run('second', () => client.request({ path: '/', method: 'GET', signal: controller.signal, telemetry: hooks.telemetry }))
  const rejected = assert.rejects(second, /queued cancellation/)
  controller.abort(new Error('queued cancellation'))
  await (await first).body.dump()
  await rejected
  assert.equal(hooks.attempts[1].results.length, 1)
  assert.equal(hooks.attempts[1].results[0].type, 'error')
  const response = await client.request({ path: '/', method: 'GET', telemetry: {
    capture: () => ({ run: callback => callback(), start: () => ({
      onHeaders () { throw new Error('observer') },
      end () { throw new Error('observer') }
    }) })
  } })
  assert.equal(await response.body.text(), 'ok')
})
