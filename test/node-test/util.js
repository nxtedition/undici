'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { Stream } = require('node:stream')
const { EventEmitter } = require('node:events')

const util = require('../../lib/core/util')
const { headerNameLowerCasedRecord } = require('../../lib/core/constants')
const { InvalidArgumentError } = require('../../lib/core/errors')

test('isStream', () => {
  const stream = new Stream()
  assert.ok(util.isStream(stream))

  const buffer = Buffer.alloc(0)
  assert.ok(util.isStream(buffer) === false)

  const ee = new EventEmitter()
  assert.ok(util.isStream(ee) === false)
})

test('hasSafeIterator', () => {
  assert.equal(util.hasSafeIterator(null), false)
  assert.equal(util.hasSafeIterator(undefined), false)
  assert.equal(util.hasSafeIterator({}), false)
  assert.equal(util.hasSafeIterator(Object.create(null)), false)
  assert.equal(util.hasSafeIterator(Object.create(Object.create(null))), false)
  assert.equal(util.hasSafeIterator(new Map()), true)

  class HeaderMap extends Map {}
  assert.equal(util.hasSafeIterator(new HeaderMap()), true)

  const customPrototype = {
    * [Symbol.iterator] () {}
  }
  assert.equal(util.hasSafeIterator(Object.create(customPrototype)), true)

  const shadowedIterator = Object.create(customPrototype)
  shadowedIterator[Symbol.iterator] = undefined
  assert.equal(util.hasSafeIterator(shadowedIterator), false)

  const originalIterator = Object.getOwnPropertyDescriptor(
    Object.prototype,
    Symbol.iterator
  )
  try {
    // eslint-disable-next-line no-extend-native
    Object.defineProperty(Object.prototype, Symbol.iterator, {
      configurable: true,
      value: customPrototype[Symbol.iterator]
    })

    assert.equal(util.hasSafeIterator({}), false)
    assert.equal(util.hasSafeIterator(Object.create({})), false)
    assert.equal(util.hasSafeIterator(Object.prototype), false)
    assert.equal(util.hasSafeIterator(new HeaderMap()), true)
    assert.equal(util.hasSafeIterator(Object.create(customPrototype)), true)
  } finally {
    if (originalIterator === undefined) {
      delete Object.prototype[Symbol.iterator]
    } else {
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(
        Object.prototype,
        Symbol.iterator,
        originalIterator
      )
    }
  }
})

test('addAbortListener cannot be blocked by stopImmediatePropagation', () => {
  const controller = new AbortController()
  let calls = 0

  controller.signal.addEventListener('abort', (event) => {
    event.stopImmediatePropagation()
  })

  const abortListener = util.addAbortListener(controller.signal, () => {
    calls++
  })

  controller.abort()
  assert.equal(calls, 1)
  abortListener[Symbol.dispose]()
})

test('addAbortListener disposes native AbortSignal listeners', () => {
  const controller = new AbortController()
  let calls = 0
  const abortListener = util.addAbortListener(controller.signal, () => {
    calls++
  })

  abortListener[Symbol.dispose]()
  abortListener[Symbol.dispose]()
  controller.abort()

  assert.equal(calls, 0)
})

test('addAbortListener falls back for third-party AbortSignals', () => {
  const target = new EventTarget()
  let removals = 0
  let calls = 0
  const signal = {
    aborted: false,
    addEventListener (type, listener, options) {
      if (Object.getOwnPropertySymbols(options).length !== 0) {
        throw new TypeError('private listener options are unsupported')
      }
      target.addEventListener(type, listener, options)
    },
    removeEventListener (type, listener) {
      removals++
      target.removeEventListener(type, listener)
    }
  }

  const abortListener = util.addAbortListener(signal, () => {
    calls++
  })

  target.dispatchEvent(new Event('abort'))
  abortListener[Symbol.dispose]()

  assert.equal(calls, 1)
  assert.equal(removals, 1)
})

test('addAbortListener preserves EventEmitter support and cleanup', () => {
  const signal = new EventEmitter()
  let calls = 0
  const abortListener = util.addAbortListener(signal, () => {
    calls++
  })

  assert.equal(signal.listenerCount('abort'), 1)
  abortListener[Symbol.dispose]()
  assert.equal(signal.listenerCount('abort'), 0)
  signal.emit('abort')
  assert.equal(calls, 0)
})

test('getServerName', () => {
  assert.equal(util.getServerName('1.1.1.1'), '')
  assert.equal(util.getServerName('1.1.1.1:443'), '')
  assert.equal(util.getServerName('example.com'), 'example.com')
  assert.equal(util.getServerName('example.com:80'), 'example.com')
  assert.equal(util.getServerName('[2606:4700:4700::1111]'), '')
  assert.equal(util.getServerName('[2606:4700:4700::1111]:443'), '')
})

test('assertRequestHandler', () => {
  assert.throws(() => util.assertRequestHandler(null), InvalidArgumentError, 'handler must be an object')
  assert.throws(() => util.assertRequestHandler({
    onConnect: null
  }), InvalidArgumentError, 'invalid onConnect method')
  assert.throws(() => util.assertRequestHandler({
    onConnect: () => {},
    onError: null
  }), InvalidArgumentError, 'invalid onError method')
  assert.throws(() => util.assertRequestHandler({
    onConnect: () => {},
    onError: () => {},
    onHeaders: null
  }), InvalidArgumentError, 'invalid onHeaders method')
  assert.throws(() => util.assertRequestHandler({
    onConnect: () => {},
    onError: () => {},
    onHeaders: () => {},
    onData: null
  }), InvalidArgumentError, 'invalid onData method')
  assert.throws(() => util.assertRequestHandler({
    onConnect: () => {},
    onError: () => {},
    onHeaders: () => {},
    onData: () => {},
    onComplete: null
  }), InvalidArgumentError, 'invalid onComplete method')
  assert.throws(() => util.assertRequestHandler({
    onConnect: () => {},
    onError: () => {},
    onUpgrade: 'null'
  }, 'CONNECT'), InvalidArgumentError, 'invalid onUpgrade method')
  assert.throws(() => util.assertRequestHandler({
    onConnect: () => {},
    onError: () => {},
    onUpgrade: 'null'
  }, 'CONNECT', () => {}), InvalidArgumentError, 'invalid onUpgrade method')
})

test('parseHeaders', () => {
  assert.deepEqual(util.parseHeaders(['key', 'value']), { key: 'value' })
  assert.deepEqual(util.parseHeaders([Buffer.from('key'), Buffer.from('value')]), { key: 'value' })
  assert.deepEqual(util.parseHeaders(['Key', 'Value']), { key: 'Value' })
  assert.deepEqual(util.parseHeaders(['Key', 'value', 'key', 'Value']), { key: ['value', 'Value'] })
  assert.deepEqual(util.parseHeaders(['key', ['value1', 'value2', 'value3']]), { key: ['value1', 'value2', 'value3'] })
  assert.deepEqual(util.parseHeaders([Buffer.from('key'), [Buffer.from('value1'), Buffer.from('value2'), Buffer.from('value3')]]), { key: ['value1', 'value2', 'value3'] })
})

test('serializePathWithQuery', () => {
  const tests = [
    [{ id: BigInt(123456) }, 'id=123456'],
    [{ date: new Date() }, 'date='],
    [{ obj: { id: 1 } }, 'obj='],
    [{ params: ['a', 'b', 'c'] }, 'params=a&params=b&params=c'],
    [{ bool: true }, 'bool=true'],
    [{ number: 123456 }, 'number=123456'],
    [{ string: 'hello' }, 'string=hello'],
    [{ null: null }, 'null='],
    [{ void: undefined }, 'void='],
    [{ fn: function () {} }, 'fn='],
    [{}, '']
  ]

  const base = 'https://www.google.com'

  for (const [input, output] of tests) {
    const expected = `${base}${output ? `?${output}` : output}`
    assert.deepEqual(util.serializePathWithQuery(base, input), expected)
  }
})

test('headerNameLowerCasedRecord', () => {
  assert.ok(typeof headerNameLowerCasedRecord.hasOwnProperty !== 'function')
})
