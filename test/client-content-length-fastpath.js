'use strict'

const { tspl } = require('@matteo.collina/tspl')
const { test, after, describe } = require('node:test')
const net = require('node:net')
const { Duplex } = require('node:stream')
const { Client, errors } = require('..')
const { createServer } = require('node:http')
const { kParser, kSocket } = require('../lib/core/symbols')

const FAST_BODY_SIZE = 256 * 1024
const LARGE_HEADER_SIZE = 70 * 1024

function connectWithSingleRead (response, requestCount = 1) {
  response = Buffer.from(response)

  return (_opts, callback) => {
    let requests = ''
    let sent = false
    const socket = new Duplex({
      readableHighWaterMark: response.length,
      read () {},
      write (chunk, _encoding, done) {
        requests += chunk.toString()
        const completeRequests = requests.match(/\r\n\r\n/g)?.length ?? 0
        if (!sent && completeRequests >= requestCount) {
          sent = true
          setImmediate(() => socket.push(response))
        }
        done()
      }
    })

    socket.ref = socket.unref = () => socket
    queueMicrotask(() => callback(null, socket))
  }
}

// Exercises the content-length body fast path in lib/dispatcher/client-h1.js:
// once the headers of a fixed-length response are parsed, body bytes are
// delivered without going through llhttp. These tests pin down the framing
// edge cases the fast path owns: message boundaries shared with pipelined
// responses, backpressure pauses, truncation and keep-alive reuse.

describe('content-length body fast path', () => {
  test('large fixed-length body split across many packets', async (t) => {
    t = tspl(t, { plan: 3 })

    const body = Buffer.alloc(FAST_BODY_SIZE, 'x')
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-length': `${body.length}` })
      res.end(body)
    })
    after(() => {
      server.closeAllConnections?.()
      server.close()
    })

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.close())

      const { statusCode, body: stream } = await client.request({ path: '/', method: 'GET' })
      const buf = Buffer.from(await stream.arrayBuffer())
      t.strictEqual(statusCode, 200)
      t.strictEqual(buf.length, body.length)
      t.strictEqual(buf.equals(body), true)
    })

    await t.completed
  })

  test('large fixed-length body in one oversized socket read', async (t) => {
    t = tspl(t, { plan: 3 })

    const body = Buffer.alloc(FAST_BODY_SIZE, 'q')
    const response = Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n`),
      body
    ])
    const client = new Client('http://localhost', {
      connect: connectWithSingleRead(response)
    })
    after(() => client.destroy())

    const { statusCode, body: stream } = await client.request({ path: '/', method: 'GET' })
    const received = Buffer.from(await stream.arrayBuffer())
    t.strictEqual(statusCode, 200)
    t.strictEqual(received.length, body.length)
    t.strictEqual(received.equals(body), true)

    await t.completed
  })

  test('keep-alive reuse after fast path completion', async (t) => {
    t = tspl(t, { plan: 10 })

    const body = Buffer.alloc(FAST_BODY_SIZE, 'y')
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-length': `${body.length}` })
      res.end(body)
    })
    after(() => {
      server.closeAllConnections?.()
      server.close()
    })

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.close())

      client.on('disconnect', () => {
        if (!client.closed && !client.destroyed) {
          t.fail('connection must be reused')
        }
      })

      for (let i = 0; i < 5; i++) {
        const { statusCode, body: stream } = await client.request({ path: '/', method: 'GET' })
        const buf = Buffer.from(await stream.arrayBuffer())
        t.strictEqual(statusCode, 200)
        t.strictEqual(buf.equals(body), true)
      }
    })

    await t.completed
  })

  test('pipelined responses sharing packets, boundaries mid-chunk', async (t) => {
    t = tspl(t, { plan: 2 })

    const body1 = 'A'.repeat(FAST_BODY_SIZE)
    const body2 = 'B'.repeat(FAST_BODY_SIZE)
    const h1 = `HTTP/1.1 200 OK\r\ncontent-length: ${body1.length}\r\n\r\n`
    const h2 = `HTTP/1.1 200 OK\r\ncontent-length: ${body2.length}\r\n\r\n`

    const server = net.createServer((sock) => {
      sock.setNoDelay(true)
      let requestData = ''
      let sent1 = false
      let sent2 = false
      sock.on('data', (d) => {
        requestData += d.toString()
        const reqs = requestData.match(/\r\n\r\n/g)?.length ?? 0
        if (reqs >= 1 && !sent1) {
          sent1 = true
          // Headers and only the first slice of body1; the fast path
          // takes over for the rest.
          sock.write(h1 + body1.slice(0, 1000))
        }
        if (reqs >= 2 && !sent2) {
          sent2 = true
          // One glued packet: rest of body1, response 2 headers, first
          // slice of body2. The fast path must complete message 1 and
          // re-enter llhttp for message 2 headers.
          sock.write(body1.slice(1000) + h2 + body2.slice(0, 1000))
          setTimeout(() => sock.write(body2.slice(1000)), 20)
        }
      })
    })
    after(() => server.close())

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`, { pipelining: 2 })
      after(() => client.destroy())

      const [ta, tb] = await Promise.all([
        client.request({ path: '/1', method: 'GET' }).then(r => r.body.text()),
        client.request({ path: '/2', method: 'GET' }).then(r => r.body.text())
      ])
      t.strictEqual(ta === body1, true)
      t.strictEqual(tb === body2, true)
    })

    await t.completed
  })

  test('exact message boundary at end of packet', async (t) => {
    t = tspl(t, { plan: 2 })

    const body = 'Z'.repeat(FAST_BODY_SIZE)
    const header = `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n`

    const server = net.createServer((sock) => {
      sock.setNoDelay(true)
      sock.once('data', () => {
        // Headers in one packet, body in a second packet ending exactly
        // at the message boundary.
        sock.write(header)
        setTimeout(() => sock.write(body), 10)
      })
    })
    after(() => server.close())

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.destroy())

      const { statusCode, body: stream } = await client.request({ path: '/', method: 'GET' })
      t.strictEqual(statusCode, 200)
      t.strictEqual(await stream.text(), body)
    })

    await t.completed
  })

  test('truncated fixed-length body errors on connection close', async (t) => {
    t = tspl(t, { plan: 1 })

    const body = 'T'.repeat(FAST_BODY_SIZE)

    const server = net.createServer((sock) => {
      sock.once('data', () => {
        sock.write(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`)
        // Send only part of the body, then close.
        sock.write(body.slice(0, 10000))
        setTimeout(() => sock.end(), 20)
      })
    })
    after(() => server.close())

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.destroy())

      try {
        const { body: stream } = await client.request({ path: '/', method: 'GET' })
        await stream.text()
        t.fail('must not resolve')
      } catch (err) {
        t.strictEqual(err.code, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH')
      }
    })

    await t.completed
  })

  test('truncated keep-alive fixed-length body errors on connection close', async (t) => {
    t = tspl(t, { plan: 1 })

    const body = 'K'.repeat(FAST_BODY_SIZE)

    const server = net.createServer((sock) => {
      sock.once('data', () => {
        sock.write(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n`)
        sock.write(body.slice(0, 10000))
        setTimeout(() => sock.end(), 20)
      })
    })
    after(() => server.close())

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.destroy())

      try {
        const { body: stream } = await client.request({ path: '/', method: 'GET' })
        await stream.text()
        t.fail('must not resolve')
      } catch (err) {
        t.strictEqual(err.code, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH')
      }
    })

    await t.completed
  })

  test('truncated keep-alive fixed-length body errors on connection reset', async (t) => {
    t = tspl(t, { plan: 1 })

    const body = 'R'.repeat(FAST_BODY_SIZE)

    const server = net.createServer((sock) => {
      sock.on('error', () => {})
      sock.once('data', () => {
        sock.write(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n`)
        sock.write(body.slice(0, 10000))
        setTimeout(() => sock.resetAndDestroy(), 50)
      })
    })
    after(() => server.close())

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.destroy())

      try {
        const { body: stream } = await client.request({ path: '/', method: 'GET' })
        await stream.text()
        t.fail('must not resolve')
      } catch (err) {
        t.strictEqual(err.code, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH')
      }
    })

    await t.completed
  })

  test('backpressure pause and resume mid-body', async (t) => {
    t = tspl(t, { plan: 3 })

    const body = Buffer.alloc(512 * 1024, 'p')
    const server = net.createServer((sock) => {
      sock.once('data', () => {
        sock.write(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n`)
        sock.write(body.subarray(0, 1000))
        setImmediate(() => sock.write(body.subarray(1000)))
      })
    })
    after(() => server.close())

    server.listen(0, () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.destroy())

      const chunks = []
      let paused = false
      let resume
      client.dispatch({ path: '/', method: 'GET' }, {
        onConnect () {},
        onHeaders (statusCode, _headers, fn) {
          t.strictEqual(statusCode, 200)
          resume = fn
        },
        onData (chunk) {
          chunks.push(chunk)
          if (!paused) {
            paused = true
            setImmediate(resume)
            return false
          }
          return true
        },
        onComplete () {
          t.strictEqual(paused, true)
          t.strictEqual(Buffer.concat(chunks).equals(body), true)
        },
        onError (err) {
          t.fail(err)
        }
      })
    })

    await t.completed
  })

  test('finish completes a fast body paused again on its final chunk', async (t) => {
    t = tspl(t, { plan: 4 })

    const body = Buffer.alloc(FAST_BODY_SIZE, 'e')
    const firstRead = Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n`),
      body.subarray(0, 1000)
    ])
    const client = new Client('http://localhost', {
      connect: connectWithSingleRead(firstRead)
    })
    after(() => client.destroy())

    const chunks = []
    let pauses = 0
    client.dispatch({ path: '/', method: 'GET' }, {
      onConnect () {},
      onHeaders (statusCode) {
        t.strictEqual(statusCode, 200)
      },
      onData (chunk) {
        chunks.push(chunk)
        pauses++
        if (pauses === 1) {
          setImmediate(() => {
            const socket = client[kSocket]
            socket.push(body.subarray(1000))
            t.ifError(socket[kParser].finish())
          })
        }
        return false
      },
      onComplete () {
        t.strictEqual(pauses, 2)
        t.strictEqual(Buffer.concat(chunks).equals(body), true)
      },
      onError (err) {
        t.fail(err)
      }
    })

    await t.completed
  })

  test('finish completes a fast body already paused at its exact length', async (t) => {
    t = tspl(t, { plan: 3 })

    const body = Buffer.alloc(FAST_BODY_SIZE, 'j')
    const response = Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n`),
      body
    ])
    const client = new Client('http://localhost', {
      connect: connectWithSingleRead(response)
    })
    after(() => client.destroy())

    client.dispatch({ path: '/', method: 'GET' }, {
      onConnect () {},
      onHeaders (statusCode) {
        t.strictEqual(statusCode, 200)
      },
      onData (chunk) {
        t.strictEqual(chunk.equals(body), true)
        setImmediate(() => {
          const socket = client[kSocket]
          t.ifError(socket[kParser].finish())
        })
        return false
      },
      onComplete () {},
      onError (err) {
        t.fail(err)
      }
    })

    await t.completed
  })

  test('maxResponseSize enforced on fast path body', async (t) => {
    t = tspl(t, { plan: 1 })

    const body = Buffer.alloc(FAST_BODY_SIZE, 'm')
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-length': `${body.length}` })
      res.end(body)
    })
    after(() => {
      server.closeAllConnections?.()
      server.close()
    })

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`, { maxResponseSize: 100 * 1024 })
      after(() => client.destroy())

      try {
        const { body: stream } = await client.request({ path: '/', method: 'GET' })
        await stream.text()
        t.fail('must not resolve')
      } catch (err) {
        t.strictEqual(err instanceof errors.ResponseExceededMaxSizeError, true)
      }
    })

    await t.completed
  })

  test('chunked transfer-encoding is not affected', async (t) => {
    t = tspl(t, { plan: 2 })

    const body = 'c'.repeat(128 * 1024)
    const server = createServer((req, res) => {
      // No content-length: Node uses chunked encoding.
      res.writeHead(200)
      res.write(body.slice(0, 60000))
      setTimeout(() => res.end(body.slice(60000)), 10)
    })
    after(() => {
      server.closeAllConnections?.()
      server.close()
    })

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.close())

      const { statusCode, body: stream } = await client.request({ path: '/', method: 'GET' })
      t.strictEqual(statusCode, 200)
      t.strictEqual(await stream.text(), body)
    })

    await t.completed
  })

  test('transfer-encoding prevents a large content-length from activating the fast path', async (t) => {
    t = tspl(t, { plan: 1 })

    const response =
      'HTTP/1.1 200 OK\r\ncontent-length: 262144\r\ntransfer-encoding: chunked\r\n\r\n' +
      '5\r\nhello\r\n0\r\n\r\n'
    const client = new Client('http://localhost', {
      connect: connectWithSingleRead(response)
    })
    after(() => client.destroy())

    try {
      const { body } = await client.request({ path: '/', method: 'GET' })
      await body.text()
      t.fail('must not resolve')
    } catch (err) {
      t.strictEqual(err.code, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH')
    }

    await t.completed
  })

  test('unsafe integer content-length stays on the llhttp path', async (t) => {
    t = tspl(t, { plan: 2 })

    const client = new Client('http://localhost', {
      connect: connectWithSingleRead(
        'HTTP/1.1 200 OK\r\ncontent-length: 9007199254740992\r\n\r\n'
      )
    })
    after(() => client.destroy())

    client.dispatch({ path: '/', method: 'GET' }, {
      onConnect () {},
      onHeaders (statusCode) {
        t.strictEqual(statusCode, 200)
        setImmediate(() => {
          t.strictEqual(client[kSocket][kParser].fastBody, false)
        })
      },
      onData () {
        t.fail('must not receive response data')
      },
      onComplete () {
        t.fail('must not complete')
      },
      onError () {}
    })

    await t.completed
  })

  test('fast path does not activate for bodyless 204 with content-length', async (t) => {
    t = tspl(t, { plan: 1 })

    const client = new Client('http://localhost', {
      connect: connectWithSingleRead(
        'HTTP/1.1 204 No Content\r\ncontent-length: 262144\r\n\r\n'
      )
    })
    after(() => client.destroy())

    try {
      const { body } = await client.request({ path: '/', method: 'GET' })
      await body.text()
      t.fail('must not resolve')
    } catch (err) {
      t.strictEqual(err.code, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH')
    }

    await t.completed
  })

  test('fast path does not activate for bodyless 304 with content-length', async (t) => {
    t = tspl(t, { plan: 3 })

    const server = net.createServer((sock) => {
      sock.once('data', () => {
        // A 304 Content-Length describes the selected representation; it does
        // not frame a response body and must never activate the fast path.
        sock.write('HTTP/1.1 304 Not Modified\r\ncontent-length: 262144\r\n\r\n')
      })
    })
    after(() => server.close())

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.destroy())

      const { statusCode, headers, body } = await client.request({ path: '/', method: 'GET' })
      t.strictEqual(statusCode, 304)
      t.strictEqual(headers['content-length'], '262144')
      t.strictEqual(await body.text(), '')
    })

    await t.completed
  })

  test('headers larger than the slice size parse correctly', async (t) => {
    t = tspl(t, { plan: 3 })

    // Header block larger than HEADER_SLICE_SIZE (64 KiB) to cover header
    // parsing spanning multiple slices.
    const bigValue = 'v'.repeat(40 * 1024)
    const body = 'H'.repeat(FAST_BODY_SIZE)
    const response =
      `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n` +
      `x-big-one: ${bigValue}\r\nx-big-two: ${bigValue}\r\n\r\n${body}`
    const client = new Client('http://localhost', {
      maxHeaderSize: 128 * 1024,
      connect: connectWithSingleRead(response)
    })
    after(() => client.destroy())

    const { statusCode, headers, body: stream } = await client.request({ path: '/', method: 'GET' })
    t.strictEqual(statusCode, 200)
    t.strictEqual(headers['x-big-two'], bigValue)
    t.strictEqual(await stream.text(), body)

    await t.completed
  })

  test('parser errors after sliced headers preserve the original error offset', async (t) => {
    t = tspl(t, { plan: 2 })

    const bigValue = 'v'.repeat(LARGE_HEADER_SIZE)
    const response =
      `HTTP/1.1 200 OK\r\nx-big: ${bigValue}\r\nbad header: nope\r\n\r\n`
    const client = new Client('http://localhost', {
      maxHeaderSize: 128 * 1024,
      connect: connectWithSingleRead(response)
    })
    after(() => client.destroy())

    try {
      await client.request({ path: '/', method: 'GET' })
      t.fail('must not resolve')
    } catch (err) {
      t.strictEqual(err.name, 'HTTPParserError')
      t.strictEqual(err.data, ' header: nope\r\n\r\n')
    }

    await t.completed
  })

  test('bodies interleaved with 100-continue-free informational responses', async (t) => {
    t = tspl(t, { plan: 2 })

    const body = 'i'.repeat(FAST_BODY_SIZE)
    const server = net.createServer((sock) => {
      sock.once('data', () => {
        // 103 Early Hints, then the real fixed-length response.
        sock.write('HTTP/1.1 103 Early Hints\r\nlink: </style.css>; rel=preload\r\n\r\n')
        sock.write(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n`)
        setTimeout(() => sock.write(body), 10)
      })
    })
    after(() => server.close())

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.destroy())

      const { statusCode, body: stream } = await client.request({ path: '/', method: 'GET' })
      t.strictEqual(statusCode, 200)
      t.strictEqual(await stream.text(), body)
    })

    await t.completed
  })

  test('content-length with trailing optional whitespace keeps pipeline boundaries', async (t) => {
    t = tspl(t, { plan: 2 })

    const firstBody = 'o'.repeat(FAST_BODY_SIZE)
    const secondBody = 'w'.repeat(FAST_BODY_SIZE)
    const server = net.createServer((sock) => {
      let requestData = ''
      let sent = false
      sock.on('data', (chunk) => {
        requestData += chunk.toString()
        const requests = requestData.match(/\r\n\r\n/g)?.length ?? 0
        if (requests >= 2 && !sent) {
          sent = true
          sock.write(
            `HTTP/1.1 200 OK\r\ncontent-length: ${firstBody.length}   \r\n\r\n${firstBody}` +
            `HTTP/1.1 200 OK\r\ncontent-length: ${secondBody.length}\r\n\r\n${secondBody}`
          )
        }
      })
    })
    after(() => server.close())

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`, { pipelining: 2 })
      after(() => client.destroy())

      const [first, second] = await Promise.all([
        client.request({ path: '/1', method: 'GET', blocking: false }).then(({ body }) => body.text()),
        client.request({ path: '/2', method: 'GET', blocking: false }).then(({ body }) => body.text())
      ])

      t.strictEqual(first, firstBody)
      t.strictEqual(second, secondBody)
    })

    await t.completed
  })

  test('duplicate content-length falls back to llhttp framing validation', async (t) => {
    t = tspl(t, { plan: 2 })

    const firstBody = 'd'.repeat(FAST_BODY_SIZE)
    const server = net.createServer((sock) => {
      let requestData = ''
      let sentHeaders = false
      let sentBody = false
      sock.on('data', (chunk) => {
        requestData += chunk.toString()
        const requests = requestData.match(/\r\n\r\n/g)?.length ?? 0
        if (requests >= 1 && !sentHeaders) {
          sentHeaders = true
          sock.write(
            `HTTP/1.1 200 OK\r\ncontent-length: ${firstBody.length}\r\n` +
            `content-length: ${firstBody.length}\r\n\r\n${firstBody[0]}`
          )
        }
        if (requests >= 2 && !sentBody) {
          sentBody = true
          sock.write(
            `${firstBody.slice(1)}HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nworld`
          )
        }
      })
    })
    after(() => server.close())

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`, { pipelining: 2 })
      after(() => client.destroy())

      const results = await Promise.allSettled([
        client.request({ path: '/1', method: 'GET' }).then(({ body }) => body.text()),
        client.request({ path: '/2', method: 'GET' }).then(({ body }) => body.text())
      ])

      for (const result of results) {
        t.strictEqual(result.status === 'rejected' && result.reason.code, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH')
      }
    })

    await t.completed
  })

  test('abort from the final fast-path data callback does not escape the parser', async (t) => {
    t = tspl(t, { plan: 3 })

    const body = Buffer.alloc(FAST_BODY_SIZE, 'a')
    const server = net.createServer((sock) => {
      sock.once('data', () => {
        sock.write(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\n\r\n`)
        setImmediate(() => sock.write(body))
      })
    })
    after(() => server.close())

    server.listen(0, () => {
      const client = new Client(`http://localhost:${server.address().port}`)
      after(() => client.destroy())

      const abortError = new Error('abort from onData')
      let abort
      let bytesRead = 0
      client.dispatch({ path: '/', method: 'GET' }, {
        onConnect (fn) {
          abort = fn
        },
        onHeaders (statusCode) {
          t.strictEqual(statusCode, 200)
        },
        onData (chunk) {
          bytesRead += chunk.length
          if (bytesRead === body.length) {
            t.strictEqual(bytesRead, body.length)
            abort(abortError)
          }
        },
        onComplete () {
          t.fail('aborted request must not complete')
        },
        onError (err) {
          t.strictEqual(err, abortError)
        }
      })
    })

    await t.completed
  })

  test('backpressure on the final body chunk resumes before the next response', async (t) => {
    t = tspl(t, { plan: 4 })

    const firstBody = 'f'.repeat(FAST_BODY_SIZE)
    const firstHeaders = `HTTP/1.1 200 OK\r\ncontent-length: ${firstBody.length}\r\n\r\n`
    const secondResponse = 'HTTP/1.1 200 OK\r\ncontent-length: 6\r\n\r\nsecond'
    const server = net.createServer((sock) => {
      let requestData = ''
      let sent = false
      sock.on('data', (chunk) => {
        requestData += chunk.toString()
        const requests = requestData.match(/\r\n\r\n/g)?.length ?? 0
        if (requests >= 2 && !sent) {
          sent = true
          sock.write(firstHeaders)
          setImmediate(() => sock.write(firstBody + secondResponse))
        }
      })
    })
    after(() => server.close())

    server.listen(0, async () => {
      const client = new Client(`http://localhost:${server.address().port}`, { pipelining: 2 })
      after(() => client.destroy())

      let resume
      let bytesRead = 0
      let pausedOnFinalChunk = false
      const first = new Promise((resolve, reject) => {
        client.dispatch({ path: '/1', method: 'GET', blocking: false }, {
          onConnect () {},
          onHeaders (statusCode, headers, fn) {
            t.strictEqual(statusCode, 200)
            resume = fn
          },
          onData (chunk) {
            bytesRead += chunk.length
            if (bytesRead === firstBody.length) {
              pausedOnFinalChunk = true
              setImmediate(resume)
              return false
            }
            return true
          },
          onComplete () {
            resolve(bytesRead)
          },
          onError: reject
        })
      })
      const second = client.request({ path: '/2', method: 'GET', blocking: false }).then(({ body }) => body.text())

      t.strictEqual(await first, firstBody.length)
      t.strictEqual(pausedOnFinalChunk, true)
      t.strictEqual(await second, 'second')
    })

    await t.completed
  })

  test('paused headers spanning parser slices preserve buffered responses', async (t) => {
    t = tspl(t, { plan: 4 })

    const bigValue = 's'.repeat(LARGE_HEADER_SIZE)
    const firstResponse =
      `HTTP/1.1 200 OK\r\nx-big: ${bigValue}\r\ncontent-length: 5\r\n\r\nfirst`
    const secondResponse = 'HTTP/1.1 200 OK\r\ncontent-length: 6\r\n\r\nsecond'
    const client = new Client('http://localhost', {
      pipelining: 2,
      maxHeaderSize: 128 * 1024,
      connect: connectWithSingleRead(firstResponse + secondResponse, 2)
    })
    after(() => client.destroy())

    const chunks = []
    const first = new Promise((resolve, reject) => {
      client.dispatch({ path: '/1', method: 'GET', blocking: false }, {
        onConnect () {},
        onHeaders (statusCode, headers, resume) {
          t.strictEqual(statusCode, 200)
          t.strictEqual(headers['x-big'], bigValue)
          setImmediate(resume)
          return false
        },
        onData (chunk) {
          chunks.push(chunk)
        },
        onComplete () {
          resolve(Buffer.concat(chunks).toString())
        },
        onError: reject
      })
    })
    const second = client.request({ path: '/2', method: 'GET', blocking: false }).then(({ body }) => body.text())

    t.strictEqual(await first, 'first')
    t.strictEqual(await second, 'second')

    await t.completed
  })

  test('CONNECT upgrade head is preserved after headers spanning parser slices', async (t) => {
    t = tspl(t, { plan: 3 })

    const bigValue = 'u'.repeat(LARGE_HEADER_SIZE)
    const response =
      `HTTP/1.1 200 Connection Established\r\nx-big: ${bigValue}\r\n\r\nTUNNEL`
    const client = new Client('http://localhost', {
      maxHeaderSize: 128 * 1024,
      connect: connectWithSingleRead(response)
    })
    after(() => client.destroy())

    client.dispatch({ path: '/', method: 'CONNECT' }, {
      onConnect () {},
      onUpgrade (statusCode, headers, socket) {
        t.strictEqual(statusCode, 200)
        t.strictEqual(headers['x-big'], bigValue)
        t.strictEqual(socket.read().toString(), 'TUNNEL')
        socket.destroy()
      },
      onData () {
        t.fail('CONNECT must not receive response data')
      },
      onComplete () {
        t.fail('CONNECT must upgrade instead of completing')
      },
      onError (err) {
        t.fail(err)
      }
    })

    await t.completed
  })
})
