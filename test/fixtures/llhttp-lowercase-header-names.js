'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { TYPE, ERROR } = require('../../lib/llhttp/constants')
const { wellknownHeaderNames } = require('../../lib/core/constants')

// The glue reports a name's 1-based index in wellknownHeaderNames, or 0.
const WELLKNOWN = new Map(wellknownHeaderNames.map((name, i) => [name.toLowerCase(), i + 1]))

const moduleBytes = readFileSync(join(__dirname, '../../lib/llhttp', process.argv[2]))
const fields = []
const ids = []
const values = []
let complete = 0
const { exports: parser } = new WebAssembly.Instance(new WebAssembly.Module(moduleBytes), {
  env: {
    wasm_on_url: () => 0,
    wasm_on_status: () => 0,
    wasm_on_message_begin: () => 0,
    wasm_on_header_field: (ptr, data, length, wellknown) => {
      fields.push(Buffer.from(new Uint8Array(parser.memory.buffer, data, length)))
      ids.push(wellknown)
      return 0
    },
    wasm_on_header_value: (ptr, data, length) => {
      values.push(Buffer.from(new Uint8Array(parser.memory.buffer, data, length)))
      return 0
    },
    wasm_on_headers_complete: () => 0,
    wasm_on_body: () => 0,
    wasm_on_message_complete: () => { complete++; return 0 }
  }
})

// Uppercase guard bytes around the input: a load/store that strays outside a
// span lowercases them. A span cut at a chunk edge sits right against a guard.
const GUARD = 32
const GUARD_BYTE = 0x41

// Letters of both cases and the token characters around 'A'-'Z' and 'a'-'z'.
const TCHARS = 'AbCdEfGhIjKlMnOpQrStUvWxYz^_`|~!#$%&\'*+-.0123456789ZzAaMm'

function name (length) {
  let str = ''
  for (let i = 0; i < length; i++) {
    str += TCHARS[(i * 7 + length) % TCHARS.length]
  }
  return str
}

function lower (str) {
  return str.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

// The framing header ends every response, so it is checked in each parse.
const FRAMING = {
  'Content-Length': { value: '0', body: [] },
  'Transfer-Encoding': { value: 'chunked', body: ['0', ''] }
}

function parse (names, framing = 'Content-Length') {
  const lines = ['HTTP/1.1 200 OK']
  for (const field of names) {
    lines.push(`${field}: Value-${field}`)
  }
  lines.push(`${framing}: ${FRAMING[framing].value}`, '', ...FRAMING[framing].body, '')
  const response = Buffer.from(lines.join('\r\n'), 'latin1')
  const expected = Buffer.from(lines.map((line, i) => {
    const colon = line.indexOf(':')
    return i === 0 || colon === -1 ? line : lower(line.slice(0, colon)) + line.slice(colon)
  }).join('\r\n'), 'latin1')

  const base = parser.malloc(response.length + GUARD * 2)
  const data = base + GUARD

  // Split once at every offset, so each name is cut at each of its positions.
  for (let split = 0; split <= response.length; split++) {
    const ptr = parser.llhttp_alloc(TYPE.RESPONSE)
    fields.length = 0
    ids.length = 0
    values.length = 0
    complete = 0

    for (const [start, end] of [[0, split], [split, response.length]]) {
      const memory = new Uint8Array(parser.memory.buffer, base, response.length + GUARD * 2)
      memory.fill(GUARD_BYTE)
      memory.set(response.subarray(start, end), GUARD)
      assert.strictEqual(parser.llhttp_execute(ptr, data, end - start), ERROR.OK)

      const after = Buffer.from(new Uint8Array(parser.memory.buffer, base, response.length + GUARD * 2))
      assert.ok(after.subarray(0, GUARD).every((byte) => byte === GUARD_BYTE), `guard before split ${split}`)
      assert.deepStrictEqual(after.subarray(GUARD, GUARD + end - start), expected.subarray(start, end))
      assert.ok(after.subarray(GUARD + end - start).every((byte) => byte === GUARD_BYTE), `guard after split ${split}`)
    }

    assert.strictEqual(complete, 1)
    // Each piece is reported as well known exactly when it is a whole
    // well-known name, including a prefix cut short at the end of a chunk.
    for (let i = 0; i < fields.length; i++) {
      const piece = fields[i].toString('latin1')
      assert.strictEqual(ids[i], WELLKNOWN.get(piece) ?? 0, `${piece} at split ${split}`)
    }
    // A fragmented span arrives in pieces; the pieces make up the whole name.
    const fieldText = Buffer.concat(fields).toString('latin1')
    assert.strictEqual(fieldText, [...names, framing].map(lower).join(''))
    // Values are handed on as received.
    const valueText = Buffer.concat(values).toString('latin1')
    assert.strictEqual(valueText, [...names.map((field) => `Value-${field}`), FRAMING[framing].value].join(''))

    parser.llhttp_free(ptr)
  }

  parser.free(base)
}

// Every length class of the SIMD path (1-3 scalar, 4-7, 8-15, 16, 17-31, 32+)
// and the scalar loop of the generic build.
const names = []
for (let length = 1; length <= 48; length++) {
  names.push(name(length))
}
parse(names)
// Each name alone, so its span also lands at the start of a chunk.
for (const field of names) {
  parse([field])
}

// Every well-known name as listed and uppercased, and near misses one byte
// longer, shorter, or different at either end. Each gets its own response to
// keep the every-offset split cheap. The framing headers cannot take an
// arbitrary value, so they are covered as the framing header.
parse([], 'Transfer-Encoding')
for (const field of wellknownHeaderNames) {
  if (!Object.hasOwn(FRAMING, field)) {
    parse([field])
    parse([field.toUpperCase()], 'Transfer-Encoding')
  }
  for (const miss of [
    `${field}x`,
    `x${field}`,
    field.slice(0, -1),
    field.slice(1),
    `${field.slice(0, -1)}_`,
    `_${field.slice(1)}`
  ]) {
    if (miss !== '') {
      parse([miss])
    }
  }
}
