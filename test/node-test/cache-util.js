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
  const authenticatedHeaders = {
    authorization: 'Bearer secret',
    'x-tenant': 'customer-a'
  }

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

test('makeCacheKey still accepts genuine iterable header maps', () => {
  const key = util.cache.makeCacheKey({
    origin: 'https://example.test',
    method: 'GET',
    path: '/resource',
    headers: new Map([
      ['authorization', 'Bearer secret'],
      ['x-tenant', 'customer-a']
    ])
  })

  assert.deepEqual(key.headers, {
    authorization: 'Bearer secret',
    'x-tenant': 'customer-a'
  })
})
