'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { Blob } = require('node:buffer')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { Readable } = require('node:stream')
const { test } = require('node:test')
const { Client, errors } = require('..')

async function startServer (t, handler) {
  const server = createServer(handler ?? (async (req, res) => {
    let body = ''
    try {
      for await (const chunk of req) {
        body += chunk
      }
    } catch {
      // The client aborted the upload.
      return
    }
    res.end(body)
  })).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

// Dispatches with a handler that records the request body hooks and the
// response lifecycle, in order. `hooks` overrides individual methods.
function dispatch (client, opts, hooks = {}) {
  const events = []
  let response = ''
  const done = new Promise((resolve) => {
    client.dispatch(opts, {
      onConnect (abort) {
        events.push('connect')
        hooks.onConnect?.(abort)
      },
      onRequestBegin () {
        events.push('begin')
        hooks.onRequestBegin?.()
      },
      onRequestData (chunk) {
        events.push(['data', typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()])
        hooks.onRequestData?.(chunk)
      },
      onRequestEnd () {
        events.push('end')
        hooks.onRequestEnd?.()
      },
      onHeaders (statusCode) {
        events.push(['headers', statusCode])
        return true
      },
      onData (chunk) {
        response += chunk
        return true
      },
      onComplete () {
        events.push('complete')
        resolve({ events, response, error: null })
      },
      onError (error) {
        events.push('error')
        resolve({ events, response, error })
      }
    })
  })
  return done
}

const bodies = [
  ['no body', 'GET', () => undefined, []],
  ['empty string', 'POST', () => '', []],
  ['string', 'POST', () => 'hello', ['hello']],
  ['Buffer', 'POST', () => Buffer.from('hello'), ['hello']],
  ['Uint8Array', 'POST', () => new TextEncoder().encode('hello'), ['hello']],
  ['Blob', 'POST', () => new Blob(['hello']), ['hello']],
  ['stream', 'POST', () => Readable.from([Buffer.from('he'), Buffer.from(''), Buffer.from('llo')], { objectMode: false }), ['he', 'llo']],
  ['stream with encoding', 'POST', () => Readable.from([Buffer.from('he'), Buffer.from('llo')], { objectMode: false }).setEncoding('utf8'), ['he', 'llo']],
  ['empty stream', 'POST', () => new Readable({ read () { this.push(null) } }), []],
  ['iterable', 'POST', () => ['he', Buffer.from('llo')], ['he', 'llo']],
  ['async iterable', 'POST', () => (async function * () { yield 'he'; yield ''; yield 'llo' })(), ['he', 'llo']],
  ['empty async iterable', 'POST', () => (async function * () {})(), []]
]

for (const [name, method, body, chunks] of bodies) {
  test(`${name} body: begin, each chunk and end are reported before the response`, async t => {
    const client = new Client(await startServer(t))
    t.after(() => client.destroy())

    const result = await dispatch(client, { path: '/', method, body: body() })

    assert.equal(result.error, null)
    assert.equal(result.response, chunks.join(''))
    assert.deepEqual(result.events, [
      'connect',
      'begin',
      ...chunks.map(chunk => ['data', chunk]),
      'end',
      ['headers', 200],
      'complete'
    ])
  })
}

test('a stream body with a content-length reports its chunks', async t => {
  const client = new Client(await startServer(t))
  t.after(() => client.destroy())

  const result = await dispatch(client, {
    path: '/',
    method: 'PUT',
    headers: { 'content-length': '5' },
    body: Readable.from([Buffer.from('he'), Buffer.from('llo')], { objectMode: false })
  })

  assert.equal(result.error, null)
  assert.equal(result.response, 'hello')
  assert.deepEqual(result.events, ['connect', 'begin', ['data', 'he'], ['data', 'llo'], 'end', ['headers', 200], 'complete'])
})

test('a scheduled Buffer body larger than 64 KiB is reported in chunks', async t => {
  const client = new Client(await startServer(t))
  t.after(() => client.destroy())

  const scheduler = { acquire (fn) { fn() }, release () {} }
  const body = Buffer.alloc(150 * 1024, 'a')
  const sizes = []
  const result = await dispatch(client, { path: '/', method: 'PUT', body, scheduler }, {
    onRequestData (chunk) { sizes.push(chunk.byteLength) }
  })

  assert.equal(result.error, null)
  assert.equal(result.response.length, body.byteLength)
  assert.deepEqual(sizes, [64 * 1024, 64 * 1024, 22 * 1024])
})

test('handlers without the hooks are unaffected', async t => {
  const client = new Client(await startServer(t))
  t.after(() => client.destroy())

  for (const body of [undefined, 'hello', Readable.from(['hello'])]) {
    const { statusCode, body: res } = await client.request({ path: '/', method: 'POST', body })
    assert.equal(statusCode, 200)
    assert.equal(await res.text(), body === undefined ? '' : 'hello')
  }
})

for (const hook of ['onRequestBegin', 'onRequestData', 'onRequestEnd']) {
  for (const [name, body] of [
    ['Buffer', () => 'hello'],
    ['stream', () => Readable.from(['he', 'llo'])],
    ['iterable', () => ['he', 'llo']]
  ]) {
    test(`a throwing ${hook} fails a ${name} body request with that error and the client recovers`, async t => {
      const client = new Client(await startServer(t))
      t.after(() => client.destroy())

      const failure = new Error('hook failed')
      const result = await dispatch(client, { path: '/', method: 'POST', body: body() }, {
        [hook] () { throw failure }
      })

      assert.equal(result.error, failure)
      assert.equal(result.events.at(-1), 'error')
      assert.ok(!result.events.includes('complete'))
      if (hook !== 'onRequestEnd') {
        assert.ok(!result.events.includes('end'))
      }

      const next = await dispatch(client, { path: '/', method: 'POST', body: 'next' })
      assert.equal(next.error, null)
      assert.equal(next.response, 'next')
    })
  }
}

for (const [name, body] of [
  ['stream', () => Readable.from(['hello'])],
  ['iterable', () => ['hello']]
]) {
  for (const throws of [false, true]) {
    test(`onRequestEnd can dispatch another request and ${throws ? 'throw' : 'return'} with a ${name} body`, async t => {
      // Keep a reentrant request queued until the hook succeeds or its upload aborts.
      const client = new Client(await startServer(t), { pipelining: 2 })
      t.after(() => client.destroy())

      const failure = new Error('hook failed')
      let next
      let connected = false
      let connectedDuringHook
      const result = await dispatch(client, {
        path: '/',
        method: 'POST',
        blocking: false,
        body: body()
      }, {
        onRequestEnd () {
          next = dispatch(client, { path: '/', method: 'POST', body: 'next', idempotent: true }, {
            onConnect () { connected = true }
          })
          connectedDuringHook = connected
          if (throws) throw failure
        }
      })

      assert.equal(connectedDuringHook, false)
      assert.equal(result.error, throws ? failure : null)
      assert.equal(result.events.at(-1), throws ? 'error' : 'complete')
      const subsequent = await next
      assert.equal(subsequent.error, null)
      assert.equal(subsequent.response, 'next')
    })
  }
}

test('aborting from onRequestData fails the request without onRequestEnd', async t => {
  const client = new Client(await startServer(t))
  t.after(() => client.destroy())

  let abort
  const reason = new Error('stop')
  const result = await dispatch(client, {
    path: '/',
    method: 'POST',
    body: Readable.from(['he', 'llo', 'world'])
  }, {
    onConnect (fn) { abort = fn },
    onRequestData () { abort(reason) }
  })

  assert.equal(result.error, reason)
  assert.deepEqual(result.events, ['connect', 'begin', ['data', 'he'], 'error'])

  const next = await dispatch(client, { path: '/', method: 'POST', body: 'next' })
  assert.equal(next.error, null)
  assert.equal(next.response, 'next')
})

test('no hook runs after a response that completes before its body has been written', async t => {
  const client = new Client(await startServer(t, (req, res) => {
    req.once('data', () => res.end('early'))
  }))
  t.after(() => client.destroy())

  let pushed = 0
  const body = new Readable({
    read () {
      // Keep producing until the request settles.
      setTimeout(() => {
        if (!this.destroyed) {
          this.push(Buffer.alloc(16 * 1024, 'a'))
        }
      }, 1)
      pushed++
    }
  })
  const result = await dispatch(client, { path: '/', method: 'POST', body })
  // Give the writer a chance to report anything it still had queued.
  await new Promise(resolve => setTimeout(resolve, 50))

  assert.equal(result.error, null)
  assert.equal(result.response, 'early')
  assert.ok(pushed > 0)
  const completed = result.events.indexOf('complete')
  assert.equal(result.events.at(0), 'connect')
  assert.equal(result.events.at(1), 'begin')
  assert.equal(completed, result.events.length - 1)
  assert.ok(!result.events.includes('end'))
})

test('telemetry forwards the hooks of class handlers in the captured context', async t => {
  const client = new Client(await startServer(t))
  t.after(() => client.destroy())

  const storage = new AsyncLocalStorage()
  const telemetry = {
    capture () {
      const parent = storage.getStore()
      return parent ? { run: callback => storage.run(parent, callback) } : null
    }
  }

  const contexts = []
  class Handler {
    constructor (resolve, reject) {
      this.resolve = resolve
      this.reject = reject
    }

    onConnect () {}
    onRequestBegin () { contexts.push(['begin', storage.getStore()]) }
    onRequestData (chunk) { contexts.push(['data', storage.getStore()]) }
    onRequestEnd () { contexts.push(['end', storage.getStore()]) }
    onHeaders () { return true }
    onData () { return true }
    onComplete () { this.resolve() }
    onError (err) { this.reject(err) }
  }

  await new Promise((resolve, reject) => storage.run('caller', () => {
    client.dispatch({
      path: '/',
      method: 'POST',
      body: Readable.from(['he', 'llo']),
      telemetry
    }, new Handler(resolve, reject))
  }))

  assert.deepEqual(contexts, [['begin', 'caller'], ['data', 'caller'], ['data', 'caller'], ['end', 'caller']])
})

test('content-length mismatches fail before onRequestEnd', async t => {
  const client = new Client(await startServer(t))
  t.after(() => client.destroy())

  const short = await dispatch(client, {
    path: '/',
    method: 'PUT',
    headers: { 'content-length': '10' },
    body: Readable.from([Buffer.from('hello')], { objectMode: false })
  })
  assert.ok(short.error instanceof errors.RequestContentLengthMismatchError)
  assert.deepEqual(short.events, ['connect', 'begin', ['data', 'hello'], 'error'])

  const long = await dispatch(client, {
    path: '/',
    method: 'PUT',
    headers: { 'content-length': '3' },
    body: Readable.from([Buffer.from('hello')], { objectMode: false })
  })
  assert.ok(long.error instanceof errors.RequestContentLengthMismatchError)
  assert.deepEqual(long.events, ['connect', 'error'])
})
