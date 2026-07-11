'use strict'

const { tspl } = require('@matteo.collina/tspl')
const { test, describe } = require('node:test')
const { once } = require('node:events')
const Readable = require('../lib/api/readable')

describe('Readable', () => {
  test('avoid body reordering', async function (t) {
    t = tspl(t, { plan: 1 })

    function resume () {
    }
    function abort () {
    }
    const r = new Readable({ resume, abort })

    r.push(Buffer.from('hello'))

    process.nextTick(() => {
      r.push(Buffer.from('world'))
      r.push(null)
    })

    const text = await r.text()

    t.strictEqual(text, 'helloworld')
  })

  test('destroy timing text', async function (t) {
    t = tspl(t, { plan: 1 })

    function resume () {
    }
    function abort () {
    }

    const r = new Readable({ resume, abort })
    r.destroy(new Error('kaboom'))

    await t.rejects(r.text(), new Error('kaboom'))
  })

  test('destroy timing promise', async function (t) {
    t = tspl(t, { plan: 1 })

    function resume () {
    }
    function abort () {
    }
    const r = await new Promise(resolve => {
      const r = new Readable({ resume, abort })
      r.destroy(new Error('kaboom'))
      resolve(r)
    })
    await new Promise(resolve => {
      r.on('error', err => {
        t.ok(err)
        resolve(null)
      })
    })
  })

  test('generic destroy keeps falsy errors on the normal Readable path', async function (t) {
    t = tspl(t, { plan: 4 })

    let aborts = 0
    const r = new Readable({
      resume () {},
      abort () { aborts++ }
    })
    const errorEvent = once(r, 'error')
    const closeEvent = new Promise(resolve => r.once('close', resolve))

    r.destroy(false)

    const [err] = await errorEvent
    await closeEvent
    t.ok(err instanceof Error)
    t.strictEqual(err.code, 'UND_ERR_ABORTED')
    t.strictEqual(aborts, 1)
    t.strictEqual(await r.text().catch(err => err), err)
  })

  test('destroy releases raw chunks preserved by setEncoding', async function (t) {
    if (typeof global.gc !== 'function') {
      throw new Error('gc is not available. Run with \'--expose-gc\'.')
    }

    t = tspl(t, { plan: 2 })

    let aborts = 0
    const r = new Readable({
      resume () {},
      abort () {
        aborts++
      }
    })

    r.on('error', () => {})
    r.setEncoding('utf8')

    const rawChunkRef = (() => {
      const chunk = Buffer.allocUnsafeSlow(64 * 1024).fill(0x61)
      r.push(chunk)
      return new WeakRef(chunk)
    })()

    const closed = new Promise(resolve => r.once('close', resolve))
    r.destroy()
    await closed

    for (let i = 0; i < 10 && rawChunkRef.deref() !== undefined; i++) {
      await new Promise(resolve => setImmediate(resolve))
      global.gc()
    }

    t.strictEqual(aborts, 1)
    t.strictEqual(rawChunkRef.deref() === undefined, true)
  })

  test('destroy rejects a pending encoded body mixin', async function (t) {
    t = tspl(t, { plan: 1 })

    const r = new Readable({
      resume () {},
      abort () {}
    })
    r.setEncoding('utf8')
    r.push(Buffer.from('hello'))

    const text = r.text()
    const error = new Error('kaboom')
    r.destroy(error)

    await t.rejects(text, error)
  })

  test('.arrayBuffer()', async function (t) {
    t = tspl(t, { plan: 1 })

    function resume () {
    }
    function abort () {
    }
    const r = new Readable({ resume, abort })

    r.push(Buffer.from('hello world'))

    process.nextTick(() => {
      r.push(null)
    })

    const arrayBuffer = await r.arrayBuffer()

    const expected = new ArrayBuffer(11)
    const view = new Uint8Array(expected)
    view.set(Buffer.from('hello world'))
    t.deepStrictEqual(arrayBuffer, expected)
  })

  test('.bytes()', async function (t) {
    t = tspl(t, { plan: 1 })

    function resume () {
    }
    function abort () {
    }
    const r = new Readable({ resume, abort })

    r.push(Buffer.from('hello'))
    r.push(Buffer.from(' world'))

    process.nextTick(() => {
      r.push(null)
    })

    const bytes = await r.bytes()

    t.deepStrictEqual(bytes, new TextEncoder().encode('hello world'))
  })

  test('.json()', async function (t) {
    t = tspl(t, { plan: 1 })

    function resume () {
    }
    function abort () {
    }
    const r = new Readable({ resume, abort })

    r.push(Buffer.from('{"hello": "world"}'))

    process.nextTick(() => {
      r.push(null)
    })

    const obj = await r.json()

    t.deepStrictEqual(obj, { hello: 'world' })
  })

  test('.json() rejects invalid JSON without aborting the completed body', async function (t) {
    t = tspl(t, { plan: 2 })

    let aborts = 0
    const r = new Readable({
      resume () {},
      abort () { aborts++ }
    })

    r.push(Buffer.from('not json'))
    r.push(null)

    await t.rejects(r.json(), SyntaxError)
    t.strictEqual(aborts, 0)
  })

  test('.json() preserves its parse error after the body already ended', async function (t) {
    t = tspl(t, { plan: 2 })

    let aborts = 0
    const r = new Readable({
      resume () {},
      abort () { aborts++ }
    })

    r.push(null)
    r.resume()
    await once(r, 'end')

    await t.rejects(r.json(), SyntaxError)
    t.strictEqual(aborts, 0)
  })

  test('.json() ignores late chunks after close', async function (t) {
    t = tspl(t, { plan: 2 })

    function resume () {
    }
    function abort () {
    }
    const r = new Readable({ resume, abort })
    const jsonPromise = r.json()

    await new Promise(resolve => queueMicrotask(resolve))

    r.emit('close')
    t.strictEqual(r.push(Buffer.from('late chunk')), true)

    await t.rejects(jsonPromise, { name: 'AbortError' })
  })

  test('.text()', async function (t) {
    t = tspl(t, { plan: 1 })

    function resume () {
    }
    function abort () {
    }
    const r = new Readable({ resume, abort })

    r.push(Buffer.from('hello world'))

    process.nextTick(() => {
      r.push(null)
    })

    const text = await r.text()

    t.strictEqual(text, 'hello world')
  })

  test('ignore BOM', async function (t) {
    t = tspl(t, { plan: 1 })

    function resume () {
    }
    function abort () {
    }
    const r = new Readable({ resume, abort })

    r.push('\uFEFF')
    r.push(Buffer.from('hello world'))

    process.nextTick(() => {
      r.push(null)
    })

    const text = await r.text()

    t.strictEqual(text, 'hello world')
  })

  test('.bodyUsed', async function (t) {
    t = tspl(t, { plan: 3 })

    function resume () {
    }
    function abort () {
    }
    const r = new Readable({ resume, abort })

    r.push(Buffer.from('hello world'))

    process.nextTick(() => {
      r.push(null)
    })

    t.strictEqual(r.bodyUsed, false)

    const text = await r.text()

    t.strictEqual(r.bodyUsed, true)

    t.strictEqual(text, 'hello world')
  })

  test('.bodyUsed reflects Node Readable consumption', async function (t) {
    t = tspl(t, { plan: 3 })

    const r = new Readable({
      resume () {},
      abort () {}
    })

    r.push(Buffer.from('hello world'))
    r.push(null)

    t.strictEqual(r.bodyUsed, false)
    t.strictEqual(r.read().toString(), 'hello world')
    t.strictEqual(r.bodyUsed, true)

    await t.completed
  })

  // Regression: for a body that has already emitted 'end' but was never
  // disturbed, consumeEnd() completes synchronously and consumeFinish() nulls
  // consume.stream. consumeStart() must return immediately instead of falling
  // through to resume()/read() on that null stream.
  test('consume on an already-ended, undisturbed empty body resolves', async function (t) {
    t = tspl(t, { plan: 1 })

    function resume () {
    }
    function abort () {
    }
    const r = new Readable({ resume, abort })

    r.push(null)
    r.resume()
    await once(r, 'end')

    // endEmitted is true while the stream is not disturbed, so consume() reaches
    // the synchronous completion path in consumeStart().
    const text = await r.text()

    t.strictEqual(text, '')
  })
})
