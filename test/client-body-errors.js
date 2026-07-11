'use strict'

const { tspl } = require('@matteo.collina/tspl')
const { test, after } = require('node:test')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { Blob } = require('node:buffer')
const { Client, errors } = require('..')

// Race a promise against a timeout so a regression (a wedged/never-settling
// dispatcher) fails the test cleanly instead of hanging the whole suite.
function withTimeout (promise, ms, message) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Regression for the FormData body crash.
//
// writeH1() used to `throw new Error('FormData is not supported')` synchronously
// for a FormData body. FormData dispatch is deferred via queueMicrotask (see
// client.js[kDispatch]), so the throw escaped DispatcherBase.dispatch()'s
// try/catch as an *uncaught exception* (process crash by default). It also
// unwound resume() before it could reset client[kResuming] from 2 back to 0,
// latching the `if (client[kResuming] === 2) return` guard so every later
// resume() — and therefore every later request — was a permanent no-op.
test('FormData body rejects gracefully without wedging the client', async (t) => {
  t = tspl(t, { plan: 3 })

  const server = createServer((req, res) => {
    res.end('ok')
  })
  after(() => server.close())

  server.listen(0)
  await once(server, 'listening')

  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  // 1) The FormData request must reject (not crash, not hang).
  await t.rejects(
    client.request({ path: '/', method: 'POST', body: new FormData() }),
    errors.InvalidArgumentError
  )

  // 2) The client must still be usable — i.e. kResuming was reset. Before the
  //    fix this second request hung forever (caught here by withTimeout).
  const { statusCode, body } = await withTimeout(
    client.request({ path: '/', method: 'GET' }),
    10000,
    'client dispatcher wedged after FormData body (kResuming latched at 2)'
  )
  t.strictEqual(statusCode, 200)
  t.strictEqual(await body.text(), 'ok')
})

// Regression for the writeBlob() pre-try assertion.
//
// writeBlob() is async and is called without await and without a .catch().
// Its `assert(contentLength === body.size)` used to sit *before* the try block,
// so when it failed the rejected promise was unobserved — an unhandled
// rejection that can terminate the process — instead of being routed through
// abort(err)/onError. A Blob subclass that exposes arrayBuffer() but not
// stream() (so it takes the writeBlob path rather than writeIterable), with a
// missing size and explicit content-length, must reject with the structured
// content-length mismatch error.
test('Blob subclass without stream() and mismatched size rejects gracefully', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer((req, res) => {
    res.end('ok')
  })
  after(() => server.close())

  server.listen(0)
  await once(server, 'listening')

  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  class ArrayBufferOnlyBlob extends Blob {
    // No `size` (so bodyLength() is null and contentLength comes from the
    // header below) and no stream() (so writeBlob handles it).
    get size () {
      return undefined
    }

    get stream () {
      return undefined
    }

    async arrayBuffer () {
      return new TextEncoder().encode('hello').buffer
    }
  }
  const blob = new ArrayBufferOnlyBlob(['hello'], { type: 'text/plain' })

  await t.rejects(
    withTimeout(
      client.request({
        path: '/',
        method: 'POST',
        body: blob,
        headers: { 'content-length': '5' }
      }),
      10000,
      'Blob request neither resolved nor rejected (unhandled rejection?)'
    ),
    errors.RequestContentLengthMismatchError
  )

  // The client must remain usable afterwards.
  const { statusCode, body } = await withTimeout(
    client.request({ path: '/', method: 'GET' }),
    10000,
    'client wedged after blob-like body'
  )
  t.strictEqual(statusCode, 200)
  await body.dump()
})

test('Blob subclass stream() errors reject gracefully without wedging the client', async (t) => {
  t = tspl(t, { plan: 4 })

  const server = createServer((req, res) => {
    res.end('ok')
  })
  let connections = 0
  server.on('connection', () => { connections++ })
  after(() => server.close())

  server.listen(0)
  await once(server, 'listening')

  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  const streamError = new Error('blob stream failed')
  class ThrowingStreamBlob extends Blob {
    stream () {
      throw streamError
    }
  }
  const blob = new ThrowingStreamBlob(['x'])

  try {
    await withTimeout(
      client.request({ path: '/', method: 'POST', body: blob }),
      10000,
      'Blob request neither resolved nor rejected'
    )
    t.fail('request should reject')
  } catch (err) {
    t.strictEqual(err, streamError)
  }

  const { statusCode, body } = await withTimeout(
    client.request({ path: '/', method: 'GET' }),
    10000,
    'client wedged after Blob stream() error'
  )
  t.strictEqual(statusCode, 200)
  t.strictEqual(await body.text(), 'ok')
  t.strictEqual(connections, 1, 'the healthy connection remains reusable')
})

test('tag-spoofed Blob bodies cannot inject headers', async (t) => {
  t = tspl(t, { plan: 4 })

  let requests = 0
  let connections = 0
  const server = createServer((req, res) => {
    requests++
    res.end('unexpected')
  })
  server.on('connection', () => { connections++ })
  after(() => server.close())

  server.listen(0)
  await once(server, 'listening')

  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  const bodies = [
    {
      [Symbol.toStringTag]: 'Blob',
      type: 'text/plain\r\nx-injected-via-type: yes',
      size: 1,
      stream () {
        return [Buffer.from('x')]
      }
    },
    {
      [Symbol.toStringTag]: 'File',
      type: 'text/plain',
      size: '1\r\nx-injected-via-size: yes',
      stream () {
        return [Buffer.from('x')]
      }
    }
  ]

  for (const body of bodies) {
    await t.rejects(
      client.request({ path: '/', method: 'POST', body }),
      errors.InvalidArgumentError
    )
  }

  await new Promise(resolve => setImmediate(resolve))
  t.strictEqual(requests, 0, 'no request reaches the server')
  t.strictEqual(connections, 0, 'invalid bodies are rejected before connecting')
})
