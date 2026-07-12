'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const Readable = require('../lib/api/readable')
const { AbortController } = globalThis

function createBody () {
  return new Readable({
    resume () {},
    abort () {}
  })
}

test('dump supports native AbortSignals', async () => {
  const controller = new AbortController()
  const body = createBody()
  const dumped = body.dump({ signal: controller.signal })

  queueMicrotask(() => body.push(null))

  assert.strictEqual(await dumped, undefined)
})

test('dump resolves undefined without a signal', async () => {
  const body = createBody()
  const dumped = body.dump()

  queueMicrotask(() => body.push(null))

  assert.strictEqual(await dumped, undefined)
})

test('dump resolves undefined after the body has already closed', async () => {
  const body = createBody()
  body.resume()
  body.push(null)
  await new Promise(resolve => body.once('close', resolve))

  assert.strictEqual(await body.dump(), undefined)
})

test('dump rejects a pre-aborted native AbortSignal', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(createBody().dump({ signal: controller.signal }), {
    name: 'AbortError'
  })
})

test('dump preserves a pre-aborted native AbortSignal reason', async () => {
  const controller = new AbortController()
  const reason = new Error('abort reason')
  controller.abort(reason)

  await assert.rejects(
    createBody().dump({ signal: controller.signal }),
    err => err === reason
  )
})

test('dump preserves a null pre-aborted native AbortSignal reason', async () => {
  const controller = new AbortController()
  controller.abort(null)

  await assert.rejects(
    createBody().dump({ signal: controller.signal }),
    err => err === null
  )
})

test('dump preserves a null in-flight native AbortSignal reason', async () => {
  const controller = new AbortController()
  const dumped = createBody().dump({ signal: controller.signal })
  controller.abort(null)

  await assert.rejects(dumped, err => err === null)
})

test('dump abort cannot be blocked by stopImmediatePropagation', async () => {
  const controller = new AbortController()
  const reason = new Error('abort reason')
  const body = createBody()

  controller.signal.addEventListener('abort', (event) => {
    event.stopImmediatePropagation()
  })

  const dumped = body.dump({ signal: controller.signal })
  controller.abort(reason)
  setImmediate(() => body.push(null))

  await assert.rejects(dumped, err => err === reason)
})

test('dump disposes structural AbortSignal listener on close', async () => {
  const target = new EventTarget()
  let removals = 0
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener (...args) {
      target.addEventListener(...args)
    },
    removeEventListener (...args) {
      removals++
      target.removeEventListener(...args)
    }
  }
  const body = createBody()
  const dumped = body.dump({ signal })

  queueMicrotask(() => body.push(null))

  assert.strictEqual(await dumped, undefined)
  assert.strictEqual(removals, 1)
})
