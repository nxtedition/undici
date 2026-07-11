'use strict'

const assert = require('node:assert')
const { createServer } = require('node:http')
const net = require('node:net')
const { once } = require('node:events')
const { test } = require('node:test')
const { Client } = require('..')

async function createFixture (t, setTypeOfService) {
  const server = createServer((req, res) => {
    res.end('ok')
  })

  server.listen(0)
  await once(server, 'listening')

  let connections = 0
  const client = new Client(`http://localhost:${server.address().port}`, {
    connect (opts, callback) {
      connections++
      const socket = net.connect({
        ...opts,
        host: opts.hostname,
        port: opts.port
      }, () => {
        callback(null, socket)
      })
      socket.setTypeOfService = setTypeOfService
      return socket
    }
  })

  t.after(async () => {
    await client.close()
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
    })
  })

  return {
    client,
    get connections () {
      return connections
    }
  }
}

async function request (client, options = {}) {
  const response = await client.request({
    path: '/',
    method: 'GET',
    ...options
  })

  assert.strictEqual(await response.body.text(), 'ok')
}

test('HTTP/1.1 skips implicit default type of service on a fresh socket', async (t) => {
  const priorities = []
  const fixture = await createFixture(t, (priority) => {
    priorities.push(priority)
  })

  await request(fixture.client)

  assert.deepStrictEqual(priorities, [])
  assert.strictEqual(fixture.connections, 1)
})

test('HTTP/1.1 applies an explicit type of service without redundant calls', async (t) => {
  const priorities = []
  const fixture = await createFixture(t, (priority) => {
    priorities.push(priority)
  })

  await request(fixture.client, { typeOfService: 0 })
  await request(fixture.client, { typeOfService: 0 })

  assert.deepStrictEqual(priorities, [0])
  assert.strictEqual(fixture.connections, 1)
})

test('HTTP/1.1 resets type of service on a reused socket', async (t) => {
  const priorities = []
  const fixture = await createFixture(t, (priority) => {
    priorities.push(priority)
  })

  await request(fixture.client, { typeOfService: 42 })
  await request(fixture.client, { typeOfService: 42 })
  await request(fixture.client)
  await request(fixture.client)

  assert.deepStrictEqual(priorities, [42, 0])
  assert.strictEqual(fixture.connections, 1)
})

test('HTTP/1.1 ignores type of service errors and keeps the client usable', async (t) => {
  const priorities = []
  const fixture = await createFixture(t, (priority) => {
    priorities.push(priority)
    throw new Error('setTypeOfService EINVAL')
  })

  await request(fixture.client, { typeOfService: 42 })
  await request(fixture.client)

  assert.deepStrictEqual(priorities, [42])
  assert.strictEqual(fixture.connections, 1)
})
