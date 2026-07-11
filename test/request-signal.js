'use strict'

const { createServer } = require('node:http')
const assert = require('node:assert/strict')
const { test, after } = require('node:test')
const { tspl } = require('@matteo.collina/tspl')
const { Client, request } = require('..')

test('pre abort signal w/ reason', async (t) => {
  t = tspl(t, { plan: 1 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, async () => {
    const ac = new AbortController()
    const _err = new Error()
    ac.abort(_err)
    try {
      await request(`http://0.0.0.0:${server.address().port}`, { signal: ac.signal })
    } catch (err) {
      t.equal(err, _err)
    }
  })
  await t.completed
})

test('post abort signal', async (t) => {
  t = tspl(t, { plan: 1 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, async () => {
    const ac = new AbortController()
    const ures = await request(`http://0.0.0.0:${server.address().port}`, { signal: ac.signal })
    ac.abort()
    try {
      /* eslint-disable-next-line no-unused-vars */
      for await (const chunk of ures.body) {
        // Do nothing...
      }
    } catch (err) {
      t.equal(err.name, 'AbortError')
    }
  })
  await t.completed
})

test('post abort signal w/ reason', async (t) => {
  t = tspl(t, { plan: 1 })

  const server = createServer((req, res) => {
    res.end('asd')
  })
  after(() => server.close())

  server.listen(0, async () => {
    const ac = new AbortController()
    const _err = new Error()
    const ures = await request(`http://0.0.0.0:${server.address().port}`, { signal: ac.signal })
    ac.abort(_err)
    try {
      /* eslint-disable-next-line no-unused-vars */
      for await (const chunk of ures.body) {
        // Do nothing...
      }
    } catch (err) {
      t.equal(err, _err)
    }
  })
  await t.completed
})

test('request abort cannot be blocked by stopImmediatePropagation', async (t) => {
  const server = createServer((req, res) => {
    setTimeout(() => res.end('not aborted'), 50)
  })
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(async () => {
    await client.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  const controller = new AbortController()
  const reason = new Error('abort reason')
  controller.signal.addEventListener('abort', (event) => {
    event.stopImmediatePropagation()
  })

  const pending = client.request({
    path: '/',
    method: 'GET',
    signal: controller.signal
  })
  controller.abort(reason)

  await assert.rejects(pending, err => err === reason)
})

test('request disposes structural AbortSignal listener after body close', async (t) => {
  const server = createServer((req, res) => {
    res.end('ok')
  })
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(async () => {
    await client.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  const target = new EventTarget()
  let removals = 0
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener (...args) {
      target.addEventListener(...args)
    },
    removeEventListener (...args) {
      removals++
      target.removeEventListener(...args)
    }
  }

  const response = await client.request({
    path: '/',
    method: 'GET',
    signal
  })
  await response.body.dump()

  assert.equal(removals, 1)
})

test('request preserves legacy third-party EventTarget signals', async (t) => {
  const server = createServer((req, res) => {
    setTimeout(() => res.end('not aborted'), 50)
  })
  await new Promise((resolve) => server.listen(0, resolve))

  const client = new Client(`http://localhost:${server.address().port}`)
  t.after(async () => {
    await client.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  const target = new EventTarget()
  const reason = new Error('third-party abort reason')
  let removals = 0
  const signal = {
    reason,
    addEventListener (...args) {
      target.addEventListener(...args)
    },
    removeEventListener (...args) {
      removals++
      target.removeEventListener(...args)
    }
  }

  const pending = client.request({
    path: '/',
    method: 'GET',
    signal
  })
  target.dispatchEvent(new Event('abort'))

  await assert.rejects(pending, err => err === reason)
  assert.equal(removals, 1)
})
