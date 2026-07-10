'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { test } = require('node:test')

test('a synchronous request callback exception is uncaught', () => {
  const fixture = join(__dirname, 'fixtures', 'request-callback-throws.js')
  const result = spawnSync(process.execPath, [fixture], {
    encoding: 'utf8',
    timeout: 5000
  })

  assert.ifError(result.error)
  assert.strictEqual(result.status, 0, result.stderr)
  assert.strictEqual(result.stdout, 'caught request callback failure\n')
})
