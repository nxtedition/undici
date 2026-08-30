'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const net = require('node:net')
const { test } = require('node:test')
const { Client, errors } = require('..')

function dispatchUpgrade (client, upgrade) {
  return new Promise((resolve, reject) => {
    client.dispatch({
      path: '/',
      method: 'GET',
      upgrade
    }, {
      onConnect () {},
      onUpgrade () {
        resolve()
      },
      onError: reject
    })
  })
}

// Ported from nodejs/undici commit 77594f923cef4c27ee0bad365e7b4c44a199edae.
test('upgrade values reject header injection characters', async (t) => {
  const client = new Client('http://127.0.0.1')
  t.after(() => client.close())

  for (const [name, protocol] of [
    ['CRLF sequence', 'websocket\r\n\r\nSET pwned true'],
    ['lone CR', 'websocket\rinjected'],
    ['lone LF', 'websocket\ninjected'],
    ['NUL byte', 'websocket\0injected']
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        client.request({
          path: '/',
          method: 'GET',
          upgrade: protocol
        }),
        {
          name: 'InvalidArgumentError',
          message: 'invalid upgrade header'
        }
      )

      await assert.rejects(
        dispatchUpgrade(client, protocol),
        {
          name: 'InvalidArgumentError',
          message: 'invalid upgrade header'
        }
      )
    })
  }
})

test('client.request rejects an injected upgrade option', async (t) => {
  const client = new Client('http://127.0.0.1')
  t.after(() => client.close())

  await assert.rejects(
    client.request({
      path: '/',
      method: 'GET',
      upgrade: 'websocket\r\n\r\nGET /smuggled HTTP/1.1'
    }),
    (err) => {
      assert.ok(err instanceof errors.InvalidArgumentError)
      assert.equal(err.message, 'invalid upgrade header')
      return true
    }
  )
})

test('a valid upgrade value is accepted', async (t) => {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n\r\n'
      )
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())

  const { port } = server.address()
  const client = new Client(`http://127.0.0.1:${port}`)
  t.after(() => client.close())

  await new Promise((resolve, reject) => {
    client.dispatch({
      path: '/',
      method: 'GET',
      upgrade: 'websocket'
    }, {
      onConnect () {},
      onUpgrade (statusCode, headers, socket) {
        assert.equal(statusCode, 101)
        socket.destroy()
        resolve()
      },
      onError: reject
    })
  })
})
