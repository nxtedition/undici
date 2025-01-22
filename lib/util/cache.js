'use strict'

/**
 * @param {import('../../types/dispatcher.d.ts').default.DispatchOptions} opts
 */
function makeCacheKey (opts) {
  if (!opts.origin) {
    throw new Error('opts.origin is undefined')
  }

  /** @type {Record<string, string[] | string>} */
  let headers
  if (opts.headers == null) {
    headers = {}
  } else if (typeof opts.headers[Symbol.iterator] === 'function') {
    headers = {}
    for (const x of opts.headers) {
      if (!Array.isArray(x)) {
        throw new Error('opts.headers is not a valid header map')
      }
      const [key, val] = x
      if (typeof key !== 'string' || typeof val !== 'string') {
        throw new Error('opts.headers is not a valid header map')
      }
      headers[key] = val
    }
  } else if (typeof opts.headers === 'object') {
    headers = opts.headers
  } else {
    throw new Error('opts.headers is not an object')
  }

  return {
    origin: opts.origin.toString(),
    method: opts.method,
    path: opts.path,
    headers
  }
}

/**
 * @param {any} key
 */
function assertCacheKey (key) {
  if (typeof key !== 'object') {
    throw new TypeError(`expected key to be object, got ${typeof key}`)
  }

  for (const property of ['origin', 'method', 'path']) {
    if (typeof key[property] !== 'string') {
      throw new TypeError(`expected key.${property} to be string, got ${typeof key[property]}`)
    }
  }

  if (key.headers !== undefined && typeof key.headers !== 'object') {
    throw new TypeError(`expected headers to be object, got ${typeof key}`)
  }
}

/**
 * @param {any} value
 */
function assertCacheValue (value) {
  if (typeof value !== 'object') {
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

  if (value.vary !== undefined && typeof value.vary !== 'object') {
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
