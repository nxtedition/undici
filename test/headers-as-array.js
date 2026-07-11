'use strict'

const assert = require('node:assert/strict')
const { tspl } = require('@matteo.collina/tspl')
const { test, after } = require('node:test')
const { Client, errors } = require('..')
const { createServer } = require('node:http')
const { once } = require('node:events')

test('handle headers as array', async (t) => {
  t = tspl(t, { plan: 3 })
  const headers = ['a', '1', 'b', '2', 'c', '3']

  const server = createServer((req, res) => {
    t.strictEqual(req.headers.a, '1')
    t.strictEqual(req.headers.b, '2')
    t.strictEqual(req.headers.c, '3')
    res.end()
  })
  after(() => server.close())
  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.close())

    client.request({
      path: '/',
      method: 'GET',
      headers
    }, () => { })
  })

  await t.completed
})

test('handle multi-valued headers as array', async (t) => {
  t = tspl(t, { plan: 4 })
  const headers = ['a', '1', 'b', '2', 'c', '3', 'd', '4', 'd', '5']

  const server = createServer((req, res) => {
    t.strictEqual(req.headers.a, '1')
    t.strictEqual(req.headers.b, '2')
    t.strictEqual(req.headers.c, '3')
    t.strictEqual(req.headers.d, '4, 5')
    res.end()
  })
  after(() => server.close())
  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.close())

    client.request({
      path: '/',
      method: 'GET',
      headers
    }, () => { })
  })

  await t.completed
})

test('handle headers with array', async (t) => {
  t = tspl(t, { plan: 4 })
  const headers = { a: '1', b: '2', c: '3', d: ['4'] }

  const server = createServer((req, res) => {
    t.strictEqual(req.headers.a, '1')
    t.strictEqual(req.headers.b, '2')
    t.strictEqual(req.headers.c, '3')
    t.strictEqual(req.headers.d, '4')
    res.end()
  })
  after(() => server.close())
  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.close())

    client.request({
      path: '/',
      method: 'GET',
      headers
    }, () => { })
  })

  await t.completed
})

test('handle multi-valued headers', async (t) => {
  t = tspl(t, { plan: 4 })
  const headers = { a: '1', b: '2', c: '3', d: ['4', '5'] }

  const server = createServer((req, res) => {
    t.strictEqual(req.headers.a, '1')
    t.strictEqual(req.headers.b, '2')
    t.strictEqual(req.headers.c, '3')
    t.strictEqual(req.headers.d, '4, 5')
    res.end()
  })
  after(() => server.close())
  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.close())

    client.request({
      path: '/',
      method: 'GET',
      headers
    }, () => { })
  })

  await t.completed
})

test('read array-valued header elements once', async (t) => {
  t = tspl(t, { plan: 4 })

  let valueReads = 0
  let lengthReads = 0
  const values = new Proxy(['safe'], {
    get (target, property, receiver) {
      if (property === 'length') {
        lengthReads++
      } else if (property === '0') {
        valueReads++
        return valueReads < 3 ? 'safe' : 'safe\r\nx-injected: true'
      }

      return Reflect.get(target, property, receiver)
    }
  })

  const server = createServer((req, res) => {
    t.strictEqual(req.headers.name, 'safe')
    t.strictEqual(req.headers['x-injected'], undefined)
    res.end()
  })
  after(() => server.close())
  server.listen(0)
  await once(server, 'listening')

  const client = new Client(`http://localhost:${server.address().port}`)
  after(() => client.close())

  const { body } = await client.request({
    path: '/',
    method: 'GET',
    headers: { name: values }
  })
  await body.dump()

  t.strictEqual(valueReads, 1)
  t.strictEqual(lengthReads, 1)

  await t.completed
})

test('read invalid array-valued header elements once', async (t) => {
  t = tspl(t, { plan: 2 })

  let reads = 0
  const values = new Proxy(['invalid'], {
    get (target, property, receiver) {
      if (property === '0') {
        reads++
        return 'invalid\r\nx-injected: true'
      }

      return Reflect.get(target, property, receiver)
    }
  })

  const client = new Client('http://localhost:8080')
  after(() => client.destroy())

  t.rejects(client.request({
    path: '/',
    method: 'GET',
    headers: { name: values }
  }), new errors.InvalidArgumentError('invalid name header'))
  t.strictEqual(reads, 1)

  await t.completed
})

test('reject coerced header injection before connecting', async (t) => {
  let connections = 0
  const client = new Client('http://localhost', {
    connect (opts, callback) {
      connections++
      callback(new Error('unexpected connection'))
    }
  })
  t.after(() => client.destroy())

  let scalarReads = 0
  const scalarValue = function () {}
  scalarValue.toString = () => {
    scalarReads++
    return 'safe\r\nx-injected-scalar: true'
  }

  let arrayReads = 0
  const arrayValue = function () {}
  arrayValue.toString = () => {
    arrayReads++
    return 'safe\r\nx-injected-array: true'
  }

  let keyReads = 0
  const mutableKey = {
    toString () {
      keyReads++
      return keyReads === 1
        ? 'name'
        : 'name\r\nx-injected-key: true'
    },
    toLowerCase () {
      return 'name'
    }
  }

  await assert.rejects(
    client.request({
      path: '/',
      method: 'GET',
      headers: { name: scalarValue }
    }),
    new errors.InvalidArgumentError('invalid name header')
  )
  await assert.rejects(
    client.request({
      path: '/',
      method: 'GET',
      headers: { name: [arrayValue] }
    }),
    new errors.InvalidArgumentError('invalid name header')
  )
  await assert.rejects(
    client.request({
      path: '/',
      method: 'GET',
      headers: [mutableKey, 'safe']
    }),
    new errors.InvalidArgumentError('invalid header key')
  )

  assert.strictEqual(scalarReads, 1)
  assert.strictEqual(arrayReads, 1)
  assert.strictEqual(keyReads, 0)
  assert.strictEqual(connections, 0)
})

test('fail if headers array is odd', async (t) => {
  t = tspl(t, { plan: 2 })
  const headers = ['a', '1', 'b', '2', 'c', '3', 'd']

  const server = createServer((req, res) => { res.end() })
  after(() => server.close())
  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.close())

    client.request({
      path: '/',
      method: 'GET',
      headers
    }, (err) => {
      t.ok(err instanceof errors.InvalidArgumentError)
      t.strictEqual(err.message, 'headers array must be even')
    })
  })

  await t.completed
})

test('fail if headers is not an object or an array', async (t) => {
  t = tspl(t, { plan: 2 })
  const headers = 'not an object or an array'

  const server = createServer((req, res) => { res.end() })
  after(() => server.close())
  server.listen(0, () => {
    const client = new Client(`http://localhost:${server.address().port}`)
    after(() => client.close())

    client.request({
      path: '/',
      method: 'GET',
      headers
    }, (err) => {
      t.ok(err instanceof errors.InvalidArgumentError)
      t.strictEqual(err.message, 'headers must be an object or an array')
    })
  })

  await t.completed
})
