'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { Readable, Stream } = require('node:stream')
const { EventEmitter } = require('node:events')

const util = require('../../lib/core/util')
const { execFileSync } = require('node:child_process')
const { headerNameLowerCasedRecord, wellknownResponseHeaderNames } = require('../../lib/core/constants')
const { InvalidArgumentError } = require('../../lib/core/errors')

test('isStream', () => {
  const stream = new Stream()
  assert.ok(util.isStream(stream))

  const buffer = Buffer.alloc(0)
  assert.ok(util.isStream(buffer) === false)

  const ee = new EventEmitter()
  assert.ok(util.isStream(ee) === false)
})

test('isDestroyed supports Node and duck-typed streams', () => {
  assert.strictEqual(util.isDestroyed(null), false)
  assert.strictEqual(util.isDestroyed(undefined), false)

  const readable = new Readable({ read () {} })
  assert.strictEqual(util.isDestroyed(readable), false)
  readable.destroy()
  assert.strictEqual(util.isDestroyed(readable), true)

  const duck = new EventEmitter()
  duck.pipe = () => {}
  util.destroy(duck)
  assert.strictEqual(util.isDestroyed(duck), true)
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

// ASCII-only lowercasing, which is all stringifyHTTPHeader does to a name.
function lowerASCII (str) {
  return str.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

function titleCase (name) {
  return name.replace(/(^|-)([a-z])/g, (m, dash, c) => dash + c.toUpperCase())
}

test('stringifyHTTPHeader lowercases the name in place and returns it', () => {
  const names = ['', 'X-Unknown-Header', 'x-custom-1', 'CONTENT-TYPE', ...wellknownResponseHeaderNames]
  for (const name of names) {
    for (const input of [name, name.toUpperCase(), titleCase(name)]) {
      const buf = Buffer.from(input, 'latin1')
      assert.strictEqual(util.stringifyHTTPHeader(buf, 0, buf.length), lowerASCII(input), input)
      assert.strictEqual(buf.toString('latin1'), lowerASCII(input), input)
    }
  }
})

test('stringifyHTTPHeader reads and lowercases only the given range', () => {
  for (const name of ['Content-Type', 'X-Custom-Header']) {
    const buf = Buffer.from(`ABC${name}XYZ`, 'latin1')
    assert.strictEqual(util.stringifyHTTPHeader(buf, 3, name.length), lowerASCII(name))
    assert.strictEqual(buf.toString('latin1'), `ABC${lowerASCII(name)}XYZ`)
  }
})

test('stringifyHTTPHeader only lowercases A-Z', () => {
  for (let byte = 0; byte < 256; byte++) {
    const buf = Buffer.from([byte, 0x44, 0x61, 0x74, 0x45, byte])
    const expected = String.fromCharCode(byte) + 'date' + String.fromCharCode(byte)
    assert.strictEqual(util.stringifyHTTPHeader(buf, 0, buf.length), lowerASCII(expected), `byte ${byte}`)
  }
})

test('stringifyHTTPHeader tells a well-known name from any other', () => {
  // Near misses of every name, and random names, some of which land in an
  // occupied slot: each comes back as its own text, never as a listed name.
  const inputs = []
  for (const name of wellknownResponseHeaderNames) {
    inputs.push(`${name}x`, `x${name}`, name.slice(0, -1), name.slice(1), `${name.slice(0, -1)}_`, `_${name.slice(1)}`)
    for (let i = 0; i < name.length; i++) {
      inputs.push(name.slice(0, i) + '~' + name.slice(i + 1))
    }
  }
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
  let seed = 1
  for (let n = 0; n < 20000; n++) {
    let name = ''
    const length = 1 + n % 40
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      // The low six bits repeat every 64 steps; use higher bits for variety.
      name += chars[(seed >>> 16) % chars.length]
    }
    inputs.push(name)
  }
  for (const input of inputs) {
    const buf = Buffer.from(input, 'latin1')
    assert.strictEqual(util.stringifyHTTPHeader(buf, 0, buf.length), lowerASCII(input), input)
  }
})

test('stringifyHTTPHeader compares words when a name has the same full hash', () => {
  const hash = (str) => {
    let h = 0
    for (let i = 0; i < str.length; i += 4) {
      let word = 0
      for (let j = 0; j < 4 && i + j < str.length; j++) {
        word |= str.charCodeAt(i + j) << (j * 8)
      }
      h = Math.imul(h, 3) ^ word
    }
    return h
  }
  const chars = "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyz"
  let collisions = 0
  const eligible = wellknownResponseHeaderNames.filter(name => name.length > 4)
  for (const name of eligible) {
    let input
    const first = Buffer.from(name.slice(0, 4)).readInt32LE()
    const second = Buffer.alloc(4)
    second.write(name.slice(4, 8), 'latin1')
    const target = Math.imul(first, 3) ^ second.readInt32LE()
    for (const c of chars) {
      if (c === name[0]) continue
      const next = (first & ~0xff) | c.charCodeAt(0)
      const replacement = Buffer.alloc(4)
      replacement.writeInt32LE(target ^ Math.imul(next, 3))
      const length = Math.min(4, name.length - 4)
      if (replacement.subarray(length).some(byte => byte !== 0)) continue
      const text = replacement.subarray(0, length).toString('latin1')
      if ([...text].every(byte => chars.includes(byte))) {
        input = c + name.slice(1, 4) + text + name.slice(8)
        break
      }
    }
    if (input !== undefined) {
      assert.strictEqual(hash(input), hash(name))
      for (let offset = 0; offset < 4; offset++) {
        const buf = Buffer.alloc(input.length + 8, 0x5a)
        buf.write(input, offset, 'latin1')
        const words = new Int32Array(buf.buffer, 0, buf.buffer.byteLength >>> 2)
        assert.strictEqual(util.stringifyHTTPHeader(buf, offset, input.length, words), input)
      }
      collisions++
    }
  }
  assert.ok(collisions > eligible.length / 2, `${collisions} collisions`)
})

test('stringifyHTTPHeader handles every alignment without changing neighboring bytes', () => {
  const names = ['', 'X-Custom-Header', ...wellknownResponseHeaderNames]
  for (const name of names) {
    for (let skew = 0; skew < 4; skew++) {
      for (let offset = 0; offset < 8; offset++) {
        const backing = Buffer.alloc(name.length + 24, 0x5a)
        const buf = backing.subarray(skew)
        buf.write(name.toUpperCase(), offset, 'latin1')
        const expected = Buffer.from(backing)
        expected.write(name.toLowerCase(), skew + offset, 'latin1')
        const words = new Int32Array(backing.buffer, 0, backing.buffer.byteLength >>> 2)
        assert.strictEqual(util.stringifyHTTPHeader(buf, offset, name.length, words), name.toLowerCase())
        assert.deepStrictEqual(backing, expected)
      }
    }
  }
})

test('stringifyHTTPHeader lowercases only ASCII A-Z in every packed lane', () => {
  for (let byte = 0; byte < 256; byte++) {
    for (let lane = 0; lane < 4; lane++) {
      for (let offset = 0; offset < 4; offset++) {
        const buf = Buffer.alloc(16, 0x5a)
        const input = Buffer.from([0x40, 0x41, 0x5a, 0x5b, 0xff, 0x61, 0x7f, 0x80])
        input[lane] = byte
        input[lane + 4] = byte
        input.copy(buf, offset)
        const expected = lowerASCII(input.toString('latin1'))
        const words = new Int32Array(buf.buffer, 0, buf.buffer.byteLength >>> 2)
        assert.strictEqual(util.stringifyHTTPHeader(buf, offset, input.length, words), expected, `byte ${byte}, lane ${lane}, offset ${offset}`)
        assert.strictEqual(buf.subarray(offset, offset + input.length).toString('latin1'), expected)
        assert.ok(buf.subarray(0, offset).every(value => value === 0x5a))
        assert.ok(buf.subarray(offset + input.length).every(value => value === 0x5a))
      }
    }
  }
})

test('stringifyHTTPHeader returns the preallocated string for every well-known name', () => {
  // Literals are internalized and latin1Slice results are not, so this tells
  // a table hit from a decoded copy.
  const script = `
    const { stringifyHTTPHeader } = require(${JSON.stringify(require.resolve('../../lib/core/util'))})
    const { wellknownResponseHeaderNames } = require(${JSON.stringify(require.resolve('../../lib/core/constants'))})
    const decoded = []
    for (const name of wellknownResponseHeaderNames) {
      for (let offset = 0; offset < 4; offset++) {
        const buf = Buffer.alloc(name.length + 8)
        buf.write(name.toUpperCase(), offset, 'latin1')
        const words = new Int32Array(buf.buffer, 0, buf.buffer.byteLength >>> 2)
        if (!%IsInternalizedString(stringifyHTTPHeader(buf, offset, name.length, words))) {
          decoded.push(name + ':' + offset)
        }
      }
    }
    if (%IsInternalizedString(stringifyHTTPHeader(Buffer.from('x-unknown-header'), 0, 16))) {
      decoded.push('x-unknown-header is internalized')
    }
    process.stdout.write(JSON.stringify(decoded))
  `
  const decoded = execFileSync(process.execPath, ['--allow-natives-syntax', '-e', script], { encoding: 'utf8' })
  assert.deepStrictEqual(JSON.parse(decoded), [])
})
