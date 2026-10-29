'use strict'

const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { once } = require('node:events')

Object.defineProperty(process, 'arch', {
  ...Object.getOwnPropertyDescriptor(process, 'arch'),
  value: 'riscv64'
})

const generic = require('../../lib/llhttp/llhttp-wasm.js')
const simd = require('../../lib/llhttp/llhttp_simd-wasm.js')
const compile = WebAssembly.compile
const compiled = []

WebAssembly.compile = function (source) {
  compiled.push(source === generic ? 'generic' : source === simd ? 'simd' : 'unknown')
  return compile(source)
}

async function main () {
  const server = createServer((req, res) => res.end('ok'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const { Client } = require('../..')
  const client = new Client(`http://127.0.0.1:${server.address().port}`)

  try {
    const response = await client.request({ path: '/', method: 'GET' })
    assert.equal(await response.body.text(), 'ok')
    assert.deepEqual(compiled, ['generic'])
  } finally {
    await client.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(err => {
  process.nextTick(() => { throw err })
})
