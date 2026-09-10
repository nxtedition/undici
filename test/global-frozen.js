'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { test } = require('node:test')

const fixture = join(__dirname, 'fixtures', 'frozen-global.js')

for (const phase of ['before-import', 'after-import']) {
  test(`supports globalThis frozen ${phase.replace('-', ' ')}`, () => {
    const result = spawnSync(process.execPath, [fixture, phase], {
      encoding: 'utf8',
      timeout: 5000
    })

    assert.ifError(result.error)
    assert.strictEqual(result.status, 0, result.stderr)
  })
}
