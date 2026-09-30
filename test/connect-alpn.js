'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const net = require('node:net')
const tls = require('node:tls')
const buildConnector = require('../lib/core/connect')

test('buildConnector accepts omitted options', () => {
  assert.strictEqual(typeof buildConnector(), 'function')
})

test('buildConnector returns its socket and reports null on callback errors', async (t) => {
  const connectError = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
  const originalConnect = net.connect
  net.connect = () => {
    const socket = new net.Socket()
    queueMicrotask(() => socket.emit('error', connectError))
    return socket
  }
  t.after(() => { net.connect = originalConnect })

  const connect = buildConnector({ timeout: 0 })
  let socket
  await new Promise(resolve => {
    socket = connect({ hostname: 'localhost', protocol: 'http:', port: 80 }, (error, result) => {
      assert.strictEqual(error, connectError)
      assert.strictEqual(result, null)
      resolve()
    })
  })

  assert.ok(socket instanceof net.Socket)
  socket.destroy()
})

// Regression test for the removed HTTP/2 support.
//
// This build only speaks HTTP/1.1. If the connector were to advertise `h2` in
// the TLS ALPN list, an h2-capable server would negotiate h2 and its binary
// frames would be fed to the HTTP/1.1 llhttp parser, surfacing as a cryptic
// `HTTPParserError` ("Expected HTTP/") instead of a working connection. So the
// connector must ALWAYS advertise exactly `['http/1.1']`, even when `allowH2`
// is (incorrectly) threaded through to it — e.g. nested inside `connect`.
test('buildConnector never advertises h2 over ALPN', (t) => {
  const alpnSeen = []
  const orig = tls.connect
  tls.connect = (opts) => {
    alpnSeen.push(opts.ALPNProtocols)
    // Abort before buildConnector attaches listeners / arms timers, so no
    // real socket is created and nothing leaks.
    throw new Error('stop')
  }
  t.after(() => { tls.connect = orig })

  for (const allowH2 of [undefined, false, true]) {
    const connect = buildConnector({ allowH2 })
    try {
      connect(
        { hostname: 'localhost', host: 'localhost', protocol: 'https:', port: 443, servername: 'localhost' },
        () => {}
      )
    } catch {
      // expected — the tls.connect stub throws after recording ALPN.
    }
  }

  assert.deepStrictEqual(alpnSeen, [['http/1.1'], ['http/1.1'], ['http/1.1']])
})
