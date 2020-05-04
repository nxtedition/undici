'use strict'

/* eslint no-prototype-builtins: "off" */

const { URL } = require('url')
const net = require('net')
const tls = require('tls')
const Q = require('fastq')
const { HTTPParser } = require('http-parser-js')
const retimer = require('retimer')
const { EventEmitter } = require('events')
const Request = require('./request')
const assert = require('assert')

const kQueue = Symbol('queue')
const kInflight = Symbol('inflight')
const kTimer = Symbol('timer')
const kTLSOpts = Symbol('TLS Options')
const kLastBody = Symbol('lastBody')
const kStream = Symbol('kStream')

function connect (client) {
  var socket = null
  var url = client.url
  // the defaults port are needed because of the URL spec
  if (url.protocol === 'https:') {
    socket = tls.connect(url.port || 443, url.hostname, client[kTLSOpts])
  } else {
    socket = net.connect(url.port || 80, url.hostname)
  }

  client.socket = socket

  socket
    .on('connect', () => {
      client.emit('connect')
      client[kQueue].resume()
    })
    .on('data', (chunk) => {
      client.parser.execute(chunk)
    })

  client[kStream].finished(socket, (err) => {
    reconnect(client, err)
  })
}

function reconnect (client, err) {
  err = err || new Error('other side closed')

  // stop the queue and reset the parsing state
  reset(client, err)

  if (client.destroyed) {
    // reset callbacks
    const inflight = client[kInflight].splice(0)
    for (const { callback } of inflight) {
      callback(err, null)
    }
    // flush queue
    // TODO: Forward err?
    client[kQueue].resume()
    return
  }

  // reset events
  client.socket.removeAllListeners('data')
  client.socket.removeAllListeners('end')
  client.socket.removeAllListeners('finish')
  client.socket.removeAllListeners('error')
  client.socket.on('error', () => {})
  client.socket = null

  // we reset the callbacks
  const inflight = client[kInflight].splice(0)

  if (client[kQueue].length() > 0) {
    connect(client)
  }

  for (const { callback } of inflight) {
    callback(err, null)
  }

  client.emit('reconnect')
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
    this.timeout = opts.timeout || 30000 // 30 seconds

    this[kStream] = opts.stream || require('readable-stream')
    this[kTLSOpts] = opts.tls || opts.https
    this[kInflight] = []

    const endRequest = () => {
      this.socket.write('\r\n', 'ascii')
      this.socket.uncork()
    }

    const timerCb = () => {
      if (this[kInflight].length > 0) {
        this.socket.destroy(new Error('timeout'))
        this[kTimer] = null
      }
    }

    this[kQueue] = Q((request, cb) => {
      if (this.destroyed) {
        return cb(new Error('The client is destroyed'))
      }

      // TODO: Pause and requeue task when:
      // - this.socket.destroyed
      // - this[kLastBody] && this[kLastBody].destroyed
      // - this[kLastBody] && this[kInflight].length && !request.idempotent

      if (this[kTimer]) {
        this[kTimer].reschedule(this.timeout)
      } else {
        this[kTimer] = retimer(timerCb, this.timeout)
      }

      // wrap the callback in a AsyncResource
      const callback = request.wrap(cb)
      this[kInflight].push({ request, callback })

      const { method, path, body } = request
      const headers = request.headers || {}
      this.socket.cork()
      this.socket.write(`${method} ${path} HTTP/1.1\r\nConnection: keep-alive\r\n`, 'ascii')

      if (!(headers.host || headers.Host)) {
        this.socket.write('Host: ' + url.hostname + '\r\n', 'ascii')
      }
      const headerNames = Object.keys(headers)
      for (let i = 0; i < headerNames.length; i++) {
        const name = headerNames[i]
        this.socket.write(name + ': ' + headers[name] + '\r\n', 'ascii')
      }

      const chunked = !headers.hasOwnProperty('content-length')

      if (typeof body === 'string' || body instanceof Uint8Array) {
        if (chunked) {
          this.socket.write(`content-length: ${Buffer.byteLength(body)}\r\n\r\n`, 'ascii')
        } else {
          this.socket.write('\r\n')
        }
        this.socket.write(body)
        endRequest()
      } else if (body && typeof body.pipe === 'function') {
        const cleanup = this[kStream].finished(this.socket, (err) => {
          if (err) {
            body.destroy(err)
          }
        })

        if (chunked) {
          this.socket.write('transfer-encoding: chunked\r\n', 'ascii')
        } else {
          this.socket.write('\r\n', 'ascii')
        }

        // TODO we should pause the queue while we are piping
        const onData = (chunk) => {
          if (chunked) {
            this.socket.write('\r\n' + Buffer.byteLength(chunk).toString(16) + '\r\n')
          }
          if (!this.socket.write(chunk)) {
            body.pause()
          }
        }
        const onDrain = () => {
          body.resume()
        }

        body.on('data', onData)
        this.socket.on('drain', onDrain)

        this.socket.uncork()
        this[kStream].finished(body, (err) => {
          cleanup()
          if (err) {
            // TODO we might want to wait before previous in-flight
            // requests are finished before destroying
            if (this.socket) {
              destroySocket(this, err, callback)
            } else {
              callback(err, null)
            }
            return
          }

          assert(this.socket)

          this.socket.removeListener('drain', onDrain)

          if (chunked) {
            this.socket.cork()
            this.socket.write('\r\n0\r\n', 'ascii')
          }

          endRequest()
        })
      } else {
        assert(!body)
        endRequest()
      }
    })

    this.pipelining = opts.pipelining || 1

    this[kQueue].drain = () => {
      if (!this.closed) {
        this.emit('drain')
      }
    }

    reset(this)
  }

  get pipelining () {
    return this[kQueue].concurrency
  }

  set pipelining (v) {
    this[kQueue].concurrency = v
  }

  get full () {
    // TODO q.length is slowish, optimize
    return this[kQueue].length() > this.pipelining
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
      const req = new Request(opts)
      this[kQueue].push(req, cb)
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

    if (!cb) {
      return
    }

    if (this.socket) {
      this[kStream].finished(this.socket, (err) => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          cb(err)
        } else {
          cb(null)
        }
      })
    } else {
      assert(this.destroyed)
      process.nextTick(cb, null)
    }
  }

  destroy (err) {
    if (this.destroyed) {
      return
    }
    this.closed = true
    this.destroyed = true

    if (this[kTimer]) {
      this[kTimer].clear()
      this[kTimer] = null
    }

    if (this.socket) {
      this.socket.destroy(err)
      // TODO: Wait until socket is actually destroyed
      // before setting it to null so that close(cb) will not
      // invoke callback before socket is desroyed.
      this.socket = null
    }
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

function reset (client, err) {
  client[kQueue].pause()
  if (client[kLastBody]) {
    client[kLastBody].destroy(err)
  }
  client[kLastBody] = null

  client.parser = new HTTPParser(HTTPParser.RESPONSE)
  client.parser[HTTPParser.kOnHeaders] = () => {}
  client.parser[HTTPParser.kOnHeadersComplete] = ({ statusCode, headers }) => {
    // TODO move client[kInflight] from being an array. The array allocation
    // is showing up in the flamegraph.
    const { request, callback } = client[kInflight].shift()
    const skipBody = request.method === 'HEAD'

    if (!skipBody) {
      client[kLastBody] = new client[kStream].Readable({
        read () {
          if (client.socket) {
            client.socket.resume()
          }
        }
      })
      client[kLastBody].push = request.wrapSimple(client[kLastBody], client[kLastBody].push)
    }
    callback(null, {
      statusCode,
      headers: parseHeaders(headers),
      body: client[kLastBody]
    })
    if (client.closed) {
      destroyMaybe(client)
    }
    return skipBody
  }

  client.parser[HTTPParser.kOnBody] = (chunk, offset, length) => {
    const body = client[kLastBody]
    if (body.destroyed) {
      // TODO: Add test and limit how much is read while response
      // body is destroyed.
      return
    }

    if (!body.push(chunk.slice(offset, offset + length))) {
      if (client.socket) {
        client.socket.pause()
      }
    }
  }

  client.parser[HTTPParser.kOnMessageComplete] = () => {
    const body = client[kLastBody]
    client[kLastBody] = null
    if (body !== null) {
      body.push(null)
    }
    if (client.closed) {
      destroyMaybe(client)
    }
  }
}

function destroyMaybe (client) {
  if (
    !client[kLastBody] &&
    client[kQueue].length() === 0 &&
    client[kInflight].length === 0
  ) {
    client.destroy()
  }
}

function destroySocket (client, err, cb) {
  // This code is basically the same as...
  // stream.finished(socket, er => cb(err || er))
  // socket.destroy(err)
  // ... in Node 14+
  const socket = client.socket
  const wState = socket._writableState
  const rState = socket._readableState
  const closed = (wState && wState.closed) || (rState && rState.closed)
  let called = false
  const callback = (er) => {
    if (called) {
      return
    }
    called = true
    cb(err || er, null)
  }
  if (closed === true) {
    socket.on('error', callback)
    process.nextTick(callback)
  } else if (closed === false || !socket.destroyed) {
    client[kStream].finished(socket, callback)
  } else {
    socket.on('error', callback)
    setImmediate(callback)
  }
  socket.destroy(err)
}
