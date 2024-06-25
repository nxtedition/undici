'use strict'

const assert = require('node:assert')
const { Readable } = require('./readable')
const { InvalidArgumentError, RequestAbortedError } = require('../core/errors')
const util = require('../core/util')

class RequestHandler {
  constructor (opts, callback) {
    if (!opts || typeof opts !== 'object') {
      throw new InvalidArgumentError('invalid opts')
    }

    const { signal, method, opaque, body, highWaterMark } = opts

    try {
      if (typeof callback !== 'function') {
        throw new InvalidArgumentError('invalid callback')
      }

      if (highWaterMark && (typeof highWaterMark !== 'number' || highWaterMark < 0)) {
        throw new InvalidArgumentError('invalid highWaterMark')
      }

      if (signal && typeof signal.on !== 'function' && typeof signal.addEventListener !== 'function') {
        throw new InvalidArgumentError('signal must be an EventEmitter or EventTarget')
      }

      if (method === 'CONNECT') {
        throw new InvalidArgumentError('invalid method')
      }
    } catch (err) {
      if (util.isStream(body)) {
        util.destroy(body.on('error', util.nop), err)
      }
      throw err
    }

    this.method = method
    this.opaque = opaque || null
    this.callback = callback
    this.res = null
    this.abort = null
    this.body = body
    this.highWaterMark = highWaterMark
    this.reason = null
    this.removeAbortListener = null

    if (signal?.aborted) {
      this.reason = signal.reason ?? new RequestAbortedError()
    } else if (signal) {
      this.removeAbortListener = util.addAbortListener(signal, () => {
        this.reason = signal.reason ?? new RequestAbortedError()
        if (this.res) {
          util.destroy(this.res, this.reason)
        } else if (this.abort) {
          this.abort(this.reason)
        }
      })
    }
  }

  onConnect (abort) {
    if (this.reason) {
      abort(this.reason)
      return
    }

    assert(this.callback)

    this.abort = abort
  }

  onHeaders (statusCode, rawHeaders, resume, statusMessage, headers = util.parseHeaders(rawHeaders)) {
    const { callback, abort, highWaterMark } = this

    if (statusCode < 200) {
      return
    }

    const contentType = headers['content-type']
    const contentLength = headers['content-length']
    const res = new Readable({
      method: this.method,
      statusCode,
      headers,
      resume,
      abort,
      contentType,
      contentLength: this.method !== 'HEAD' && contentLength
        ? Number(contentLength)
        : null,
      highWaterMark
    })

    if (this.removeAbortListener) {
      res.on('close', this.removeAbortListener)
      this.removeAbortListener = null
    }

    this.callback = null
    this.res = res
    if (callback !== null) {
      callback(null, res)
    }
  }

  onData (chunk) {
    return this.res.push(chunk)
  }

  onComplete () {
    this.res.push(null)
  }

  onError (err) {
    const { res, callback, body, opaque } = this

    if (callback) {
      // TODO: Does this need queueMicrotask?
      this.callback = null
      queueMicrotask(() => {
        callback(err, { opaque })
      })
    }

    if (res) {
      this.res = null
      // Ensure all queued handlers are invoked before destroying res.
      queueMicrotask(() => {
        util.destroy(res, err)
      })
    }

    if (body) {
      this.body = null

      if (util.isStream(body)) {
        body.on('error', util.nop)
        util.destroy(body, err)
      }
    }

    if (this.removeAbortListener) {
      this.removeAbortListener()
      this.removeAbortListener = null
    }
  }
}

function request (opts, callback) {
  if (callback === undefined) {
    return new Promise((resolve, reject) => {
      request.call(this, opts, (err, data) => {
        return err ? reject(err) : resolve(data)
      })
    })
  }

  try {
    this.dispatch(opts, new RequestHandler(opts, callback))
  } catch (err) {
    if (typeof callback !== 'function') {
      throw err
    }
    const opaque = opts?.opaque
    queueMicrotask(() => callback(err, { opaque }))
  }
}

module.exports = request
