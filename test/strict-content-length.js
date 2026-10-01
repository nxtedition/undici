'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { Readable } = require('node:stream')
const { test } = require('node:test')
const { Agent, Client, Pool, errors } = require('..')

const bodies = {
  string: () => 'abcd',
  buffer: () => Buffer.from('abcd'),
  blob: () => new Blob(['abcd']),
  stream: () => Readable.from(['ab', 'cd']),
  iterable: () => ['ab', 'cd'],
  asyncIterable: () => (async function * () {
    yield 'ab'
    yield 'cd'
  })()
}

for (const Dispatcher of [Client, Pool, Agent]) {
  for (const options of [{}, { strictContentLength: false }]) {
    const mode = options.strictContentLength === false ? 'legacy false option' : 'default options'

    test(`${Dispatcher.name} checks content-length with ${mode}`, { timeout: 10000 }, async (t) => {
      const emitWarning = t.mock.method(process, 'emitWarning', () => {})
      const server = createServer((req, res) => {
        req.on('error', () => {})
        req.resume()
        req.on('end', () => res.end('ok'))
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')

      const origin = `http://127.0.0.1:${server.address().port}`
      const dispatcher = Dispatcher === Agent ? new Agent(options) : new Dispatcher(origin, options)
      t.after(async () => {
        await dispatcher.destroy()
        server.closeAllConnections()
        await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
      })

      for (const [name, createBody] of Object.entries(bodies)) {
        for (const contentLength of [0, 2, 6]) {
          await t.test(`${name} rejects content-length ${contentLength}`, async () => {
            await assert.rejects(dispatcher.request({
              origin,
              path: '/',
              method: 'PUT',
              headers: { 'content-length': contentLength },
              body: createBody()
            }), errors.RequestContentLengthMismatchError)

            const { statusCode, body } = await dispatcher.request({
              origin,
              path: '/',
              method: 'PUT',
              headers: { 'content-length': 4 },
              body: createBody()
            })
            assert.equal(statusCode, 200)
            assert.equal(await body.text(), 'ok')
          })
        }
      }

      assert.equal(emitWarning.mock.callCount(), 0)
    })
  }
}
