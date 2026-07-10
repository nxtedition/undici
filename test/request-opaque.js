'use strict'

const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { test } = require('node:test')
const { Client } = require('..')

test('request preserves falsy opaque values', async (t) => {
  const server = createServer((req, res) => res.end())
  await new Promise(resolve => server.listen(0, resolve))
  t.after(() => server.close())

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(() => client.destroy())

  for (const opaque of [false, 0, '']) {
    const response = await client.request({
      path: '/',
      method: 'GET',
      opaque
    })

    assert.strictEqual(response.opaque, opaque)
    await response.body.dump()
  }
})
