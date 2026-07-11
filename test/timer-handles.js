'use strict'

const assert = require('node:assert/strict')
const net = require('node:net')
const { afterEach, test } = require('node:test')
const FakeTimers = require('@sinonjs/fake-timers')

const timers = require('../lib/util/timers')
const connectH1 = require('../lib/dispatcher/client-h1')
const {
  kMaxHeadersSize,
  kMaxResponseSize,
  kParser
} = require('../lib/core/symbols')

afterEach(() => {
  timers.reset()
})

function assertTimerHandle (handle) {
  assert.strictEqual(typeof handle.refresh, 'function')
  assert.strictEqual(typeof handle.unref, 'function')
}

test('native timer handles expose the Node timer lifecycle', () => {
  const handle = setTimeout(() => {}, 10_000)
  try {
    assertTimerHandle(handle)
  } finally {
    clearTimeout(handle)
  }
})

test('Node mock timer handles refresh parser timeouts in place', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const socket = new net.Socket()
  const client = {
    [kMaxHeadersSize]: 16_384,
    [kMaxResponseSize]: -1
  }

  await connectH1(client, socket)

  try {
    socket[kParser].setTimeout(10, 0)
    const timeout = socket[kParser].timeout
    assertTimerHandle(timeout)

    socket[kParser].setTimeout(10, 0)
    assert.strictEqual(socket[kParser].timeout, timeout)
  } finally {
    socket[kParser].destroy()
    socket.removeAllListeners()
    socket.destroy()
  }
})

test('Sinon fake timers expose Node handles and support FastTimer', () => {
  const clock = FakeTimers.install()
  try {
    const handle = setTimeout(() => {}, 10_000)
    assertTimerHandle(handle)
    clearTimeout(handle)

    const first = timers.setFastTimeout(() => {}, 2_000)
    const second = timers.setFastTimeout(() => {}, 2_000)
    timers.tick()
    timers.clearTimeout(first)
    timers.clearTimeout(second)
  } finally {
    timers.reset()
    clock.uninstall()
  }
})
