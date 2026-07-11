'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { util } = require('../..')

test('makeCacheKey ignores an iterator polluted onto Object.prototype', t => {
  const originalIterator = Object.getOwnPropertyDescriptor(
    Object.prototype,
    Symbol.iterator
  )

  t.after(() => {
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
  })

  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Object.prototype, Symbol.iterator, {
    configurable: true,
    writable: true,
    value: function * pollutedIterator () {}
  })

  const options = {
    origin: 'https://example.test',
    method: 'GET',
    path: '/resource'
  }
  const authenticatedHeaders = Object.assign(Object.create({}), {
    authorization: 'Bearer secret',
    'x-tenant': 'customer-a'
  })

  const authenticatedKey = util.cache.makeCacheKey({
    ...options,
    headers: authenticatedHeaders
  })
  const anonymousKey = util.cache.makeCacheKey({
    ...options,
    headers: {}
  })

  assert.deepEqual(authenticatedKey.headers, authenticatedHeaders)
  assert.notDeepEqual(authenticatedKey, anonymousKey)
})

test('makeCacheKey still accepts inherited Map iterators', () => {
  class HeaderMap extends Map {}

  const key = util.cache.makeCacheKey({
    origin: 'https://example.test',
    method: 'GET',
    path: '/resource',
    headers: new HeaderMap([
      ['authorization', 'Bearer secret'],
      ['x-tenant', 'customer-a']
    ])
  })

  assert.deepEqual(key.headers, {
    authorization: 'Bearer secret',
    'x-tenant': 'customer-a'
  })
})

test('makeCacheKey includes query parameters in the path', () => {
  const first = util.cache.makeCacheKey({
    origin: 'https://example.test',
    method: 'GET',
    path: '/resource',
    query: { page: 1 }
  })
  const second = util.cache.makeCacheKey({
    origin: 'https://example.test',
    method: 'GET',
    path: '/resource',
    query: { page: 2 }
  })

  assert.equal(first.path, '/resource?page=1')
  assert.equal(second.path, '/resource?page=2')
  assert.notDeepEqual(first, second)

  assert.equal(util.cache.makeCacheKey({
    origin: 'https://example.test',
    method: 'GET',
    query: { page: 1 }
  }).path, '/?page=1')

  assert.equal(util.cache.makeCacheKey({
    origin: 'https://example.test',
    method: 'GET',
    path: '/resource?existing=yes',
    query: { ignored: 'yes' }
  }).path, '/resource?existing=yes')
})

test('makeCacheKey normalizes supported array header formats', () => {
  const options = {
    origin: 'https://example.test',
    method: 'GET',
    path: '/resource'
  }

  assert.deepEqual(util.cache.makeCacheKey({
    ...options,
    headers: ['X-Test', 'one', 'Set-Cookie', ['a=1', 'b=2']]
  }).headers, {
    'x-test': 'one',
    'set-cookie': ['a=1', 'b=2']
  })

  assert.deepEqual(util.cache.makeCacheKey({
    ...options,
    headers: [['X-Test', 'one']]
  }).headers, {
    'x-test': 'one'
  })
})

test('makeCacheKey preserves __proto__ as an own header', () => {
  const key = util.cache.makeCacheKey({
    origin: 'https://example.test',
    method: 'GET',
    path: '/resource',
    headers: new Map([['__proto__', 'safe']])
  })

  assert.equal(Object.getPrototypeOf(key.headers), Object.prototype)
  assert.equal(Object.hasOwn(key.headers, '__proto__'), true)
  assert.equal(Reflect.get(key.headers, '__proto__'), 'safe')
})

test('cache assertions reject values outside their declared types', () => {
  const key = {
    origin: 'https://example.test',
    method: 'GET',
    path: '/resource'
  }

  for (const headers of [null, [], { x: 1 }, { x: ['ok', 1] }]) {
    assert.throws(() => util.cache.assertCacheKey({ ...key, headers }), TypeError)
  }

  assert.throws(() => util.cache.assertCacheKey(null), TypeError)
  assert.throws(() => util.cache.assertCacheValue(null), TypeError)
  assert.throws(() => util.cache.assertCacheValue({
    statusCode: 200,
    statusMessage: 'OK',
    cachedAt: 1,
    staleAt: 2,
    deleteAt: 3,
    vary: null
  }), TypeError)
})
