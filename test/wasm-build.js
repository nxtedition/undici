'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')

test('wasm build treats an optimizer path as an executable, not shell input', () => {
  const optimizer = '/tmp/tool directory/wasm-opt;literal'
  const calls = []
  const shells = []
  const script = path.resolve(__dirname, '../build/wasm.js')

  runInNewContext(readFileSync(script, 'utf8'), {
    __dirname: path.dirname(script),
    process: { env: { WASM_OPT: optimizer }, argv: [] },
    console: { log () {} },
    require (name) {
      if (name === 'node:child_process') {
        return {
          execSync (command) {
            shells.push(command)
            if (command === 'command -v apk') throw new Error('not Alpine')
            return Buffer.alloc(0)
          },
          execFileSync (file, args) {
            calls.push({ file, args: Array.from(args) })
            return Buffer.alloc(0)
          }
        }
      }
      if (name === 'node:fs') {
        return { readFileSync: () => Buffer.alloc(0), writeFileSync () {} }
      }
      return require(name)
    }
  })

  assert.ok(shells.every(command => !command.includes(optimizer)))
  assert.equal(calls.length, 3, 'availability and both optimizer invocations use execFileSync')
  assert.deepEqual(calls[0], { file: optimizer, args: ['--version'] })
  for (const [index, name] of ['llhttp', 'llhttp_simd'].entries()) {
    const { file, args } = calls[index + 1]
    assert.equal(file, optimizer)
    assert.equal(args.includes('--enable-simd'), index === 1)
    assert.deepEqual(args.slice(-3), [
      '-o',
      path.resolve(__dirname, `../lib/llhttp/${name}.wasm`),
      path.resolve(__dirname, `../lib/llhttp/${name}.wasm`)
    ])
  }
})

test('wasm build fails before compiling or writing artifacts if the optimizer is unavailable', () => {
  const script = path.resolve(__dirname, '../build/wasm.js')
  const missing = new Error('optimizer unavailable')
  assert.throws(() => runInNewContext(readFileSync(script, 'utf8'), {
    __dirname: path.dirname(script),
    process: { env: {}, argv: [] },
    require (name) {
      if (name === 'node:child_process') {
        return {
          execSync (command) {
            assert.strictEqual(command, 'command -v apk', 'must not invoke the compiler')
            throw new Error('not Alpine')
          },
          execFileSync () { throw missing }
        }
      }
      if (name === 'node:fs') {
        return { writeFileSync () { assert.fail('must not write artifacts') } }
      }
      return require(name)
    }
  }), err => err === missing)
})
