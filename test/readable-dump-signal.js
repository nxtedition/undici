'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { AbortController } = require('abort-controller')
const Readable = require('../lib/api/readable')

function createBody () {
  return new Readable({
    resume () {},
    abort () {}
  })
}

test('dump supports third-party AbortSignals without throwIfAborted', async () => {
  const controller = new AbortController()
  const body = createBody()
  const dumped = body.dump({ signal: controller.signal })

  queueMicrotask(() => body.push(null))

  assert.strictEqual(await dumped, null)
})

test('dump rejects a pre-aborted third-party AbortSignal', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(createBody().dump({ signal: controller.signal }), {
    name: 'AbortError'
  })
})
