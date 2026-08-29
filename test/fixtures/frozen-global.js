'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { join } = require('node:path')

const phase = process.argv[2]
const packagePath = join(__dirname, '..', '..')

if (phase === 'before-import') {
  Object.freeze(globalThis)
} else if (phase !== 'after-import') {
  throw new Error(`Unknown freeze phase: ${phase}`)
}

const {
  Agent,
  getGlobalDispatcher,
  setGlobalDispatcher
} = require(packagePath)
const {
  kSockets,
  sockets,
  trackSocket
} = require(join(packagePath, 'lib', 'core', 'socket-registry.js'))

const originalDispatcher = getGlobalDispatcher()

if (phase === 'after-import') {
  assert.strictEqual(globalThis[kSockets], sockets)
  assert.strictEqual(globalThis.__undici_sockets, sockets)
  Object.freeze(globalThis)
}

assert.strictEqual(Object.isFrozen(globalThis), true)

const dispatcher = new Agent()
setGlobalDispatcher(dispatcher)
assert.strictEqual(getGlobalDispatcher(), dispatcher)

if (phase === 'after-import') {
  assert.strictEqual(
    globalThis[Symbol.for('nxtedition.globalDispatcher.2')],
    originalDispatcher
  )
  assert.strictEqual(globalThis[kSockets], sockets)
  assert.strictEqual(globalThis.__undici_sockets, sockets)
} else {
  assert.strictEqual(globalThis[Symbol.for('nxtedition.globalDispatcher.2')], undefined)
  assert.strictEqual(globalThis[kSockets], undefined)
  assert.strictEqual(globalThis.__undici_sockets, undefined)
}

const socket = new EventEmitter()
const origin = 'http://frozen.example'
trackSocket(socket, origin, { hostname: 'frozen.example' })
assert.deepStrictEqual(sockets.get(socket), {
  hostname: 'frozen.example',
  origin
})

socket.emit('close')
assert.strictEqual(sockets.has(socket), false)
