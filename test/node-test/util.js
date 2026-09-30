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

test('parseHeaders', () => {
  assert.deepEqual(util.parseHeaders(['key', 'value']), { key: 'value' })
  assert.deepEqual(util.parseHeaders([Buffer.from('key'), Buffer.from('value')]), { key: 'value' })
  assert.deepEqual(util.parseHeaders(['Key', 'Value']), { key: 'Value' })
  assert.deepEqual(util.parseHeaders(['Key', 'value', 'key', 'Value']), { key: ['value', 'Value'] })
  assert.deepEqual(util.parseHeaders(['key', ['value1', 'value2', 'value3']]), { key: ['value1', 'value2', 'value3'] })
  assert.deepEqual(util.parseHeaders([Buffer.from('key'), [Buffer.from('value1'), Buffer.from('value2'), Buffer.from('value3')]]), { key: ['value1', 'value2', 'value3'] })
})

test('parseHeaders lowercases every key', () => {
  // Field names are case-insensitive (RFC 9110 5.1), so the returned map keys
  // them lowercased whichever path headerNameToString takes: the wellknown-name
  // record for strings, the ternary tree for buffers, or toLowerCase() for the
  // rest. Consumers rely on that to look a field up with a lowercase literal.
  const parsed = util.parseHeaders([
    'Content-Type', 'text/plain', // wellknown string -> record
    Buffer.from('Content-Length'), Buffer.from('3'), // wellknown buffer -> tree
    'X-Custom-Name', 'a', // unknown string -> toLowerCase
    Buffer.from('X-Other-Name'), Buffer.from('b') // unknown buffer -> toLowerCase
  ])
  assert.deepEqual(Object.keys(parsed), ['content-type', 'content-length', 'x-custom-name', 'x-other-name'])

  // Two spellings of one name are one entry, not two.
  assert.deepEqual(util.parseHeaders(['X-Test', 'a', 'x-test', 'b', Buffer.from('X-TEST'), Buffer.from('c')]), {
    'x-test': ['a', 'b', 'c']
  })

  // Accumulating into a map keyed by the lowercase name appends to that entry.
  assert.deepEqual(util.parseHeaders(['X-Test', 'b'], { 'x-test': 'a' }), { 'x-test': ['a', 'b'] })
})

test('parseHeaders preserves repeated array values under one lowercase key', () => {
  const values = ['Second, Value', Buffer.from('caf\u00e9', 'latin1')]
  for (const first of ['First', ['First'], Buffer.from('First')]) {
    assert.deepEqual(util.parseHeaders([
      'X-Test', first,
      Buffer.from('X-TEST'), values,
      'x-test', 'Last'
    ]), { 'x-test': ['First', 'Second, Value', 'caf\u00e9', 'Last'] })
  }
  assert.deepEqual(values, ['Second, Value', Buffer.from('caf\u00e9', 'latin1')])
})

test('parseHeaders appends to an existing HeaderMap in place', () => {
  const values = ['First']
  const headers = { 'x-test': values, 'x-other': 'Original' }
  const parsed = util.parseHeaders([
    'X-Test', [Buffer.from('caf\u00e9', 'latin1'), 'Last'],
    'X-Other', ['Repeated'],
    'X-New', 'New'
  ], headers)

  assert.strictEqual(parsed, headers)
  assert.strictEqual(parsed['x-test'], values)
  assert.deepEqual(parsed, {
    'x-test': ['First', 'caf\u00e9', 'Last'],
    'x-other': ['Original', 'Repeated'],
    'x-new': 'New'
  })
})

test('parseHeaders can append an accumulator array to itself', () => {
  const values = ['First', 'Second']
  const headers = { 'x-test': values }
  assert.deepEqual(util.parseHeaders(['X-Test', values], headers), {
    'x-test': ['First', 'Second', 'First', 'Second']
  })
  assert.strictEqual(headers['x-test'], values)
})

test('parseHeaders drops __proto__', () => {
  // A valid field-name token, but assigning it onto a plain object hits
  // Object.prototype's setter — and a repeated field line, which arrives as an
  // array, would replace the prototype outright. Dropped so the returned object
  // can guarantee it has no such key.
  const single = util.parseHeaders(['__proto__', 'pwned', 'key', 'value'])
  assert.deepEqual(single, { key: 'value' })
  assert.strictEqual(Object.hasOwn(single, '__proto__'), false)
  assert.strictEqual(Object.getPrototypeOf(single), Object.prototype)

  const repeated = util.parseHeaders(['__proto__', 'a', '__proto__', 'b'])
  assert.deepEqual(repeated, {})
  assert.strictEqual(Object.getPrototypeOf(repeated), Object.prototype)

  // Mixed case is the same field name (RFC 9110 field names are
  // case-insensitive, and headerNameToString lowercases).
  const mixed = util.parseHeaders(['__PROTO__', 'pwned'])
  assert.strictEqual(Object.hasOwn(mixed, '__proto__'), false)

  // Other Object.prototype names stay: plain assignment handles them. Field
  // names are lowercased, so `toString` lands as the key
  // `tostring`; `constructor` is already lowercase.
  const shadowing = util.parseHeaders(['constructor', 'built-in', 'toString', 'str'])
  assert.strictEqual(shadowing.constructor, 'built-in')
  assert.strictEqual(shadowing.tostring, 'str')
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

test('stringifyHTTPHeader compares the bytes when a name hashes like a well-known one', () => {
  // hash = hash * 3 ^ byte, so a server can pick two adjacent bytes that give
  // another name of the same length and hash. Only the byte compare tells it
  // from the listed name.
  const hash = (str) => {
    let h = 0
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h, 3) ^ str.charCodeAt(i)
    }
    return h
  }
  const isUpper = (c) => c >= 0x41 && c <= 0x5a
  let collisions = 0
  for (const name of wellknownResponseHeaderNames) {
    let input
    let prefix = 0
    for (let i = 0; i + 1 < name.length && input === undefined; i++) {
      const x = Math.imul(prefix, 3)
      const target = Math.imul(x ^ name.charCodeAt(i), 3) ^ name.charCodeAt(i + 1)
      for (let c = 0x21; c < 0x7f && input === undefined; c++) {
        const d = Math.imul(x ^ c, 3) ^ target
        if (c !== name.charCodeAt(i) && !isUpper(c) && d >= 0 && d < 256 && !isUpper(d)) {
          input = name.slice(0, i) + String.fromCharCode(c, d) + name.slice(i + 2)
        }
      }
      prefix = x ^ name.charCodeAt(i)
    }
    if (input !== undefined) {
      assert.strictEqual(hash(input), hash(name))
      const buf = Buffer.from(input, 'latin1')
      assert.strictEqual(util.stringifyHTTPHeader(buf, 0, buf.length), input)
      collisions++
    }
  }
  assert.ok(collisions > wellknownResponseHeaderNames.length / 2, `${collisions} collisions`)
})

test('stringifyHTTPHeader returns the preallocated string for every well-known name', () => {
  // Literals are internalized and latin1Slice results are not, so this tells
  // a table hit from a decoded copy.
  const script = `
    const { stringifyHTTPHeader } = require(${JSON.stringify(require.resolve('../../lib/core/util'))})
    const { wellknownResponseHeaderNames } = require(${JSON.stringify(require.resolve('../../lib/core/constants'))})
    const decoded = []
    for (const name of wellknownResponseHeaderNames) {
      const buf = Buffer.from(name.toUpperCase(), 'latin1')
      if (!%IsInternalizedString(stringifyHTTPHeader(buf, 0, buf.length))) {
        decoded.push(name)
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
