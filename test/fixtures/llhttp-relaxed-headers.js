'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { TYPE, ERROR } = require('../../lib/llhttp/constants')

const moduleBytes = readFileSync(join(__dirname, '../../lib/llhttp', process.argv[2]))
const values = []
let complete = 0
const { exports: parser } = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes), {
  env: {
    wasm_on_url: () => 0,
    wasm_on_status: () => 0,
    wasm_on_message_begin: () => 0,
    wasm_on_header_field: () => 0,
    wasm_on_header_value: (ptr, data, length) => {
      values.push(Buffer.from(new Uint8Array(parser.memory.buffer, data, length)))
      return 0
    },
    wasm_on_headers_complete: () => 0,
    wasm_on_body: () => 0,
    wasm_on_message_complete: () => { complete++; return 0 }
  }
})

function parse (value, expected) {
  const response = Buffer.concat([
    Buffer.from('HTTP/1.1 200 OK\r\nX-Value: '), value,
    Buffer.from('\r\nContent-Length: 0\r\n\r\n')
  ])
  const ptr = parser.llhttp_alloc(TYPE.RESPONSE)
  const data = parser.malloc(response.length)
  parser.llhttp_set_lenient_header_value_relaxed(ptr, 1)
  new Uint8Array(parser.memory.buffer, data, response.length).set(response)
  values.length = 0
  complete = 0
  assert.strictEqual(parser.llhttp_execute(ptr, data, response.length), expected)
  assert.strictEqual(complete, expected === ERROR.OK ? 1 : 0)
  if (expected === ERROR.OK) assert.deepStrictEqual(values, [value, Buffer.from('0')])
  parser.free(data)
  parser.llhttp_free(ptr)
}

// Enter the relaxed path, then exercise ASCII and obs-text in full SIMD
// blocks and the scalar tail.
for (const byte of [0x41, 0x7f, 0x80, 0xff]) {
  parse(Buffer.concat([Buffer.from([1]), Buffer.alloc(33, byte)]), ERROR.OK)
}

// NUL remains invalid even in relaxed mode, at SIMD boundaries and in tails.
for (const offset of [0, 15, 16, 33]) {
  parse(Buffer.concat([
    Buffer.from([1]), Buffer.alloc(offset, 0xff), Buffer.from([0]), Buffer.alloc(32, 0x41)
  ]), ERROR.INVALID_HEADER_TOKEN)
}
