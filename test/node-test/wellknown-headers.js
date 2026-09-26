'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { readFileSync } = require('node:fs')
const { OUT, generate } = require('../../build/wellknown-headers.js')

test('the WASM well-known header lookup matches wellknownHeaderNames', () => {
  // The glue reports an index into wellknownHeaderNames; a stale table would
  // hand the client the wrong preallocated name. Regenerate with
  // `node build/wellknown-headers.js` and rebuild the WASM.
  assert.strictEqual(readFileSync(OUT, 'utf8'), generate())
})
