/* globals AbortController */

'use strict'

const { tspl } = require('@matteo.collina/tspl')
const { test, after, describe, before } = require('node:test')
const { Client } = require('..')
const { createServer } = require('node:http')
const EE = require('node:events')
const { kConnect } = require('../lib/core/symbols')
const { Readable } = require('node:stream')
const net = require('node:net')
const { promisify } = require('node:util')
const { InvalidArgumentError } = require('../lib/core/errors')

test('request dump head', async (t) => {
  t = tspl(t, { plan: 3 })

  const server = createServer((req, res) => {
    res.setHeader('content-length', 5 * 100)
    res.flushHeaders()
    res.write('hello'.repeat(100))
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    let dumped = false
    client.on('disconnect', () => {
      t.strictEqual(dumped, true)
    })
    client.request({
      path: '/',
      method: 'HEAD'
    }, (err, { body }) => {
      t.ifError(err)
      body.dump({ limit: 1 }).then(() => {
        dumped = true
        t.ok(true, 'pass')
      })
    })
  })

  await t.completed
})

test('request dump big', async (t) => {
  t = tspl(t, { plan: 3 })

  const server = createServer((req, res) => {
    res.setHeader('content-length', 999999999)
    while (res.write('asd')) {
      // Do nothing...
    }
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    let dumped = false
    client.on('disconnect', () => {
      t.strictEqual(dumped, true)
    })
    client.request({
      path: '/',
      method: 'GET'
    }, (err, { body }) => {
      t.ifError(err)
      body.on('data', () => t.fail())
      body.dump().then(() => {
        dumped = true
        t.ok(true, 'pass')
      })
    })
  })

  await t.completed
})

test('request dump', async (t) => {
  t = tspl(t, { plan: 3 })

  const server = createServer((req, res) => {
    res.shouldKeepAlive = false
    res.setHeader('content-length', 5)
    res.end('hello')
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    let dumped = false
    client.on('disconnect', () => {
      t.strictEqual(dumped, true)
    })
    client.request({
      path: '/',
      method: 'GET'
    }, (err, { body }) => {
      t.ifError(err)
      body.dump().then(() => {
        dumped = true
        t.ok(true, 'pass')
      })
    })
  })

  await t.completed
})

test('request dump with abort signal', async (t) => {
  t = tspl(t, { plan: 2 })
  const server = createServer((req, res) => {
    res.write('hello')
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    client.request({
      path: '/',
      method: 'GET'
    }, (err, { body }) => {
      t.ifError(err)
      const ac = new AbortController()
      body.dump({ signal: ac.signal }).catch((err) => {
        t.strictEqual(err.name, 'AbortError')
        server.close()
      })
      ac.abort()
    })
  })

  await t.completed
})

test('request hwm', async (t) => {
  t = tspl(t, { plan: 2 })
  const server = createServer((req, res) => {
    res.write('hello')
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    client.request({
      path: '/',
      method: 'GET',
      highWaterMark: 1000
    }, (err, { body }) => {
      t.ifError(err)
      t.deepStrictEqual(body.readableHighWaterMark, 1000)
      body.dump()
    })
  })

  await t.completed
})

test('request abort before headers', async (t) => {
  t = tspl(t, { plan: 6 })

  const signal = new EE()
  const server = createServer((req, res) => {
    res.end('hello')
    signal.emit('abort')
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    client[kConnect](() => {
      client.request({
        path: '/',
        method: 'GET',
        signal
      }, (err) => {
        t.ok(err.name === 'AbortError')
        t.strictEqual(signal.listenerCount('abort'), 0)
      })
      t.strictEqual(signal.listenerCount('abort'), 1)

      client.request({
        path: '/',
        method: 'GET',
        signal
      }, (err) => {
        t.ok(err.name === 'AbortError')
        t.strictEqual(signal.listenerCount('abort'), 0)
      })
      t.strictEqual(signal.listenerCount('abort'), 2)
    })
  })

  await t.completed
})

test('request body destroyed on invalid callback', async (t) => {
  t = tspl(t, { plan: 1 })

  const server = createServer((req, res) => {
  })
  after(() => server.close())

  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const body = new Readable({
      read () {}
    })
    try {
      client.request({
        path: '/',
        method: 'GET',
        body
      }, null)
    } catch (err) {
      t.strictEqual(body.destroyed, true)
    }
  })

  await t.completed
})

test('destroy socket abruptly', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = net.createServer((socket) => {
    const lines = [
      'HTTP/1.1 200 OK',
      'Date: Sat, 09 Oct 2010 14:28:02 GMT',
      'Connection: close',
      '',
      'the body'
    ]
    socket.end(lines.join('\r\n'))

    // Unfortunately calling destroy synchronously might get us flaky results,
    // therefore we delay it to the next event loop run.
    setImmediate(socket.destroy.bind(socket))
  })
  after(() => server.close())

  await promisify(server.listen.bind(server))(0)
  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  const { statusCode, body } = await client.request({
    path: '/',
    method: 'GET'
  })

  t.strictEqual(statusCode, 200)

  body.setEncoding('utf8')

  let actual = ''

  for await (const chunk of body) {
    actual += chunk
  }

  t.strictEqual(actual, 'the body')
})

test('destroy socket abruptly with keep-alive', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = net.createServer((socket) => {
    const lines = [
      'HTTP/1.1 200 OK',
      'Date: Sat, 09 Oct 2010 14:28:02 GMT',
      'Connection: keep-alive',
      'Content-Length: 42',
      '',
      'the body'
    ]
    socket.end(lines.join('\r\n'))

    // Unfortunately calling destroy synchronously might get us flaky results,
    // therefore we delay it to the next event loop run.
    setImmediate(socket.destroy.bind(socket))
  })
  after(() => server.close())

  await promisify(server.listen.bind(server))(0)
  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  const { statusCode, body } = await client.request({
    path: '/',
    method: 'GET'
  })

  t.strictEqual(statusCode, 200)

  body.setEncoding('utf8')

  try {
    /* eslint-disable */
    for await (const _ of body) {
      // empty on purpose
    }
    /* eslint-enable */
    t.fail('no error')
  } catch (err) {
    t.ok(true, 'error happened')
  }
})

test('request json', async (t) => {
  t = tspl(t, { plan: 1 })

  const obj = { asd: true }
  const server = createServer((req, res) => {
    res.end(JSON.stringify(obj))
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'GET'
    })
    t.deepStrictEqual(obj, await body.json())
  })

  await t.completed
})

test('request long multibyte json', async (t) => {
  t = tspl(t, { plan: 1 })

  const obj = { asd: 'あ'.repeat(100000) }
  const server = createServer((req, res) => {
    res.end(JSON.stringify(obj))
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'GET'
    })
    t.deepStrictEqual(obj, await body.json())
  })

  await t.completed
})

test('request text', async (t) => {
  t = tspl(t, { plan: 1 })

  const obj = { asd: true }
  const server = createServer((req, res) => {
    res.end(JSON.stringify(obj))
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'GET'
    })
    t.strictEqual(JSON.stringify(obj), await body.text())
  })

  await t.completed
})

describe('headers', () => {
  describe('invalid headers', () => {
    test('invalid header value - array with string with invalid character', async (t) => {
      t = tspl(t, { plan: 1 })

      const client = new Client('http://localhost:8080')
      after(() => client.destroy())

      t.rejects(client.request({
        path: '/',
        method: 'GET',
        headers: { name: ['test\0'] }
      }), new InvalidArgumentError('invalid name header'))

      await t.completed
    })
    test('invalid header value - array with POJO', async (t) => {
      t = tspl(t, { plan: 1 })

      const client = new Client('http://localhost:8080')
      after(() => client.destroy())

      t.rejects(client.request({
        path: '/',
        method: 'GET',
        headers: { name: [{}] }
      }), new InvalidArgumentError('invalid name header'))

      await t.completed
    })

    test('invalid header value - string with invalid character', async (t) => {
      t = tspl(t, { plan: 1 })

      const client = new Client('http://localhost:8080')
      after(() => client.destroy())

      t.rejects(client.request({
        path: '/',
        method: 'GET',
        headers: { name: 'test\0' }
      }), new InvalidArgumentError('invalid name header'))

      await t.completed
    })

    test('invalid header value - object', async (t) => {
      t = tspl(t, { plan: 1 })

      const client = new Client('http://localhost:8080')
      after(() => client.destroy())

      t.rejects(client.request({
        path: '/',
        method: 'GET',
        headers: { name: new Date() }
      }), new InvalidArgumentError('invalid name header'))

      await t.completed
    })
  })

  describe('array', () => {
    let serverAddress
    const server = createServer((req, res) => {
      res.end(JSON.stringify(req.headers))
    })

    before(async () => {
      server.listen(0)
      await EE.once(server, 'listening')
      serverAddress = `localhost:${server.address().port}`
    })

    after(() => server.close())

    test('empty host header', async (t) => {
      t = tspl(t, { plan: 4 })

      const client = new Client(`http://${serverAddress}`)
      after(() => client.destroy())

      const testCase = async (expected, actual) => {
        const { body } = await client.request({
          path: '/',
          method: 'GET',
          headers: expected
        })

        const result = await body.json()
        t.deepStrictEqual(result, { ...result, ...actual })
      }

      await testCase({ key: [null] }, { key: '' })
      await testCase({ key: ['test'] }, { key: 'test' })
      await testCase({ key: ['test', 'true'] }, { key: 'test, true' })
      await testCase({ key: ['test', true] }, { key: 'test, true' })

      await t.completed
    })
  })

  describe('host', () => {
    let serverAddress
    const server = createServer((req, res) => {
      res.end(req.headers.host)
    })

    before(async () => {
      server.listen(0)
      await EE.once(server, 'listening')
      serverAddress = `localhost:${server.address().port}`
    })

    after(() => server.close())

    test('invalid host header', async (t) => {
      t = tspl(t, { plan: 1 })

      const client = new Client(`http://${serverAddress}`)
      after(() => client.destroy())

      t.rejects(client.request({
        path: '/',
        method: 'GET',
        headers: {
          host: [
            'www.example.com'
          ]
        }
      }), new InvalidArgumentError('invalid host header'))

      await t.completed
    })

    test('empty host header', async (t) => {
      t = tspl(t, { plan: 3 })

      const client = new Client(`http://${serverAddress}`)
      after(() => client.destroy())

      const getWithHost = async (host, wanted) => {
        const { body } = await client.request({
          path: '/',
          method: 'GET',
          headers: { host }
        })
        t.strictEqual(await body.text(), wanted)
      }

      await getWithHost('test', 'test')
      await getWithHost(undefined, serverAddress)
      await getWithHost('', '')

      await t.completed
    })
  })
})

test('request long multibyte text', async (t) => {
  t = tspl(t, { plan: 1 })

  const obj = { asd: 'あ'.repeat(100000) }
  const server = createServer((req, res) => {
    res.end(JSON.stringify(obj))
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'GET'
    })
    t.strictEqual(JSON.stringify(obj), await body.text())
  })

  await t.completed
})

test('request blob', async (t) => {
  t = tspl(t, { plan: 2 })

  const obj = { asd: true }
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(obj))
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'GET'
    })

    const blob = await body.blob()
    t.deepStrictEqual(obj, JSON.parse(await blob.text()))
    t.strictEqual(blob.type, 'application/json')
  })

  await t.completed
})

test('request arrayBuffer', async (t) => {
  t = tspl(t, { plan: 2 })

  const obj = { asd: true }
  const server = createServer((req, res) => {
    res.end(JSON.stringify(obj))
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'GET'
    })
    const ab = await body.arrayBuffer()

    t.deepStrictEqual(Buffer.from(JSON.stringify(obj)), Buffer.from(ab))
    t.ok(ab instanceof ArrayBuffer)
  })

  await t.completed
})

test('request body', async (t) => {
  t = tspl(t, { plan: 1 })

  const obj = { asd: true }
  const server = createServer((req, res) => {
    res.end(JSON.stringify(obj))
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'GET'
    })

    let x = ''
    for await (const chunk of body.body) {
      x += Buffer.from(chunk)
    }
    t.strictEqual(JSON.stringify(obj), x)
  })

  await t.completed
})

test('request post body no missing data', async (t) => {
  t = tspl(t, { plan: 2 })

  const server = createServer(async (req, res) => {
    let ret = ''
    for await (const chunk of req) {
      ret += chunk
    }
    t.strictEqual(ret, 'asd')
    res.end()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'GET',
      body: new Readable({
        read () {
          this.push('asd')
          this.push(null)
        }
      }),
      maxRedirections: 2
    })
    await body.text()
    t.ok(true, 'pass')
  })

  await t.completed
})

test('request post body no extra data handler', async (t) => {
  t = tspl(t, { plan: 3 })

  const server = createServer(async (req, res) => {
    let ret = ''
    for await (const chunk of req) {
      ret += chunk
    }
    t.strictEqual(ret, 'asd')
    res.end()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const reqBody = new Readable({
      read () {
        this.push('asd')
        this.push(null)
      }
    })
    process.nextTick(() => {
      t.strictEqual(reqBody.listenerCount('data'), 0)
    })
    const { body } = await client.request({
      path: '/',
      method: 'GET',
      body: reqBody,
      maxRedirections: 0
    })
    await body.text()
    t.ok(true, 'pass')
  })

  await t.completed
})

test('request text2', async (t) => {
  t = tspl(t, { plan: 2 })

  const obj = { asd: true }
  const server = createServer((req, res) => {
    res.end(JSON.stringify(obj))
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'GET'
    })
    const p = body.text()
    let ret = ''
    body.on('data', chunk => {
      ret += chunk
    }).on('end', () => {
      t.strictEqual(JSON.stringify(obj), ret)
    })
    t.strictEqual(JSON.stringify(obj), await p)
  })

  await t.completed
})

test('request post body Buffer from string', async (t) => {
  t = tspl(t, { plan: 2 })
  const requestBody = Buffer.from('abcdefghijklmnopqrstuvwxyz')

  const server = createServer(async (req, res) => {
    let ret = ''
    for await (const chunk of req) {
      ret += chunk
    }
    t.strictEqual(ret, 'abcdefghijklmnopqrstuvwxyz')
    res.end()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'POST',
      body: requestBody,
      maxRedirections: 2
    })
    await body.text()
    t.ok(true, 'pass')
  })

  await t.completed
})

test('request post body Buffer from buffer', async (t) => {
  t = tspl(t, { plan: 2 })
  const fullBuffer = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz')
  const requestBody = Buffer.from(fullBuffer.buffer, 8, 16)

  const server = createServer(async (req, res) => {
    let ret = ''
    for await (const chunk of req) {
      ret += chunk
    }
    t.strictEqual(ret, 'ijklmnopqrstuvwx')
    res.end()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'POST',
      body: requestBody,
      maxRedirections: 2
    })
    await body.text()
    t.ok(true, 'pass')
  })

  await t.completed
})

test('request post body Uint8Array', async (t) => {
  t = tspl(t, { plan: 2 })
  const fullBuffer = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz')
  const requestBody = new Uint8Array(fullBuffer.buffer, 8, 16)

  const server = createServer(async (req, res) => {
    let ret = ''
    for await (const chunk of req) {
      ret += chunk
    }
    t.strictEqual(ret, 'ijklmnopqrstuvwx')
    res.end()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'POST',
      body: requestBody,
      maxRedirections: 2
    })
    await body.text()
    t.ok(true, 'pass')
  })

  await t.completed
})

test('request post body Uint32Array', async (t) => {
  t = tspl(t, { plan: 2 })
  const fullBuffer = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz')
  const requestBody = new Uint32Array(fullBuffer.buffer, 8, 4)

  const server = createServer(async (req, res) => {
    let ret = ''
    for await (const chunk of req) {
      ret += chunk
    }
    t.strictEqual(ret, 'ijklmnopqrstuvwx')
    res.end()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'POST',
      body: requestBody,
      maxRedirections: 2
    })
    await body.text()
    t.ok(true, 'pass')
  })

  await t.completed
})

test('request post body Float64Array', async (t) => {
  t = tspl(t, { plan: 2 })
  const fullBuffer = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz')
  const requestBody = new Float64Array(fullBuffer.buffer, 8, 2)

  const server = createServer(async (req, res) => {
    let ret = ''
    for await (const chunk of req) {
      ret += chunk
    }
    t.strictEqual(ret, 'ijklmnopqrstuvwx')
    res.end()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'POST',
      body: requestBody,
      maxRedirections: 2
    })
    await body.text()
    t.ok(true, 'pass')
  })

  await t.completed
})

test('request post body BigUint64Array', async (t) => {
  t = tspl(t, { plan: 2 })
  const fullBuffer = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz')
  const requestBody = new BigUint64Array(fullBuffer.buffer, 8, 2)

  const server = createServer(async (req, res) => {
    let ret = ''
    for await (const chunk of req) {
      ret += chunk
    }
    t.strictEqual(ret, 'ijklmnopqrstuvwx')
    res.end()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'POST',
      body: requestBody,
      maxRedirections: 2
    })
    await body.text()
    t.ok(true, 'pass')
  })

  await t.completed
})

test('request post body DataView', async (t) => {
  t = tspl(t, { plan: 2 })
  const fullBuffer = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz')
  const requestBody = new DataView(fullBuffer.buffer, 8, 16)

  const server = createServer(async (req, res) => {
    let ret = ''
    for await (const chunk of req) {
      ret += chunk
    }
    t.strictEqual(ret, 'ijklmnopqrstuvwx')
    res.end()
  })
  after(() => server.close())

  server.listen(0, async () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.destroy())

    const { body } = await client.request({
      path: '/',
      method: 'POST',
      body: requestBody,
      maxRedirections: 2
    })
    await body.text()
    t.ok(true, 'pass')
  })

  await t.completed
})
