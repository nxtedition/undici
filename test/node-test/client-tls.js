'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { constants } = require('node:crypto')
const { once } = require('node:events')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const tls = require('node:tls')
const { Pool } = require('../..')

test('TLS altname errors reject pipelined requests', async (t) => {
  const server = https.createServer({
    key: fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cert.pem'))
  }, (req, res) => {
    res.end('ok')
  })

  t.after(() => {
    server.close()
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  // The fixture cert is not valid for "localhost", so connecting via that
  // hostname triggers ERR_TLS_CERT_ALTNAME_INVALID. With pipelining > 1 this
  // used to crash the process via an assertion instead of rejecting requests.
  const pool = new Pool(`https://localhost:${server.address().port}`, {
    connections: 1,
    pipelining: 10,
    connect: {
      ca: fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'ca.pem'))
    }
  })

  t.after(async () => {
    await pool.close().catch(() => {})
  })

  const settled = await Promise.allSettled(
    Array.from({ length: 20 }, () => pool.request({ path: '/', method: 'GET' }))
  )

  assert.ok(settled.every(({ status }) => status === 'rejected'))
  assert.ok(settled.every(({ reason }) => reason.code === 'ERR_TLS_CERT_ALTNAME_INVALID'))
})

test('TLS certificate errors after connection establishment reject the request', async (t) => {
  const key = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'key.pem'))
  const cert = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cert.pem'))
  const ca = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'ca.pem'))
  const renegotiated = Promise.withResolvers()
  const sockets = new Set()
  const server = tls.createServer({
    key,
    cert,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    secureOptions: constants.SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION
  }, (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.once('data', () => {
      setTimeout(() => {
        renegotiated.resolve(socket.renegotiate({
          requestCert: false,
          rejectUnauthorized: false
        }, () => {}))
      }, 50)
    })
  })
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise((resolve) => server.close(resolve))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  let identityChecks = 0
  const expected = Object.assign(new Error('post-connect certificate rejected'), {
    code: 'ERR_TLS_CERT_ALTNAME_INVALID'
  })
  const pool = new Pool(`https://localhost:${server.address().port}`, {
    connections: 1,
    connect: {
      ca,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      checkServerIdentity () {
        if (++identityChecks > 1) {
          return expected
        }
      }
    }
  })
  t.after(() => pool.destroy())

  const rejected = assert.rejects(
    pool.request({ path: '/', method: 'GET' }),
    err => err === expected
  )

  assert.strictEqual(await renegotiated.promise, true)
  await rejected
  assert.strictEqual(identityChecks, 2)
})
