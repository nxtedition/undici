'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const http = require('node:http')
const net = require('node:net')
const { test } = require('node:test')
const { Client, errors } = require('..')

// maxHeaderSize counts like node:http: the reason phrase, field names and
// field values count; the rest of the status line, colons and CRLFs don't. A
// section is rejected once its count reaches the limit, and trailers are
// counted as a section of their own.

async function serve (t, response) {
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', () => socket.end(response))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  return server.address().port
}

/**
 * @returns {Promise<boolean>} whether undici rejected the response as a header overflow
 */
async function undiciOverflows (port, maxHeaderSize) {
  const client = new Client(`http://127.0.0.1:${port}`, { maxHeaderSize })
  try {
    const { body } = await client.request({ path: '/', method: 'GET' })
    await body.text()
    return false
  } catch (err) {
    if (err instanceof errors.HeadersOverflowError) {
      return true
    }
    throw err
  } finally {
    await client.destroy()
  }
}

/**
 * @returns {Promise<boolean>} whether node:http rejected the response as a header overflow
 */
function nodeOverflows (port, maxHeaderSize) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', maxHeaderSize, agent: false }, (res) => {
      res.on('error', () => {})
      res.on('end', () => resolve(false))
      res.resume()
    })
    req.on('error', (err) => {
      if (err.code === 'HPE_HEADER_OVERFLOW') {
        resolve(true)
      } else {
        reject(err)
      }
    })
  })
}

const cases = [
  {
    name: 'the reason phrase counts',
    response: 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n',
    // 'OK' + 'content-length' + '0'
    size: 2 + 14 + 1
  },
  {
    name: 'a long reason phrase counts',
    response: `HTTP/1.1 200 ${'r'.repeat(64)}\r\nContent-Length: 0\r\n\r\n`,
    size: 64 + 14 + 1
  },
  {
    name: 'a missing reason phrase counts nothing',
    response: 'HTTP/1.1 200\r\nX-A: bc\r\nContent-Length: 0\r\n\r\n',
    size: 3 + 2 + 14 + 1
  },
  {
    name: 'trailers are counted separately from the header section',
    response:
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '2\r\nhi\r\n0\r\n' +
      `X-T: ${'v'.repeat(40)}\r\n\r\n`,
    // The header section counts 'OK' + 'transfer-encoding' + 'chunked' = 26,
    // the trailer section 'x-t' + 40 bytes of value = 43.
    size: 3 + 40
  }
]

for (const { name, response, size } of cases) {
  test(`maxHeaderSize: ${name}`, async (t) => {
    const port = await serve(t, response)

    for (const [maxHeaderSize, overflows] of [[size - 1, true], [size, true], [size + 1, false]]) {
      assert.strictEqual(
        await undiciOverflows(port, maxHeaderSize),
        overflows,
        `undici with maxHeaderSize ${maxHeaderSize}`
      )
      assert.strictEqual(
        await nodeOverflows(port, maxHeaderSize),
        overflows,
        `node:http with maxHeaderSize ${maxHeaderSize}`
      )
    }
  })
}
