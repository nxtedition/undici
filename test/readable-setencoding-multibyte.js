'use strict'

const { tspl } = require('@matteo.collina/tspl')
const { test, after } = require('node:test')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { Client } = require('..')
const BodyReadable = require('../lib/api/readable')

test('setEncoding(\'utf8\') handles 3-byte UTF-8 characters split across chunks', async (t) => {
  t = tspl(t, { plan: 2 })

  // CJK character '傳' is 3 bytes: 0xe5, 0x82, 0xb3
  // Build a payload where this character will be split at the chunk boundary
  const cjkChar = '傳' // U+50B3, bytes: e5 82 b3
  const prefix = 'a'.repeat(10) // 10 ASCII bytes
  const text = prefix + cjkChar + 'end'
  const buf = Buffer.from(text) // 10 + 3 + 3 = 16 bytes

  // Split at byte 11, which is in the middle of the 3-byte CJK character
  // prefix (10 bytes) + first byte of '傳' (0xe5) | remaining 2 bytes (0x82 0xb3) + 'end'
  const chunk1 = buf.subarray(0, 11)
  const chunk2 = buf.subarray(11)

  const server = createServer({ joinDuplicateHeaders: true }, (req, res) => {
    // Send raw buffers to ensure the split is exactly where we want it
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.write(chunk1)
    // Use setTimeout to force separate TCP packets / chunks
    setTimeout(() => {
      res.end(chunk2)
    }, 50)
  })
  after(() => {
    server.closeAllConnections?.()
    server.close()
  })

  server.listen(0)
  await once(server, 'listening')

  const client = new Client(`http://localhost:${server.address().port}`)
  after(client.destroy.bind(client))

  const { body } = await client.request({
    path: '/',
    method: 'GET'
  })
  body.setEncoding('utf8')

  let result = ''
  for await (const chunk of body) {
    result += chunk
  }

  // Must not contain U+FFFD replacement characters
  t.strictEqual(result.includes('\ufffd'), false, 'should not contain U+FFFD replacement characters')
  t.strictEqual(result, text, 'decoded text should match original')

  await t.completed
})

test('body mixins preserve bytes buffered after setEncoding()', async (t) => {
  t = tspl(t, { plan: 1 })

  const text = `prefix-${'傳'}-suffix`
  const bytes = Buffer.from(text)
  const split = bytes.indexOf(0xe5) + 1
  const body = new BodyReadable({
    resume () {},
    abort () {}
  })

  body.setEncoding('utf8')
  body.push(bytes.subarray(0, split))
  await new Promise(resolve => setImmediate(resolve))
  body.push(bytes.subarray(split))
  body.push(null)

  t.strictEqual(await body.text(), text)
})
