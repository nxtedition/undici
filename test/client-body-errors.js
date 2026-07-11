'use strict'

const assert = require('node:assert/strict')
const { Blob } = require('node:buffer')
const { Readable } = require('node:stream')
const { tspl } = require('@matteo.collina/tspl')
const { test, after } = require('node:test')
const { createServer } = require('node:http')
const { once } = require('node:events')
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

for (const accessor of ['size', 'type', 'stream']) {
  test(`throwing Blob ${accessor} accessor rejects before queueing`, async (t) => {
    const server = createServer((req, res) => {
      res.end('ok')
    })
    let connections = 0
    server.on('connection', () => { connections++ })
    await new Promise((resolve) => server.listen(0, resolve))

    const client = new Client(`http://localhost:${server.address().port}`)
    t.after(async () => {
      await client.destroy()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    })

    const accessorError = new Error(`${accessor} accessor failed`)
    class ThrowingBlob extends Blob {}
    Object.defineProperty(ThrowingBlob.prototype, accessor, {
      configurable: true,
      get () {
        throw accessorError
      }
    })

    const rejection = await client.request({
      path: '/',
      method: 'POST',
      body: new ThrowingBlob(['payload'])
    }).then(
      () => null,
      (err) => err
    )

    assert.strictEqual(rejection, accessorError)

    const { statusCode, body } = await withTimeout(
      client.request({ path: '/', method: 'GET' }),
      10000,
      `client wedged after throwing Blob ${accessor} accessor`
    )
    assert.strictEqual(statusCode, 200)
    assert.strictEqual(await body.text(), 'ok')
    assert.strictEqual(connections, 1, 'failed Blob must not touch socket state')

    await withTimeout(
      client.close(),
      10000,
      `client close hung after throwing Blob ${accessor} accessor`
    )
  })
}

test('explicit content-type bypasses an unused Blob type accessor', async (t) => {
  let requestBody
  let requestHeaders
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    requestBody = Buffer.concat(chunks).toString()
    requestHeaders = req.headers
    res.end('ok')
  })
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(async () => {
    await client.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  class ThrowingTypeBlob extends Blob {
    get type () {
      throw new Error('unused Blob type must not be read')
    }
  }

  const { body } = await client.request({
    path: '/',
    method: 'POST',
    body: new ThrowingTypeBlob(['payload']),
    headers: { 'content-type': 'application/custom' }
  })

  assert.strictEqual(await body.text(), 'ok')
  assert.strictEqual(requestBody, 'payload')
  assert.strictEqual(requestHeaders['content-type'], 'application/custom')
})

test('native Blob takes precedence over iterable and FormData lookalikes', async (t) => {
  let requestBody
  let requestHeaders
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    requestBody = Buffer.concat(chunks).toString()
    requestHeaders = req.headers
    res.end('ok')
  })
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(async () => {
    await client.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  class IterableBlob extends Blob {
    get append () {
      throw new Error('FormData properties must not be inspected for Blobs')
    }

    * [Symbol.iterator] () {
      yield 'wrong iterable payload'
    }
  }

  const { body } = await client.request({
    path: '/',
    method: 'POST',
    body: new IterableBlob(['native Blob payload'], { type: 'text/plain' })
  })

  assert.strictEqual(await body.text(), 'ok')
  assert.strictEqual(requestBody, 'native Blob payload')
  assert.strictEqual(requestHeaders['content-type'], 'text/plain')
  assert.strictEqual(requestHeaders['content-length'], '19')
})

test('stream body does not inspect a throwing Symbol.toStringTag accessor', async (t) => {
  let requestBody
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    requestBody = Buffer.concat(chunks).toString()
    res.end('ok')
  })
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(async () => {
    await client.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const bodyStream = Readable.from(['stream body'])
  Object.defineProperty(bodyStream, Symbol.toStringTag, {
    configurable: true,
    get () {
      throw new Error('Symbol.toStringTag must not be read for streams')
    }
  })

  const { body } = await client.request({
    path: '/',
    method: 'POST',
    body: bodyStream
  })

  assert.strictEqual(await body.text(), 'ok')
  assert.strictEqual(requestBody, 'stream body')
})

test('iterable body keeps iterable semantics with a Blob-like tag', async (t) => {
  let requestBody
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    requestBody = Buffer.concat(chunks).toString()
    res.end('ok')
  })
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(async () => {
    await client.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  let streamReads = 0
  const iterable = {
    [Symbol.toStringTag]: 'Blob',
    get stream () {
      streamReads++
      throw new Error('Blob stream accessor must not be read for iterables')
    },
    * [Symbol.iterator] () {
      yield 'iterable body'
    }
  }

  const { body } = await client.request({
    path: '/',
    method: 'POST',
    body: iterable
  })

  assert.strictEqual(await body.text(), 'ok')
  assert.strictEqual(requestBody, 'iterable body')
  assert.strictEqual(streamReads, 0)
})

test('Blob metadata is read once before dispatch', async (t) => {
  let requestBody
  let requestHeaders
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    requestBody = Buffer.concat(chunks).toString()
    requestHeaders = req.headers
    res.end('ok')
  })
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(async () => {
    await client.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const reads = { size: 0, type: 0, stream: 0 }
  class CountingBlob extends Blob {
    get size () {
      reads.size++
      return super.size
    }

    get type () {
      reads.type++
      return super.type
    }

    get stream () {
      reads.stream++
      return super.stream
    }
  }

  const { body } = await client.request({
    path: '/',
    method: 'POST',
    body: new CountingBlob(['hello'], { type: 'text/plain' })
  })

  assert.strictEqual(await body.text(), 'ok')
  assert.deepStrictEqual(reads, { size: 1, type: 1, stream: 1 })
  assert.strictEqual(requestBody, 'hello')
  assert.strictEqual(requestHeaders['content-type'], 'text/plain')
  assert.strictEqual(requestHeaders['content-length'], '5')
  assert.strictEqual(requestHeaders['transfer-encoding'], undefined)

  await client.close()
})

test('alternating Blob type getter cannot inject a second value', async (t) => {
  let requestHeaders
  const server = createServer((req, res) => {
    requestHeaders = req.headers
    req.resume()
    res.end('ok')
  })
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(async () => {
    await client.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  let typeReads = 0
  class AlternatingTypeBlob extends Blob {
    get type () {
      typeReads++
      return typeReads === 1
        ? 'text/plain'
        : 'text/plain\r\nx-injected-via-second-read: yes'
    }
  }

  const { body } = await client.request({
    path: '/',
    method: 'POST',
    body: new AlternatingTypeBlob(['payload'])
  })

  assert.strictEqual(await body.text(), 'ok')
  assert.strictEqual(typeReads, 1)
  assert.strictEqual(requestHeaders['content-type'], 'text/plain')
  assert.strictEqual(requestHeaders['x-injected-via-second-read'], undefined)
})

test('Blob subclass metadata cannot inject headers', async (t) => {
  let requests = 0
  let connections = 0
  const server = createServer((req, res) => {
    requests++
    res.end('unexpected')
  })
  server.on('connection', () => { connections++ })
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(async () => {
    await client.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  class InvalidSizeBlob extends Blob {
    get size () {
      return '1\r\nx-injected-via-size: yes'
    }
  }

  class InvalidTypeBlob extends Blob {
    get type () {
      return 'text/plain\r\nx-injected-via-type: yes'
    }
  }

  let proxyReads = 0
  class ProxyTypeBlob extends Blob {
    get type () {
      return new Proxy(['text/plain'], {
        get (target, property, receiver) {
          if (property === '0' && ++proxyReads === 3) {
            return 'text/plain\r\nx-injected-via-proxy: yes'
          }
          return Reflect.get(target, property, receiver)
        }
      })
    }
  }

  await assert.rejects(
    client.request({ path: '/', method: 'POST', body: new InvalidSizeBlob(['x']) }),
    errors.InvalidArgumentError
  )
  await assert.rejects(
    client.request({ path: '/', method: 'POST', body: new InvalidTypeBlob(['x']) }),
    errors.InvalidArgumentError
  )
  await assert.rejects(
    client.request({ path: '/', method: 'POST', body: new ProxyTypeBlob(['x']) }),
    errors.InvalidArgumentError
  )

  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(requests, 0)
  assert.strictEqual(connections, 0)
})
