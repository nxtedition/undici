// Ported from https://github.com/nodejs/undici/pull/907

'use strict'

const { Readable } = require('node:stream')
const { RequestAbortedError, NotSupportedError, InvalidArgumentError, AbortError } = require('../core/errors')
const util = require('../core/util')
const { kAbortBody } = require('../core/symbols')

const kConsume = Symbol('kConsume')
const kConsumePending = Symbol('kConsumePending')
const kReading = Symbol('kReading')
const kAbort = Symbol('kAbort')
const kContentType = Symbol('kContentType')
const kContentLength = Symbol('kContentLength')
const kUsed = Symbol('kUsed')
const kBytesRead = Symbol('kBytesRead')
const kPreservedBuffer = Symbol('kPreservedBuffer')
const kAbortReason = Symbol('kAbortReason')

const noop = () => {}

class FalsyAbortError extends RequestAbortedError {
  constructor (reason) {
    super()
    Object.defineProperty(this, 'cause', {
      value: reason,
      configurable: true,
      writable: true
    })
    this[kAbortReason] = reason
  }
}

/**
 * @param {*} err
 * @returns {*}
 */
function unwrapFalsyAbortError (err) {
  return err instanceof FalsyAbortError ? err[kAbortReason] : err
}

/**
 * @param {AbortSignal} signal
 * @returns {*}
 */
function getAbortReason (signal) {
  return signal.reason !== undefined ? signal.reason : new AbortError()
}

/**
 * @class
 * @extends {Readable}
 * @see https://fetch.spec.whatwg.org/#body
 */
class BodyReadable extends Readable {
  /**
   * @param {object} opts
   * @param {(this: Readable, size: number) => void} opts.resume
   * @param {() => (void | null)} opts.abort
   * @param {string} [opts.contentType = '']
   * @param {number} [opts.contentLength]
   * @param {number} [opts.highWaterMark = 64 * 1024]
   */
  constructor ({
    resume,
    abort,
    contentType = '',
    contentLength,
    highWaterMark = 64 * 1024 // Same as nodejs fs streams.
  }) {
    super({
      autoDestroy: true,
      read: resume,
      highWaterMark
    })

    this[kAbort] = abort

    /**
     * @type {Consume | null}
     */
    this[kConsume] = null
    this[kConsumePending] = false
    this[kBytesRead] = 0
    this[kUsed] = false
    this[kContentType] = contentType
    this[kContentLength] = Number.isFinite(contentLength) ? contentLength : null

    // Is stream being consumed through Readable API?
    // This is an optimization so that we avoid checking
    // for 'data' and 'readable' listeners in the hot path
    // inside push().
    this[kReading] = false
  }

  /**
   * @param {Error|null} err
   * @param {(error:(Error|null)) => void} callback
   * @returns {void}
   */
  _destroy (err, callback) {
    // Destruction makes the body unusable, so no later body mixin can consume
    // the raw chunks saved by setEncoding(). Release that duplicate copy while
    // the decoded Readable buffer finishes its normal destruction lifecycle.
    this[kPreservedBuffer] = null

    if (!err && !this._readableState.endEmitted) {
      err = new RequestAbortedError()
    }

    if (err) {
      this[kAbort]()
    }

    // Workaround for Node "bug". If the stream is destroyed in same
    // tick as it is created, then a user who is waiting for a
    // promise (i.e micro tick) for installing an 'error' listener will
    // never get a chance and will always encounter an unhandled exception.
    if (!this[kUsed]) {
      setImmediate(callback, err)
    } else {
      callback(err)
    }
  }

  /**
   * Abort the response with the exact AbortSignal reason. Node.js streams
   * normalize falsy destroy errors to null, so keep a private truthy Error in
   * the stream state and error event. Body mixin promises unwrap the carrier.
   *
   * @param {*} reason
   * @returns {void}
   */
  [kAbortBody] (reason) {
    this.destroy(reason || new FalsyAbortError(reason))
  }

  /**
   * @param {string} event
   * @param {(...args: any[]) => void} listener
   * @returns {this}
   */
  on (event, listener) {
    if (event === 'data' || event === 'readable') {
      this[kReading] = true
      this[kUsed] = true
    }
    return super.on(event, listener)
  }

  /**
   * @param {string} event
   * @param {(...args: any[]) => void} listener
   * @returns {this}
   */
  addListener (event, listener) {
    return this.on(event, listener)
  }

  /**
   * @param {string|symbol} event
   * @param {(...args: any[]) => void} listener
   * @returns {this}
   */
  off (event, listener) {
    const ret = super.off(event, listener)
    if (event === 'data' || event === 'readable') {
      this[kReading] = (
        this.listenerCount('data') > 0 ||
        this.listenerCount('readable') > 0
      )
    }
    return ret
  }

  /**
   * @param {string|symbol} event
   * @param {(...args: any[]) => void} listener
   * @returns {this}
   */
  removeListener (event, listener) {
    return this.off(event, listener)
  }

  /**
   * @param {Buffer|null} chunk
   * @returns {boolean}
   */
  push (chunk) {
    this[kBytesRead] += chunk ? chunk.length : 0

    // setEncoding() makes Node buffer decoded strings. Keep the original
    // response bytes for a body mixin that starts after those chunks arrive;
    // otherwise consumeStart() would feed strings into the byte decoders.
    if (
      chunk !== null &&
      this[kConsume] === null &&
      this._readableState.encoding &&
      Buffer.isBuffer(chunk) &&
      (this[kConsumePending] || !util.isDisturbed(this))
    ) {
      (this[kPreservedBuffer] ??= []).push(chunk)
    }

    if (this[kConsume] && chunk !== null) {
      consumePush(this[kConsume], chunk)
      return this[kReading] ? super.push(chunk) : true
    }

    const result = super.push(chunk)
    if (
      this[kPreservedBuffer] &&
      this[kConsume] === null &&
      !this[kConsumePending] &&
      util.isDisturbed(this)
    ) {
      // In flowing mode, Node can emit a pushed chunk without read() returning
      // it. Once that happens, no body mixin can use the preserved raw bytes.
      this[kPreservedBuffer] = null
    }
    return result
  }

  /**
   * @param {number} [size]
   * @returns {*}
   */
  read (size) {
    const chunk = super.read(size)
    if (chunk !== null && this[kConsume] === null && !this[kConsumePending]) {
      // Direct Readable consumption makes body mixins unusable. Release the
      // duplicate raw chunks instead of retaining an unbounded second copy.
      this[kPreservedBuffer] = null
    }
    return chunk
  }

  /**
   * Consumes and returns the body as a string.
   *
   * @see https://fetch.spec.whatwg.org/#dom-body-text
   * @returns {Promise<string>}
   */
  text () {
    return consume(this, 'text')
  }

  /**
   * Consumes and returns the body as a JavaScript Object.
   *
   * @see https://fetch.spec.whatwg.org/#dom-body-json
   * @returns {Promise<unknown>}
   */
  json () {
    return consume(this, 'json')
  }

  /**
   * Consumes and returns the body as a Blob
   *
   * @see https://fetch.spec.whatwg.org/#dom-body-blob
   * @returns {Promise<Blob>}
   */
  blob () {
    return consume(this, 'blob')
  }

  /**
   * Consumes and returns the body as an Uint8Array.
   *
   * @see https://fetch.spec.whatwg.org/#dom-body-bytes
   * @returns {Promise<Uint8Array>}
   */
  bytes () {
    return consume(this, 'bytes')
  }

  /**
   * Consumes and returns the body as an ArrayBuffer.
   *
   * @see https://fetch.spec.whatwg.org/#dom-body-arraybuffer
   * @returns {Promise<ArrayBuffer>}
   */
  arrayBuffer () {
    return consume(this, 'arrayBuffer')
  }

  /**
   * Not implemented
   *
   * @see https://fetch.spec.whatwg.org/#dom-body-formdata
   * @throws {NotSupportedError}
   */
  async formData () {
    // TODO: Implement.
    throw new NotSupportedError()
  }

  /**
   * Returns true if the body is not null and the body has been consumed.
   * Otherwise, returns false.
   *
   * @see https://fetch.spec.whatwg.org/#dom-body-bodyused
   * @readonly
   * @returns {boolean}
   */
  get bodyUsed () {
    return util.isDisturbed(this) ||
      this[kConsumePending] ||
      this[kConsume] !== null
  }

  /**
   * Dumps the response body by reading `limit` number of bytes.
   * @param {object} opts
   * @param {number} [opts.limit = 131072] Number of bytes to read.
   * @param {AbortSignal} [opts.signal] An AbortSignal to cancel the dump.
   * @returns {Promise<null>}
   */
  async dump (opts) {
    const signal = opts?.signal

    if (signal != null && (typeof signal !== 'object' || !('aborted' in signal))) {
      throw new InvalidArgumentError('signal must be an AbortSignal')
    }

    const limit = opts?.limit && Number.isFinite(opts.limit)
      ? opts.limit
      : 128 * 1024

    if (signal?.aborted) {
      throw getAbortReason(signal)
    }

    if (this._readableState.closeEmitted) {
      return null
    }

    return await new Promise((resolve, reject) => {
      if (
        (this[kContentLength] && (this[kContentLength] > limit)) ||
        this[kBytesRead] > limit
      ) {
        this.destroy(new AbortError())
      }

      if (signal) {
        const onAbort = () => {
          this.destroy(getAbortReason(signal))
        }
        const abortListener = util.addAbortListener(signal, onAbort)
        this
          .once('close', function () {
            abortListener[Symbol.dispose]()
            if (signal.aborted) {
              reject(getAbortReason(signal))
            } else {
              resolve(null)
            }
          })
      } else {
        this.on('close', resolve)
      }

      this
        .on('error', noop)
        .on('data', () => {
          if (this[kBytesRead] > limit) {
            this.destroy()
          }
        })
        .resume()
    })
  }

  /**
   * @param {BufferEncoding} encoding
   * @returns {this}
   */
  setEncoding (encoding) {
    if (Buffer.isEncoding(encoding)) {
      // Preserve raw Buffer chunks for the consume path (body.text(),
      // body.json(), etc.) before super.setEncoding() replaces them
      // with decoded strings. Without this, the consume path would
      // lose access to the original bytes — some of which may be held
      // by the decoder for incomplete multi-byte sequences, and the
      // rest converted to strings that can't be safely concatenated
      // byte-wise.
      const state = this._readableState
      const buffer = state.buffer
      if (buffer && state.length > 0) {
        const bufferIndex = state.bufferIndex ?? 0
        const preserved = []
        const source = typeof buffer.slice === 'function'
          ? buffer.slice(bufferIndex)
          : buffer
        for (const data of source) {
          if (Buffer.isBuffer(data)) {
            preserved.push(data)
          }
        }
        if (preserved.length > 0) {
          this[kPreservedBuffer] = (this[kPreservedBuffer] || []).concat(preserved)
        }
      }

      // Delegate to Node.js Readable.setEncoding() which initializes a
      // StringDecoder and re-encodes already-buffered chunks. This properly
      // handles multi-byte sequences split at chunk boundaries for the
      // for-await / on('data') paths. Without this, Node.js uses
      // buf.toString(encoding) on each chunk, producing U+FFFD for split chars.
      super.setEncoding(encoding)
    }
    return this
  }
}

/**
 * @see https://streams.spec.whatwg.org/#readablestream-locked
 * @param {BodyReadable} bodyReadable
 * @returns {boolean}
 */
function isLocked (bodyReadable) {
  // Consume is an implicit lock.
  return bodyReadable[kConsume] !== null ||
    bodyReadable[kConsumePending]
}

/**
 * @see https://fetch.spec.whatwg.org/#body-unusable
 * @param {BodyReadable} bodyReadable
 * @returns {boolean}
 */
function isUnusable (bodyReadable) {
  return util.isDisturbed(bodyReadable) || isLocked(bodyReadable)
}

/**
 * @typedef {object} Consume
 * @property {string} type
 * @property {BodyReadable} stream
 * @property {((value?: any) => void)} resolve
 * @property {((err: Error) => void)} reject
 * @property {number} length
 * @property {Buffer[]} body
 */

/**
 * @param {BodyReadable} stream
 * @param {string} type
 * @returns {Promise<any>}
 */
function consume (stream, type) {
  return new Promise((resolve, reject) => {
    if (isUnusable(stream)) {
      const rState = stream._readableState
      if (rState.destroyed && rState.closeEmitted === false) {
        stream
          .on('error', err => {
            reject(unwrapFalsyAbortError(err))
          })
          .on('close', () => {
            reject(new TypeError('unusable'))
          })
      } else {
        const err = rState.errored
        reject(err instanceof FalsyAbortError
          ? unwrapFalsyAbortError(err)
          : err ?? new TypeError('unusable'))
      }
    } else {
      // Reserve the consume operation before deferring setup. Without this,
      // another body mixin call in the same turn can also observe the body as
      // usable and replace the first consume operation.
      stream[kConsumePending] = true
      queueMicrotask(() => {
        stream[kConsumePending] = false
        stream[kConsume] = {
          type,
          stream,
          resolve,
          reject,
          length: 0,
          body: []
        }

        stream
          .on('error', function (err) {
            consumeFinish(this[kConsume], err)
          })
          .on('close', function () {
            if (this[kConsume].body !== null) {
              consumeFinish(this[kConsume], new RequestAbortedError())
            }
          })

        consumeStart(stream[kConsume])
      })
    }
  })
}

/**
 * @param {Consume} consume
 * @returns {void}
 */
function consumeStart (consume) {
  if (consume.body === null) {
    return
  }

  const { _readableState: state } = consume.stream

  // If setEncoding() was called, state.buffer may contain decoded strings
  // (which would break Buffer.concat in chunksDecode). Use the preserved
  // raw Buffers (saved before super.setEncoding() in setEncoding()) for
  // byte-level accurate consumption. Otherwise read from state.buffer.
  const preserved = consume.stream[kPreservedBuffer]
  if (preserved && preserved.length > 0) {
    for (const chunk of preserved) {
      consumePush(consume, chunk)
    }
    consume.stream[kPreservedBuffer] = null
  } else if (state.bufferIndex) {
    const start = state.bufferIndex
    const end = state.buffer.length
    for (let n = start; n < end; n++) {
      consumePush(consume, state.buffer[n])
    }
  } else {
    for (const chunk of state.buffer) {
      consumePush(consume, chunk)
    }
  }

  if (state.endEmitted) {
    // consumeEnd() finishes the consume synchronously, and consumeFinish() nulls
    // consume.stream. An already-ended stream has no further data to drain, so
    // return here — otherwise the resume()/read() below dereference the now-null
    // consume.stream.
    consumeEnd(consume, state.encoding)
    return
  }

  consume.stream.on('end', function () {
    consumeEnd(consume, state.encoding)
  })

  consume.stream.resume()

  while (consume.stream.read() != null) {
    // Loop
  }
}

/**
 * @param {Buffer[]} chunks
 * @param {number} length
 * @param {BufferEncoding} encoding
 * @returns {string}
 */
function chunksDecode (chunks, length, encoding) {
  if (chunks.length === 0 || length === 0) {
    return ''
  }
  const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length)
  const bufferLength = buffer.length

  // Skip BOM.
  const start =
    bufferLength > 2 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
      ? 3
      : 0
  if (!encoding || encoding === 'utf8' || encoding === 'utf-8') {
    return buffer.utf8Slice(start, bufferLength)
  } else {
    return buffer.subarray(start, bufferLength).toString(encoding)
  }
}

/**
 * @param {Buffer[]} chunks
 * @param {number} length
 * @returns {Uint8Array}
 */
function chunksConcat (chunks, length) {
  if (chunks.length === 0 || length === 0) {
    return new Uint8Array(0)
  }
  if (chunks.length === 1) {
    // fast-path
    return new Uint8Array(chunks[0])
  }
  const buffer = new Uint8Array(Buffer.allocUnsafeSlow(length).buffer)

  let offset = 0
  for (let i = 0; i < chunks.length; ++i) {
    const chunk = chunks[i]
    buffer.set(chunk, offset)
    offset += chunk.length
  }

  return buffer
}

/**
 * @param {Consume} consume
 * @param {BufferEncoding} encoding
 * @returns {void}
 */
function consumeEnd (consume, encoding) {
  const { type, body, resolve, stream, length } = consume

  try {
    if (type === 'text') {
      resolve(chunksDecode(body, length, encoding))
    } else if (type === 'json') {
      resolve(JSON.parse(chunksDecode(body, length, encoding)))
    } else if (type === 'arrayBuffer') {
      resolve(chunksConcat(body, length).buffer)
    } else if (type === 'blob') {
      resolve(new Blob(body, { type: stream[kContentType] }))
    } else if (type === 'bytes') {
      resolve(chunksConcat(body, length))
    }

    consumeFinish(consume)
  } catch (err) {
    // Conversion errors happen after the response body has been read in full.
    // Reject the body mixin directly: destroying an already-completed stream
    // can turn the conversion error into RequestAbortedError and needlessly
    // invoke the transport abort hook.
    consumeFinish(consume, err)
  }
}

/**
 * @param {Consume} consume
 * @param {Buffer} chunk
 * @returns {void}
 */
function consumePush (consume, chunk) {
  if (consume.body === null) {
    return
  }

  consume.length += chunk.length
  consume.body.push(chunk)
}

/**
 * @param {Consume} consume
 * @param {Error} [err]
 * @returns {void}
 */
function consumeFinish (consume, err) {
  if (consume.body === null) {
    return
  }

  if (arguments.length > 1) {
    consume.reject(unwrapFalsyAbortError(err))
  } else {
    consume.resolve()
  }

  // Reset the consume object to allow for garbage collection.
  consume.type = null
  consume.stream = null
  consume.resolve = null
  consume.reject = null
  consume.length = 0
  consume.body = null
}

module.exports = BodyReadable
