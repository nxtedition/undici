'use strict'

const assert = require('node:assert/strict')
const net = require('node:net')
const { afterEach, test } = require('node:test')

const timers = require('../lib/util/timers')
const connectH1 = require('../lib/dispatcher/client-h1')
const {
  kMaxHeadersSize,
  kMaxResponseSize,
  kParser
} = require('../lib/core/symbols')

const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

afterEach(() => {
  timers.reset()
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
})

function installNumericTimerHandles () {
  let nextId = 0
  const handles = new Map()

  globalThis.setTimeout = (callback, delay, ...args) => {
    const id = ++nextId
    handles.set(id, originalSetTimeout(callback, delay, ...args))
    return id
  }

  globalThis.clearTimeout = (id) => {
    const handle = handles.get(id)
    handles.delete(id)
    return originalClearTimeout(handle ?? id)
  }

  return handles
}

test('fast timers support timer handles without refresh or unref', () => {
  installNumericTimerHandles()

  const first = timers.setFastTimeout(() => {}, 2_000)
  const second = timers.setFastTimeout(() => {}, 2_000)

  timers.tick()

  timers.clearTimeout(first)
  timers.clearTimeout(second)
})

test('the H1 parser supports timer handles without unref', async () => {
  installNumericTimerHandles()

  const socket = new net.Socket()
  const client = {
    [kMaxHeadersSize]: 16_384,
    [kMaxResponseSize]: -1
  }

  await connectH1(client, socket)

  try {
    socket[kParser].setTimeout(10, 0)
  } finally {
    socket[kParser].destroy()
    socket.removeAllListeners()
    socket.destroy()
  }
})

test('the H1 parser refreshes numeric timer handles by replacing them', async () => {
  const handles = installNumericTimerHandles()

  const socket = new net.Socket()
  const client = {
    [kMaxHeadersSize]: 16_384,
    [kMaxResponseSize]: -1
  }

  await connectH1(client, socket)

  try {
    socket[kParser].setTimeout(10, 0)
    const first = socket[kParser].timeout

    socket[kParser].setTimeout(10, 0)
    const second = socket[kParser].timeout

    assert.notStrictEqual(second, first)
    assert.strictEqual(handles.has(first), false)
    assert.strictEqual(handles.has(second), true)
  } finally {
    socket[kParser].destroy()
    socket.removeAllListeners()
    socket.destroy()
  }
})
