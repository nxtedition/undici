'use strict'

/* eslint no-prototype-builtins: "off" */

const { URL } = require('url')
const net = require('net')
const tls = require('tls')
const { HTTPParser } = require('http-parser-js')
const { EventEmitter } = require('events')
const Request = require('./request')
const assert = require('assert')

const kQueue = Symbol('queue')
const kInflight = Symbol('inflight')
const kTLSOpts = Symbol('TLS Options')
const kLastBody = Symbol('lastBody')
const kStream = Symbol('stream')
const kClosed = Symbol('closed')
const kRunning = Symbol('running')
const kRetryDelay = Symbol('retry delay')
const kRetryTimeout = Symbol('retty timeout')

function nop () {}

function _connect (client) {
  var socket = null
  var url = client.url
  // the defaults port are needed because of the URL spec
  if (url.protocol === 'https:') {
    socket = tls.connect(url.port || 443, url.hostname, client[kTLSOpts])
  } else {
    socket = net.connect(url.port || 80, url.hostname)
  }

  const parser = client._parser = new HTTPParser(HTTPParser.RESPONSE)

  client.socket = socket

  socket[kClosed] = false
  socket.setTimeout(client.timeout, function () {
    this.destroy(new Error('timeout'))
  })
  socket
    .on('connect', () => {
      client[kRetryDelay] = 0
      client[kRetryTimeout] = null
      client.emit('connect')
      resume(client)
    })
    .on('data', function (chunk) {
      const err = parser.execute(chunk)
      if (err instanceof Error) {
        this.destroy(err)
      }
    })
    .on('close', () => {
      socket[kClosed] = true
    })

  client[kLastBody] = null

  let body = null

  parser[HTTPParser.kOnHeaders] = () => {}
  parser[HTTPParser.kOnHeadersComplete] = ({ statusCode, headers }) => {
    // TODO move client[kInflight] from being an array. The array allocation
    // is showing up in the flamegraph.
    const { request, callback } = client[kInflight].shift()
    const skipBody = request.method === 'HEAD'

    if (!skipBody) {
      body = client[kLastBody] = new client[kStream].Readable({
        autoDestroy: true,
        read () {
          socket.resume()
        },
        destroy (err, cb) {
          if (client[kLastBody] === this) {
            socket.resume()
            client[kLastBody] = null
          }

          if (!err && !this._readableState.endEmitted) {
            err = new Error('aborted')
          }

          cb(err, null)
        }
      })
      body.push = request.wrapSimple(body, body.push)
    }

    callback(null, {
      statusCode,
      headers: parseHeaders(headers),
      body
    })

    resume(client)
    drainMaybe(client)
    destroyMaybe(client)

    return skipBody
  }

  parser[HTTPParser.kOnBody] = (chunk, offset, length) => {
    if (body.destroyed) {
      // TODO: Add test and limit how much is read while response
      // body is destroyed.
      return
    }

    if (!body.push(chunk.slice(offset, offset + length))) {
      socket.pause()
    }
  }

  parser[HTTPParser.kOnMessageComplete] = () => {
    if (body) {
      body.push(null)
      body = null

      // TODO: Remove this and force consumer to fully consume body.
      client[kLastBody] = null

      resume(client)
    }
    destroyMaybe(client)
  }

  client[kStream].finished(socket, (err) => {
    err = err || new Error('other side closed')

    if (body) {
      body.destroy(err)
      body = null

      // TODO: Remove this and force consumer to fully consume body.
      client[kLastBody] = null
    }

    client._parser = null

    for (const { callback } of client[kInflight].splice(0)) {
      callback(err, null)
    }

    if (client.destroyed) {
      for (const { callback } of client[kQueue].splice(0)) {
        callback(new Error('The client is destroyed'), null)
      }
      return
    }

    // reset events
    client.socket.removeAllListeners('data')
    client.socket.removeAllListeners('end')
    client.socket.removeAllListeners('finish')
    client.socket.removeAllListeners('error')
    client.socket.on('error', nop)
    client.socket = null

    if (client[kQueue].length > 0) {
      connect(client)
    }

    client.emit('reconnect')
  })
}

function connect (client) {
  if (client[kRetryDelay]) {
    client[kRetryDelay] = Math.min(client[kRetryDelay], client.timeout)
    client[kRetryTimeout] = setTimeout(() => {
      _connect(client)
    }, client[kRetryDelay])
    client[kRetryDelay] *= 2
  } else {
    _connect(client)
    client[kRetryDelay] = 1e3
  }
}

class Client extends EventEmitter {
  constructor (url, opts = {}) {
    super()

    if (!(url instanceof URL)) {
      url = new URL(url)
    }

    if (!/https?/.test(url.protocol)) {
      throw new Error('invalid url')
    }

    if (/\/.+/.test(url.pathname) || url.search || url.hash) {
      throw new Error('invalid url')
    }

    this.url = url
    this.closed = false
    this.destroyed = false
    this.timeout = opts.timeout || 30e3
    this.pipelining = opts.pipelining || 1

    this[kStream] = opts.stream || require('readable-stream')
    this[kTLSOpts] = opts.tls || opts.https
    this[kInflight] = []
    this[kRetryDelay] = 0
    this[kRetryTimeout] = null
    this[kQueue] = []
  }

  get size () {
    return this[kQueue].length + this[kInflight].length
  }

  get full () {
    return this.size > this.pipelining
  }

  request (opts, cb) {
    if (cb === undefined) {
      return new Promise((resolve, reject) => {
        this.request(opts, (err, data) => {
          return err ? reject(err) : resolve(data)
        })
      })
    }

    if (this.closed) {
      process.nextTick(cb, new Error('The client is closed'))
      return false
    }

    if (!this.socket) {
      connect(this)
    }

    try {
      const request = new Request(opts)
      this[kQueue].push({
        request,
        callback: request.wrap(cb)
      })
      resume(this)
    } catch (err) {
      process.nextTick(cb, err, null)
    }

    return !this.full
  }

  close (cb) {
    if (cb === undefined) {
      return new Promise((resolve, reject) => {
        this.close((err, data) => {
          return err ? reject(err) : resolve(data)
        })
      })
    }

    this.closed = true

    destroyMaybe(this)

    if (this.socket) {
      finishedSocket(this.socket, cb)
    } else {
      process.nextTick(cb, null)
    }
  }

  destroy (err, cb) {
    if (typeof err === 'function') {
      cb = err
      err = null
    }

    if (cb === undefined) {
      return new Promise((resolve, reject) => {
        this.destroy(err, (err, data) => {
          return err ? reject(err) : resolve(data)
        })
      })
    }

    if (this.destroyed) {
      process.nextTick(cb, null)
      return
    }

    this.closed = true
    this.destroyed = true

    clearTimeout(this[kRetryTimeout])
    this[kRetryTimeout] = null

    if (this.socket) {
      finishedSocket(this.socket, cb)
      this.socket.destroy(err)
    } else {
      for (const { callback } of this[kQueue].splice(0)) {
        process.nextTick(callback, new Error('The client is destroyed'), null)
      }
      process.nextTick(cb, err)
    }
  }
}

function resume (client) {
  if (
    client[kQueue].length === 0 ||
    client[kInflight].length >= client.pipelining ||
    (client[kLastBody] && client[kLastBody].destroyed) ||
    client.socket.destroyed ||
    client[kRunning]
  ) {
    return
  }

  startRequest(client, client[kQueue].shift())
  drainMaybe(client)
}

function endRequest (client, err) {
  client.socket.write('\r\n', 'ascii')
  client.socket.uncork()
  client[kRunning] = false
  resume(client)
}

function startRequest (client, { request, callback }) {
  client[kRunning] = true

  // TODO: Pause and requeue task when:
  // - client[kLastBody] && client[kInflight].length && !request.idempotent

  // wrap the callback in a AsyncResource
  client[kInflight].push({ request, callback })

  const { method, path, body } = request
  const headers = request.headers || {}
  client.socket.cork()
  client.socket.write(`${method} ${path} HTTP/1.1\r\nConnection: keep-alive\r\n`, 'ascii')

  if (!(headers.host || headers.Host)) {
    client.socket.write('Host: ' + client.url.hostname + '\r\n', 'ascii')
  }
  const headerNames = Object.keys(headers)
  for (let i = 0; i < headerNames.length; i++) {
    const name = headerNames[i]
    client.socket.write(name + ': ' + headers[name] + '\r\n', 'ascii')
  }

  const chunked = !headers.hasOwnProperty('content-length')

  if (typeof body === 'string' || body instanceof Uint8Array) {
    if (chunked) {
      client.socket.write(`content-length: ${Buffer.byteLength(body)}\r\n\r\n`, 'ascii')
    } else {
      client.socket.write('\r\n')
    }
    client.socket.write(body)
    endRequest(client)
  } else if (body && typeof body.pipe === 'function') {
    if (chunked) {
      client.socket.write('transfer-encoding: chunked\r\n', 'ascii')
    } else {
      client.socket.write('\r\n', 'ascii')
    }

    // TODO: Pause the queue while piping.

    let finished = false

    const socket = client.socket

    const onData = (chunk) => {
      if (chunked) {
        socket.write('\r\n' + Buffer.byteLength(chunk).toString(16) + '\r\n')
      }
      if (!socket.write(chunk)) {
        body.pause()
      }
    }
    const onDrain = () => {
      body.resume()
    }
    const onFinished = (err) => {
      if (finished) {
        return
      }
      finished = true

      freeSocketFinished()
      freeBodyFinished()

      socket
        .removeListener('drain', onDrain)
      body
        .removeListener('data', onData)
        .removeListener('end', onFinished)

      if (err) {
        if (typeof body.destroy === 'function') {
          body.destroy(err)
        }

        // TODO we might want to wait before previous in-flight
        // requests are finished before destroying
        if (socket) {
          finishedSocket(socket, callback)
          socket.destroy(err)
        } else {
          callback(err, null)
        }

        client[kRunning] = false
        resume(client)
      } else {
        if (chunked) {
          socket.cork()
          socket.write('\r\n0\r\n', 'ascii')
        }
        endRequest(client)
      }
    }

    body
      .on('data', onData)
      .on('end', onFinished)
      .on('error', nop)

    socket
      .on('drain', onDrain)
      .uncork()

    const freeSocketFinished = client[kStream].finished(socket, onFinished)
    const freeBodyFinished = client[kStream].finished(body, onFinished)
  } else {
    assert(!body)
    endRequest(client)
  }
}

function parseHeaders (headers) {
  const obj = {}
  for (var i = 0; i < headers.length; i += 2) {
    var key = headers[i]
    var val = obj[key]
    if (!val) {
      obj[key] = headers[i + 1]
    } else {
      if (!Array.isArray(val)) {
        val = [val]
        obj[key] = val
      }
      val.push(headers[i + 1])
    }
  }
  return obj
}

module.exports = Client

function drainMaybe (client) {
  if (
    !client.closed &&
    client[kQueue].length === 0 &&
    client[kInflight].length === 0
  ) {
    client.emit('drain')
  }
}

function destroyMaybe (client) {
  if (
    client.closed &&
    client[kQueue].length === 0 &&
    client[kInflight].length === 0 &&
    !client[kLastBody]
  ) {
    client.destroy()
  }
}

function finishedSocket (socket, cb) {
  if (socket[kClosed]) {
    process.nextTick(cb, null)
  } else {
    let err = null
    socket
      .on('error', (er) => {
        err = er
      })
      .on('close', () => {
        cb(err, null)
      })
  }
}
