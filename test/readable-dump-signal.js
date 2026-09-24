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

test('dump reports an invalid signal by rejecting, not throwing', async () => {
  let dumped
  assert.doesNotThrow(() => {
    dumped = createBody().dump({ signal: {} })
  })
  await assert.rejects(dumped, { name: 'InvalidArgumentError' })
})

test('concurrent dumps apply the smallest limit', async () => {
  const body = createBody()
  const small = body.dump({ limit: 10 })
  const large = body.dump({ limit: 1e6 })

  // Past the small limit but far below the large one: the body is discarded
  // without waiting for the rest.
  body.push(Buffer.alloc(100))

  let timer
  await Promise.race([
    Promise.all([small, large]),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the larger limit kept the dump waiting')), 1e3)
    })
  ]).finally(() => clearTimeout(timer))
  assert.strictEqual(body.destroyed, true)
  assert.strictEqual(body.readableEnded, false)
})

test('a failed dump setup does not lower a later dump limit', async (t) => {
  const body = createBody()
  t.after(() => body.destroy())
  await assert.rejects(body.dump({ signal: { aborted: false }, limit: 10 }))

  const dumped = body.dump({ limit: 1000 })
  body.push(Buffer.alloc(100))
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(body.destroyed, false)

  body.push(null)
  await dumped
  assert.strictEqual(body.readableEnded, true)
})
