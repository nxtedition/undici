'use strict'

// Vendors the CommonJS package of milo into lib/milo. With MILO_PACKAGE_DIR set,
// an unpacked package is copied instead of the npm one.

const { execFileSync } = require('node:child_process')
const { cpSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const OUT = resolve(__dirname, '../lib/milo')
const PACKAGE = '@perseveranza-pets/milo-cjs@0.8.0'
const PACKAGE_DIR = process.env.MILO_PACKAGE_DIR

rmSync(OUT, { recursive: true, force: true })

if (PACKAGE_DIR) {
  cpSync(PACKAGE_DIR, OUT, { recursive: true })
} else {
  const dir = mkdtempSync(join(tmpdir(), 'milo-'))
  try {
    const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', PACKAGE, '--json'], { cwd: dir, encoding: 'utf8' }))
    execFileSync('tar', ['-xzf', join(dir, filename), '-C', dir], { stdio: 'inherit' })
    cpSync(join(dir, 'package'), OUT, { recursive: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
