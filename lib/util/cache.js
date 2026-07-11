'use strict'

const { hasSafeIterator, serializePathWithQuery } = require('../core/util')

/**
 * @param {import('../../index.js').util.cache.KeyInput} opts
 */
function makeCacheKey (opts) {
  if (!opts.origin) {
    throw new Error('opts.origin is undefined')
  }

  let path = opts.path || '/'
  if (opts.query && !path.includes('?') && !path.includes('#')) {
    path = serializePathWithQuery(path, opts.query)
  }

  return {
    origin: opts.origin.toString(),
    method: opts.method,
    path,
    headers: normalizeHeaders(opts.headers)
  }
}

/**
 * @param {Record<string, string | string[]>} headers
 * @param {string} key
 * @param {string | string[]} value
 */
function setHeader (headers, key, value) {
  key = key.toLowerCase()
  if (key === '__proto__') {
    Object.defineProperty(headers, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    })
  } else {
    headers[key] = value
  }
}

/**
 * @param {unknown} value
 * @returns {value is string | string[]}
 */
function isHeaderValue (value) {
  return typeof value === 'string' || (
    Array.isArray(value) &&
    value.every(item => typeof item === 'string')
  )
}

/**
 * @param {import('../../index.js').util.cache.Headers | undefined} input
 * @returns {Record<string, string | string[]>}
 */
function normalizeHeaders (input) {
  const headers = /** @type {Record<string, string | string[]>} */ ({})

  if (input == null) {
    return headers
  }

  if (typeof input !== 'object') {
    throw new Error('opts.headers is not an object')
  }

  if (Array.isArray(input)) {
    if (input.length > 0 && Array.isArray(input[0])) {
      for (const entry of input) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !isHeaderValue(entry[1])) {
          throw new Error('opts.headers is not a valid header map')
        }
        setHeader(headers, entry[0], Array.isArray(entry[1]) ? entry[1].slice() : entry[1])
      }
    } else {
      if ((input.length & 1) !== 0) {
        throw new Error('opts.headers is not a valid header map')
      }
      for (let i = 0; i < input.length; i += 2) {
        const key = input[i]
        const value = input[i + 1]
        if (typeof key !== 'string' || !isHeaderValue(value)) {
          throw new Error('opts.headers is not a valid header map')
        }
        setHeader(headers, key, Array.isArray(value) ? value.slice() : value)
      }
    }
  } else if (hasSafeIterator(input)) {
    for (const entry of /** @type {Iterable<readonly [string, string | readonly string[]]>} */ (input)) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !isHeaderValue(entry[1])) {
        throw new Error('opts.headers is not a valid header map')
      }
      setHeader(headers, entry[0], Array.isArray(entry[1]) ? entry[1].slice() : entry[1])
    }
  } else {
    // Preserve the established zero-copy fast path for plain header records.
    // assertCacheKey() validates untrusted keys at cache-store boundaries.
    return /** @type {Record<string, string | string[]>} */ (input)
  }

  return headers
}

/**
 * @param {any} key
 */
function assertCacheKey (key) {
  if (key === null || typeof key !== 'object') {
    throw new TypeError(`expected key to be object, got ${typeof key}`)
  }

  for (const property of ['origin', 'method', 'path']) {
    if (typeof key[property] !== 'string') {
      throw new TypeError(`expected key.${property} to be string, got ${typeof key[property]}`)
    }
  }

  if (key.headers !== undefined) {
    if (key.headers === null || typeof key.headers !== 'object' || Array.isArray(key.headers)) {
      throw new TypeError(`expected key.headers to be an object, got ${key.headers === null ? 'null' : typeof key.headers}`)
    }
    for (const name of Object.keys(key.headers)) {
      if (!isHeaderValue(key.headers[name])) {
        throw new TypeError(`expected key.headers.${name} to be a string or string array`)
      }
    }
  }
}

/**
 * @param {any} value
 */
function assertCacheValue (value) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`expected value to be object, got ${typeof value}`)
  }

  for (const property of ['statusCode', 'cachedAt', 'staleAt', 'deleteAt']) {
    if (typeof value[property] !== 'number') {
      throw new TypeError(`expected value.${property} to be number, got ${typeof value[property]}`)
    }
  }

  if (typeof value.statusMessage !== 'string') {
    throw new TypeError(`expected value.statusMessage to be string, got ${typeof value.statusMessage}`)
  }

  if (value.headers != null && typeof value.headers !== 'object') {
    throw new TypeError(`expected value.rawHeaders to be object, got ${typeof value.headers}`)
  }

  if (value.vary !== undefined && (value.vary === null || typeof value.vary !== 'object')) {
    throw new TypeError(`expected value.vary to be object, got ${typeof value.vary}`)
  }

  if (value.etag !== undefined && typeof value.etag !== 'string') {
    throw new TypeError(`expected value.etag to be string, got ${typeof value.etag}`)
  }
}

module.exports = {
  makeCacheKey,
  assertCacheKey,
  assertCacheValue
}
