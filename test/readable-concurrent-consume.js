'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const Readable = require('../lib/api/readable')

test('only the first body mixin call in a turn consumes the body', async () => {
  const body = new Readable({
    resume () {},
    abort () {}
  })

  const first = body.text()
  const second = body.text()

  queueMicrotask(() => {
    body.push(Buffer.from('hello world'))
    body.push(null)
  })

  const [firstResult, secondResult] = await Promise.allSettled([first, second])

  assert.deepStrictEqual(firstResult, {
    status: 'fulfilled',
    value: 'hello world'
  })
  assert.strictEqual(secondResult.status, 'rejected')
  assert(secondResult.reason instanceof TypeError)
  assert.strictEqual(secondResult.reason.message, 'unusable')
})
