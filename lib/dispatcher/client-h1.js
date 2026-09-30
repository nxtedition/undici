'use strict'

const assert = require('node:assert')
const util = require('../core/util.js')
const timers = require('../util/timers.js')
const { wellknownHeaderNames, headerNameLowerCasedRecord } = require('../core/constants.js')
const {
  RequestContentLengthMismatchError,
  ResponseContentLengthMismatchError,
  RequestAbortedError,
  HeadersTimeoutError,
  HeadersOverflowError,
  SocketError,
  InformationalError,
  BodyTimeoutError,
  HTTPParserError,
  ResponseExceededMaxSizeError,
  InvalidArgumentError
} = require('../core/errors.js')
const {
  kUrl,
  kReset,
  kClient,
  kParser,
  kBlocking,
  kRunning,
  kPending,
  kSize,
  kWriting,
  kQueue,
  kNoRef,
  kKeepAliveDefaultTimeout,
  kHostHeader,
  kPendingIdx,
  kRunningIdx,
  kError,
  kPipelining,
  kSocket,
  kKeepAliveTimeoutValue,
  kMaxHeadersSize,
  kKeepAliveMaxTimeout,
  kKeepAliveTimeoutThreshold,
  kHeadersTimeout,
  kBodyTimeout,
  kStrictContentLength,
  kMaxRequests,
  kCounter,
  kMaxResponseSize,
  kOnError,
  kResume,
  kTOS,
  kHTTPContext,
  kClosed
} = require('../core/symbols.js')

// The SIMD build of milo is not used. Its wasm32 field scanners pass the
// operands of v128_andnot in x86 order, so a 16-byte block of a header value,
// trailer value or reason phrase is only checked for control bytes when it
// also holds a CR: a bare LF or a NUL inside a long header value is accepted.
// The scalar build rejects them.
const milo = require('../milo/src/no-simd/index.js').setup()

const {
  EVENT_END,
  EVENT_MESSAGE_START,
  EVENT_MESSAGE_COMPLETE,
  EVENT_HEADER_NAME,
  EVENT_HEADER_VALUE,
  EVENT_HEADERS,
  EVENT_DATA,
  EVENT_TRAILER_NAME,
  EVENT_TRAILER_VALUE,
  STATE_START,
  STATE_BODY_VIA_CONTENT_LENGTH,
  ERROR_NONE,
  ERROR_CALLBACK_ERROR,
  ERROR_INVALID_STATUS,
  ERROR_UNEXPECTED_EOF
} = milo
const PARSER_FIELD_EVENTS = milo.ParserFields.EVENTS
const PARSER_FIELD_STATE = milo.ParserFields.STATE
const PARSER_FIELD_ERROR_CODE = milo.ParserFields.ERROR_CODE
const ACTIVE_EVENTS =
  milo.EVENT_ACTIVE_ON_MESSAGE_START |
  milo.EVENT_ACTIVE_ON_MESSAGE_COMPLETE |
  milo.EVENT_ACTIVE_ON_HEADER_NAME |
  milo.EVENT_ACTIVE_ON_HEADER_VALUE |
  milo.EVENT_ACTIVE_ON_HEADERS |
  milo.EVENT_ACTIVE_ON_DATA |
  milo.EVENT_ACTIVE_ON_TRAILER_NAME |
  milo.EVENT_ACTIVE_ON_TRAILER_VALUE
// Most events are a u8 type, a u32 offset and a u32 length. EVENT_HEADERS
// carries the response metadata instead.
const EVENT_RANGE_SIZE = 9
const EVENT_HEADERS_SIZE = 19
// EVENT_HEADERS body kinds; the third one is a body delimited by EOF.
const BODY_KIND_CONTENT_LENGTH = 0
const BODY_KIND_EOF = 2
// milo's line length limits are disabled (usize is 32 bits in WASM); the
// header size check in JS covers a line that is still incomplete as well, so
// an oversized field section fails with HeadersOverflowError.
const MAX_LINE_LENGTH = 0xffffffff
const CR = 0x0d
const LF = 0x0a

const EMPTY_BUF = Buffer.alloc(0)
const FastBuffer = Buffer[Symbol.species]
const removeAllListeners = util.removeAllListeners
const kIdleSocketValidation = Symbol('kIdleSocketValidation')
const kIdleSocketValidationTimeout = Symbol('kIdleSocketValidationTimeout')
const kSocketUsed = Symbol('kSocketUsed')

// Views of the WASM memory. Growing the memory (a new parser, a larger input
// area, an error description) detaches them, which leaves them empty.
let heap = new Uint8Array(milo.memory.buffer)
// The area parsers copy their input to. It is shared, as only one parser runs
// at a time.
let inputPtr = 0
let inputSize = 0
let input = null

/**
 * @returns {Uint8Array}
 */
function getHeap () {
  if (heap.length === 0) {
    heap = new Uint8Array(milo.memory.buffer)
  }
  return heap
}

/**
 * @param {number} size
 * @returns {Buffer} a view of the input area, at least `size` bytes long
 */
function getInput (size) {
  if (size > inputSize) {
    // milo's JS dealloc() drops the length the WASM export needs to free a
    // block, so an outgrown area is left behind; doubling bounds what is left
    // to the size of the current one.
    inputSize = Math.max(Math.ceil(size / 4096) * 4096, inputSize * 2)
    inputPtr = milo.alloc(inputSize)
    input = null
  }

  if (input === null || input.length === 0) {
    input = new FastBuffer(milo.memory.buffer, inputPtr, inputSize)
    heap = new Uint8Array(milo.memory.buffer)
  }

  return input
}

// The lowercased well-known field names by length and first character.
const WELLKNOWN_HEADER_NAMES = []
for (const name of wellknownHeaderNames) {
  const lower = headerNameLowerCasedRecord[name]
  const key = lower.length * 128 + lower.charCodeAt(0)
  ;(WELLKNOWN_HEADER_NAMES[key] ??= []).push(lower)
}

/**
 * @param {Buffer} data
 * @param {number} start
 * @param {number} end
 * @returns {string} the lowercased field name in `data` from `start` to `end`
 */
function lookupHeaderName (data, start, end) {
  // A well-known name is matched in the read itself and reuses a
  // preallocated lowercase string, which also keys the header map with an
  // internalized string. milo only passes on token characters, all ASCII.
  let first = data[start]
  if (first >= 0x41 && first <= 0x5a) {
    first |= 0x20
  }

  const candidates = WELLKNOWN_HEADER_NAMES[(end - start) * 128 + first]
  if (candidates !== undefined) {
    for (let i = 0; i < candidates.length; i++) {
      if (equalsHeaderName(data, start, candidates[i])) {
        return candidates[i]
      }
    }
  }

  return data.latin1Slice(start, end).toLowerCase()
}

/**
 * @param {Buffer} data
 * @param {number} start
 * @param {string} name a lowercase field name
 * @returns {boolean} whether the bytes of `data` from `start` spell `name`,
 * ignoring ASCII case
 */
function equalsHeaderName (data, start, name) {
  for (let i = 0; i < name.length; i++) {
    let code = data[start + i]
    if (code >= 0x41 && code <= 0x5a) {
      code |= 0x20
    }
    if (code !== name.charCodeAt(i)) {
      return false
    }
  }
  return true
}

/**
 * @param {Buffer} data
 * @param {number} start where milo says a field value starts
 * @param {number} end
 * @returns {number} where the value starts past any leading whitespace
 */
function skipLeadingWhitespace (data, start, end) {
  // For a value that does not end in whitespace, milo 0.8.0 only drops one
  // leading SP, so a value sent after ":  " or ": \t" would keep the rest.
  while (start < end && (data[start] === 0x20 || data[start] === 0x09)) {
    start++
  }
  return start
}

/**
 * @param {Uint8Array} heap
 * @param {number} index
 * @returns {number}
 */
function readUInt32 (heap, index) {
  return (heap[index] | (heap[index + 1] << 8) | (heap[index + 2] << 16) | (heap[index + 3] << 24)) >>> 0
}

// milo parsers that no connection holds, all between two messages. A parser
// has a 64 KiB event buffer in WASM memory, so a connection holds one only
// while it parses a response, not for as long as it stays open.
const idleParsers = []

/**
 * @returns {number} a milo parser at the start of a message
 */
function acquireParser () {
  let ptr = idleParsers.pop()

  if (ptr === undefined) {
    ptr = milo.create()
    milo.setShouldAutodetect(ptr, false)
    milo.setIsRequest(ptr, false)
    // Stop after the field section, so how a response is framed (HEAD,
    // CONNECT, upgrade) is settled before its body is parsed.
    milo.setShouldSuspendAfterHeaders(ptr, true)
    milo.setMaxStartLineLength(ptr, MAX_LINE_LENGTH)
    milo.setMaxHeaderLength(ptr, MAX_LINE_LENGTH)
    milo.setActiveEvents(ptr, ACTIVE_EVENTS)
  }

  return ptr
}

/**
 * @type {Parser|null}
 */
let currentParser = null

const USE_NATIVE_TIMER = 0
const USE_FAST_TIMER = 1

// Use fast timers for headers and body to take eventual event loop
// latency into account.
const TIMEOUT_HEADERS = 2 | USE_FAST_TIMER
const TIMEOUT_BODY = 4 | USE_FAST_TIMER

// Use native timers to ignore event loop latency for keep-alive
// handling.
const TIMEOUT_KEEP_ALIVE = 8 | USE_NATIVE_TIMER

class Parser {
  /**
     * @param {import('./client.js')} client
     * @param {import('net').Socket} socket
     */
  constructor (client, socket) {
    // The milo parser held while a response is parsed, 0 between responses.
    this.ptr = 0
    // Its event buffer, which each call into milo rewrites.
    this.events = 0
    this.destroyed = false
    this.client = client
    /**
     * @type {import('net').Socket}
     */
    this.socket = socket
    // The active timer is one of two per-connection slots. A request cycles
    // headers (fast) -> body (fast) -> keep-alive (native) -> headers ..., so
    // each slot is kept and re-armed with refresh() rather than reallocated.
    this.timeout = null
    this.timeoutWeakRef = new WeakRef(this)
    this.timeoutType = null
    this.fastTimeout = null
    this.fastTimeoutValue = null
    this.nativeTimeout = null
    this.nativeTimeoutValue = null
    this.statusCode = 0
    this.upgrade = false
    this.headers = {}
    this.headerName = ''
    this.headersSize = 0
    this.headersMaxSize = client[kMaxHeadersSize]
    // A server sends the same field names in the same order on every
    // response of a connection, so the lowercased names of the last field
    // section are kept by position and tried first.
    this.fieldNames = []
    this.fieldIndex = 0
    this.shouldKeepAlive = false
    this.paused = false
    this.resume = this.resume.bind(this)

    this.bytesRead = 0

    this.keepAlive = ''
    this.contentLength = -1
    this.maxResponseSize = client[kMaxResponseSize]

    // The end of the last read when milo stopped in a line it cut short. milo
    // parses a line only once it is complete, so the next read is appended.
    this.pending = null
    // Content-Length body bytes still to come. They need no parsing, so they
    // are handed on straight from the socket chunk and never copied to WASM.
    this.bodyRemaining = 0

    // A server repeats the same Keep-Alive value on every response of a
    // connection, so remember the last one parsed.
    this.lastKeepAlive = ''
    this.lastKeepAliveTimeout = null
  }

  /**
   * @param {string} value
   * @returns {number | null}
   */
  parseKeepAliveTimeout (value) {
    if (value !== this.lastKeepAlive) {
      this.lastKeepAlive = value
      this.lastKeepAliveTimeout = util.parseKeepAliveTimeout(value)
    }
    return this.lastKeepAliveTimeout
  }

  setTimeout (delay, type) {
    if (type & USE_FAST_TIMER) {
      // A parked keep-alive timer may still be armed. It is left alone because
      // clearing a native timer rules out refresh() later; onParserKeepAliveTimeout
      // ignores it once the parser has moved on.
      if (delay !== this.fastTimeoutValue) {
        if (this.fastTimeout != null) {
          timers.clearFastTimeout(this.fastTimeout)
        }
        this.fastTimeout = delay
          ? timers.setFastTimeout(onParserTimeout, delay, this.timeoutWeakRef)
          : null
        this.fastTimeoutValue = delay
      } else if (this.fastTimeout != null) {
        this.fastTimeout.refresh()
      }
      this.timeout = this.fastTimeout
    } else {
      // Disarm the fast timer; unlike a native one it can be re-armed by
      // refresh() after being cleared.
      if (this.fastTimeout != null) {
        timers.clearFastTimeout(this.fastTimeout)
      }
      if (delay !== this.nativeTimeoutValue) {
        if (this.nativeTimeout != null) {
          clearTimeout(this.nativeTimeout)
        }
        this.nativeTimeout = delay
          ? setTimeout(onParserKeepAliveTimeout, delay, this.timeoutWeakRef)
          : null
        this.nativeTimeout?.unref()
        this.nativeTimeoutValue = delay
      } else if (this.nativeTimeout != null) {
        this.nativeTimeout.refresh()
      }
      this.timeout = this.nativeTimeout
    }

    this.timeoutType = type
  }

  resume () {
    if (this.socket.destroyed || !this.paused) {
      return
    }

    assert(!this.destroyed)

    assert(this.timeoutType === TIMEOUT_BODY)
    if (this.timeout != null) {
      this.timeout.refresh()
    }

    this.paused = false

    // Resumed by a handler while this parser is dispatching the events of
    // the same read, which then simply carries on.
    if (currentParser === this) {
      return
    }

    assert(currentParser === null)

    this.readMore()
  }

  readMore () {
    while (!this.paused && !this.destroyed) {
      const chunk = this.socket.read()
      if (chunk === null) {
        break
      }
      this.execute(chunk)
    }
  }

  /**
   * @param {Buffer} chunk
   */
  execute (chunk) {
    assert(currentParser === null)
    assert(!this.destroyed)
    assert(!this.paused)

    let data = chunk
    if (this.pending !== null) {
      data = Buffer.concat([this.pending, chunk])
      this.pending = null
    }

    try {
      let head
      try {
        currentParser = this
        head = this.parse(data)
      } finally {
        currentParser = null
      }

      if (head !== null) {
        this.onUpgrade(head)
      } else if (this.ptr !== 0 && getHeap()[this.ptr + PARSER_FIELD_STATE] === STATE_START) {
        // Between two responses; the next read may start a new one.
        idleParsers.push(this.ptr)
        this.ptr = 0
      }
    } catch (err) {
      util.destroy(this.socket, err)
    }
  }

  /**
   * Parses `data` and dispatches what it holds, until it is used up, a
   * handler stops parsing, the parser is paused or the connection upgraded.
   * @param {Buffer} data
   * @returns {Buffer | null} the bytes following the head of an upgrade
   * response, or null
   */
  parse (data) {
    const { socket } = this
    const length = data.length

    if (this.ptr === 0) {
      if (length === 0) {
        return null
      }
      this.ptr = acquireParser()
      this.events = readUInt32(getHeap(), this.ptr + PARSER_FIELD_EVENTS)
    }

    const { ptr } = this

    let offset = 0
    // Where in `data` the copy in the input area starts, -1 before it is made.
    // A read is copied once; later calls into milo start further into it.
    let copied = -1

    while (true) {
      if (this.bodyRemaining > 0) {
        if (offset === length) {
          return null
        }

        const len = Math.min(this.bodyRemaining, length - offset)
        this.bodyRemaining -= len
        const ret = this.onBody(len === length ? data : new FastBuffer(data.buffer, data.byteOffset + offset, len))
        offset += len

        if (ret === -1) {
          return null
        }

        if (this.bodyRemaining === 0) {
          milo.complete(ptr)
          if (!this.dispatch(data, offset, offset)) {
            return null
          }
        }
      } else {
        if (offset === length) {
          return null
        }

        const first = data[offset]
        if ((first === CR || first === LF) && getHeap()[ptr + PARSER_FIELD_STATE] === STATE_START) {
          // Like llhttp, skip empty lines ahead of a status line (RFC 9112
          // 2.2) instead of taking them for the start of a response.
          do {
            offset++
          } while (offset < length && (data[offset] === CR || data[offset] === LF))
          continue
        }

        if (copied === -1) {
          getInput(length - offset).set(offset === 0 ? data : data.subarray(offset))
          copied = offset
        }

        const start = offset
        const consumed = milo.parse(ptr, inputPtr + offset - copied, length - offset)
        offset += consumed

        if (!this.dispatch(data, start, offset)) {
          return null
        }

        if (this.upgrade) {
          return data.subarray(offset)
        }

        if (consumed === 0 && offset < length) {
          // milo stopped in a line that the read cut short.
          const pending = data.subarray(offset)
          if (this.headersSize + pending.length >= this.headersMaxSize) {
            throw new HeadersOverflowError()
          }
          this.pending = pending
          return null
        }
      }

      if (this.paused) {
        if (offset < length) {
          socket.unshift(data.subarray(offset))
        }
        return null
      }
    }
  }

  /**
   * Dispatches the events of milo's last call, and throws if milo or a
   * handler failed.
   * @param {Buffer} data
   * @param {number} base where in `data` the input of that call started
   * @param {number} offset where in `data` that call stopped
   * @returns {boolean} false if a handler stopped parsing
   */
  dispatch (data, base, offset) {
    const ret = this.drain(data, base)

    if (getHeap()[this.ptr + PARSER_FIELD_ERROR_CODE] !== 0) {
      throw this.createError(data.subarray(offset))
    }

    return ret !== -1
  }

  /**
   * Hands the events milo wrote in its last call to their handlers.
   * @param {Buffer} data
   * @param {number} base where in `data` the input of that call started
   * @returns {0|-1} -1 if a handler stopped parsing
   */
  drain (data, base) {
    let heap = getHeap()
    let cursor = this.events

    while (true) {
      const type = heap[cursor]

      if (type === EVENT_DATA) {
        const start = base + readUInt32(heap, cursor + 1)
        const len = readUInt32(heap, cursor + 5)
        if (this.onBody(new FastBuffer(data.buffer, data.byteOffset + start, len)) === -1) {
          return -1
        }
        cursor += EVENT_RANGE_SIZE
      } else if (type === EVENT_HEADER_NAME) {
        const start = base + readUInt32(heap, cursor + 1)
        if (this.onHeaderName(data, start, start + readUInt32(heap, cursor + 5)) === -1) {
          return -1
        }
        cursor += EVENT_RANGE_SIZE
      } else if (type === EVENT_HEADER_VALUE) {
        const start = base + readUInt32(heap, cursor + 1)
        if (this.onHeaderValue(data, start, start + readUInt32(heap, cursor + 5)) === -1) {
          return -1
        }
        cursor += EVENT_RANGE_SIZE
      } else if (type === EVENT_TRAILER_NAME) {
        const start = base + readUInt32(heap, cursor + 1)
        if (this.onTrailerName(data, start, start + readUInt32(heap, cursor + 5)) === -1) {
          return -1
        }
        cursor += EVENT_RANGE_SIZE
      } else if (type === EVENT_TRAILER_VALUE) {
        const start = base + readUInt32(heap, cursor + 1)
        if (this.onTrailerValue(data, start, start + readUInt32(heap, cursor + 5)) === -1) {
          return -1
        }
        cursor += EVENT_RANGE_SIZE
      } else if (type === EVENT_END) {
        return 0
      } else if (type === EVENT_HEADERS) {
        const statusCode = heap[cursor + 5] | (heap[cursor + 6] << 8)
        const shouldKeepAlive = heap[cursor + 7] !== 0
        const bodyKind = heap[cursor + 10]
        const contentLength = bodyKind === BODY_KIND_CONTENT_LENGTH
          ? readUInt32(heap, cursor + 11) + readUInt32(heap, cursor + 15) * 0x100000000
          : -1
        if (this.onHeadersComplete(statusCode, shouldKeepAlive, bodyKind, contentLength) === -1) {
          return -1
        }
        // The field section ends the events of a call, as milo stops after
        // it. Unless the connection is upgraded, onHeadersComplete ran the
        // body decision, whose own events are next.
        cursor = this.upgrade ? cursor + EVENT_HEADERS_SIZE : this.events
      } else if (type === EVENT_MESSAGE_START) {
        if (this.onMessageBegin() === -1) {
          return -1
        }
        cursor += EVENT_RANGE_SIZE
      } else if (type === EVENT_MESSAGE_COMPLETE) {
        if (this.onMessageComplete() === -1) {
          return -1
        }
        cursor += EVENT_RANGE_SIZE
      } else if (heap.length === 0) {
        // Detached by a grown memory.
        heap = getHeap()
      } else {
        /* istanbul ignore next: only the events enabled above are written */
        throw new Error(`unexpected milo event ${type}`)
      }
    }
  }

  /**
   * Puts milo in its error state for a handler that failed. The error then
   * surfaces like a parse error, unless the socket is already destroyed.
   * @param {number} code
   * @param {string} description
   * @returns {-1}
   */
  fail (code, description) {
    if (getHeap()[this.ptr + PARSER_FIELD_ERROR_CODE] === 0) {
      milo.fail(this.ptr, code, description)
    }
    return -1
  }

  finish () {
    assert(currentParser === null)
    assert(!this.destroyed)

    // The peer closed the connection. Backpressure is advisory here: onData
    // keeps buffering delivered bytes into the response stream, so hand on
    // what is still buffered on the socket (a paused parser stops reading)
    // before signalling EOF. A Content-Length or chunked body completes on
    // the way; an EOF-delimited body is completed by milo.finish().
    while (this.paused) {
      this.paused = false
      const data = this.socket.read()
      if (data === null) {
        break
      }
      this.execute(data)
      if (this.destroyed) {
        return null
      }
    }

    if (this.bodyRemaining > 0) {
      return this.createError(EMPTY_BUF)
    }

    // No response has started since the last one completed.
    if (this.ptr === 0) {
      return null
    }

    try {
      currentParser = this
      milo.finish(this.ptr)
      this.drain(EMPTY_BUF, 0)
    } finally {
      currentParser = null
    }

    if (getHeap()[this.ptr + PARSER_FIELD_ERROR_CODE] !== 0) {
      return this.createError(EMPTY_BUF)
    }

    return null
  }

  /**
   * @param {Buffer} data
   * @returns {Error}
   */
  createError (data) {
    const { contentLength, bytesRead } = this
    const code = milo.getErrorCode(this.ptr)

    // The body was cut short, rather than malformed.
    if (
      contentLength !== -1 &&
      bytesRead !== contentLength &&
      (code === ERROR_NONE || code === ERROR_UNEXPECTED_EOF || code === ERROR_CALLBACK_ERROR)
    ) {
      return new ResponseContentLengthMismatchError()
    }

    // llhttp's wording, which callers may match on.
    const reason = code === ERROR_UNEXPECTED_EOF ? 'Invalid EOF state' : milo.getErrorDescription(this.ptr)

    return new HTTPParserError(
      'Response does not match the HTTP/1.1 protocol (' + reason + ')',
      milo.Errors[code],
      data
    )
  }

  destroy () {
    assert(currentParser === null)
    assert(!this.destroyed)

    if (this.ptr !== 0) {
      // A parser left in a message, finished or failed is not reused.
      if (getHeap()[this.ptr + PARSER_FIELD_STATE] === STATE_START) {
        idleParsers.push(this.ptr)
      } else {
        milo.destroy(this.ptr)
      }
      this.ptr = 0
    }
    this.destroyed = true

    if (this.fastTimeout != null) {
      timers.clearFastTimeout(this.fastTimeout)
    }
    if (this.nativeTimeout != null) {
      clearTimeout(this.nativeTimeout)
    }
    this.timeout = null
    this.timeoutType = null
    this.fastTimeout = null
    this.fastTimeoutValue = null
    this.nativeTimeout = null
    this.nativeTimeoutValue = null

    this.paused = false
    this.pending = null
  }

  /**
   * @returns {0|-1}
   */
  onMessageBegin () {
    const { socket, client } = this

    /* istanbul ignore next: difficult to make a test case for */
    if (socket.destroyed) {
      return -1
    }

    // A response arriving while nothing is inflight means a previously idle
    // keep-alive socket received an unsolicited/early response. Matching it
    // against the next request would poison the response queue, so discard the
    // socket instead (GHSA-35p6-xmwp-9g52).
    if (client[kRunning] === 0) {
      util.destroy(socket, new SocketError('bad response', util.getSocketInfo(socket)))
      return -1
    }

    const request = client[kQueue][client[kRunningIdx]]
    if (!request) {
      return this.fail(ERROR_CALLBACK_ERROR, 'Missing request')
    }

    return 0
  }

  /**
   * @param {Buffer} data
   * @param {number} start
   * @param {number} end
   * @returns {0|-1}
   */
  onHeaderName (data, start, end) {
    const len = end - start
    const index = this.fieldIndex++

    let name = this.fieldNames[index]
    if (name === undefined || name.length !== len || !equalsHeaderName(data, start, name)) {
      name = lookupHeaderName(data, start, end)
      this.fieldNames[index] = name
    }

    this.headerName = name
    return this.trackHeader(len)
  }

  /**
   * @param {Buffer} data
   * @param {number} start
   * @param {number} end
   * @returns {0|-1}
   */
  onTrailerName (data, start, end) {
    this.headerName = lookupHeaderName(data, start, end)
    return this.trackHeader(end - start)
  }

  /**
   * @param {Buffer} data
   * @param {number} start
   * @param {number} end
   * @returns {0|-1}
   */
  onHeaderValue (data, start, end) {
    // Values are handed on as latin1 strings, which is what the header map
    // stores.
    const value = data.latin1Slice(skipLeadingWhitespace(data, start, end), end)

    if (this.headerName === 'keep-alive') {
      this.keepAlive += value
    }

    this.addHeader(this.headerName, value)
    return this.trackHeader(end - start)
  }

  /**
   * @param {Buffer} data
   * @param {number} start
   * @param {number} end
   * @returns {0|-1}
   */
  onTrailerValue (data, start, end) {
    this.addHeader(this.headerName, data.latin1Slice(skipLeadingWhitespace(data, start, end), end))
    return this.trackHeader(end - start)
  }

  /**
   * Adds a field line to the header map. The name is already lowercased, so
   * two spellings of one name share an entry, and a repeated field line turns
   * the entry into an array.
   *
   * A `__proto__` field is DROPPED. It is a valid RFC 9110 token, so a peer may
   * send one, but assigning it onto a plain object invokes Object.prototype's
   * `__proto__` setter: a repeated field line would arrive as an array and
   * replace the map's prototype outright. Dropping it here gives every consumer
   * copying the map one guarantee: no own key named `__proto__`. Other names
   * that shadow Object.prototype (`constructor`, `tostring`, ...) are ordinary
   * data properties and are kept.
   * @param {string} name
   * @param {string} value
   */
  addHeader (name, value) {
    if (name === '__proto__') {
      return
    }

    const { headers } = this
    const prev = headers[name]
    if (prev === undefined || !Object.hasOwn(headers, name)) {
      headers[name] = value
    } else if (typeof prev === 'string') {
      headers[name] = [prev, value]
    } else {
      prev.push(value)
    }
  }

  /**
   * Returns the header map parsed so far and starts a new one.
   * @returns {import('../../index.js').HeaderMap}
   */
  takeHeaders () {
    const headers = this.headers
    this.headers = {}
    this.headerName = ''
    this.headersSize = 0
    this.fieldIndex = 0

    return headers
  }

  /**
   * @param {number} len
   * @returns {0|-1}
   */
  trackHeader (len) {
    this.headersSize += len
    if (this.headersSize >= this.headersMaxSize) {
      util.destroy(this.socket, new HeadersOverflowError())
      return -1
    }
    return 0
  }

  /**
   * @param {Buffer} head
   */
  onUpgrade (head) {
    const { upgrade, client, socket, statusCode } = this

    assert(upgrade)
    assert(client[kSocket] === socket)
    assert(!socket.destroyed)
    assert(!this.paused)

    const request = client[kQueue][client[kRunningIdx]]
    assert(request)
    assert(request.upgrade || request.method === 'CONNECT')

    this.statusCode = 0
    this.shouldKeepAlive = false

    const headers = this.takeHeaders()

    socket.unshift(head)

    socket[kParser].destroy()
    socket[kParser] = null

    socket[kClient] = null
    socket[kError] = null

    removeAllListeners(socket)

    client[kSocket] = null
    client[kHTTPContext] = null // TODO (fix): This is hacky...
    client[kQueue][client[kRunningIdx]++] = null
    client.emit('disconnect', client[kUrl], [client], new InformationalError('upgrade'))

    try {
      request.onUpgrade(statusCode, headers, socket)
    } catch (err) {
      util.errorRequest(client, request, err)
      util.destroy(socket, err)
    }

    client[kResume]()
  }

  /**
   * @param {number} statusCode
   * @param {boolean} shouldKeepAlive false if the response has Connection: close
   * @param {number} bodyKind
   * @param {number} contentLength -1 without a Content-Length
   * @returns {0|-1}
   */
  onHeadersComplete (statusCode, shouldKeepAlive, bodyKind, contentLength) {
    const { client, socket } = this

    /* istanbul ignore next: difficult to make a test case for */
    if (socket.destroyed) {
      return -1
    }

    // See onMessageBegin: response headers without an inflight request mean a
    // poisoned idle socket (GHSA-35p6-xmwp-9g52).
    if (client[kRunning] === 0) {
      util.destroy(socket, new SocketError('bad response', util.getSocketInfo(socket)))
      return -1
    }

    const request = client[kQueue][client[kRunningIdx]]

    /* istanbul ignore next: difficult to make a test case for */
    if (!request) {
      return this.fail(ERROR_CALLBACK_ERROR, 'Missing request')
    }

    assert(!this.upgrade)
    assert(this.statusCode < 200)

    // milo accepts any three digits.
    if (statusCode < 100) {
      return this.fail(ERROR_INVALID_STATUS, 'Invalid HTTP response status')
    }

    if (statusCode === 100) {
      util.destroy(socket, new SocketError('bad response', util.getSocketInfo(socket)))
      return -1
    }

    // A 101 switches protocols, whether or not it names one in Upgrade.
    const upgrade = statusCode === 101

    /* this can only happen if server is misbehaving */
    if (upgrade && !request.upgrade) {
      util.destroy(socket, new SocketError('bad upgrade', util.getSocketInfo(socket)))
      return -1
    }

    assert(this.timeoutType === TIMEOUT_HEADERS)

    this.statusCode = statusCode
    this.contentLength = contentLength
    // milo keeps a connection alive unless the response has Connection: close,
    // but one whose body runs to EOF cannot be reused either.
    this.shouldKeepAlive = shouldKeepAlive && (
      bodyKind !== BODY_KIND_EOF ||
      request.method === 'HEAD' ||
      statusCode < 200 ||
      statusCode === 204 ||
      statusCode === 205 ||
      statusCode === 304
    )

    if (this.statusCode >= 200) {
      const bodyTimeout = request.bodyTimeout != null
        ? request.bodyTimeout
        : client[kBodyTimeout]
      this.setTimeout(bodyTimeout, TIMEOUT_BODY)
    } else if (this.timeout != null) {
      this.timeout.refresh()
    }

    if (request.method === 'CONNECT') {
      assert(client[kRunning] === 1)
      this.upgrade = true
      return 0
    }

    if (upgrade) {
      assert(client[kRunning] === 1)
      this.upgrade = true
      return 0
    }

    // Run the body decision before the handler sees the headers, so a
    // response milo cannot frame fails the request instead of its body. It
    // gets a call into milo of its own: a response without a body then
    // completes before any byte of the next one is parsed, as a parse error
    // drops every event of the call that hits it.
    const { ptr } = this
    if (request.method === 'HEAD') {
      milo.setShouldSkipBody(ptr, true)
    }
    milo.parse(ptr, inputPtr, 0)
    if (getHeap()[ptr + PARSER_FIELD_ERROR_CODE] !== 0) {
      return -1
    }
    if (heap[ptr + PARSER_FIELD_STATE] === STATE_BODY_VIA_CONTENT_LENGTH) {
      this.bodyRemaining = contentLength
    }

    const headers = this.takeHeaders()

    if (this.shouldKeepAlive && client[kPipelining]) {
      const keepAliveTimeout = this.keepAlive ? this.parseKeepAliveTimeout(this.keepAlive) : null

      if (keepAliveTimeout != null) {
        const timeout = Math.min(
          keepAliveTimeout - client[kKeepAliveTimeoutThreshold],
          client[kKeepAliveMaxTimeout]
        )
        if (timeout <= 0) {
          socket[kReset] = true
        } else {
          client[kKeepAliveTimeoutValue] = timeout
        }
      } else {
        client[kKeepAliveTimeoutValue] = client[kKeepAliveDefaultTimeout]
      }
    } else {
      // Stop more requests from being dispatched.
      socket[kReset] = true
    }

    const pause = request.onHeaders(statusCode, headers, this.resume) === false

    if (request.aborted) {
      return -1
    }

    if (request.method === 'HEAD') {
      return 0
    }

    if (statusCode < 200) {
      return 0
    }

    if (socket[kBlocking]) {
      socket[kBlocking] = false
      client[kResume]()
    }

    if (pause) {
      this.paused = true
    }

    return 0
  }

  /**
   * @param {Buffer} buf
   * @returns {0|-1}
   */
  onBody (buf) {
    const { client, socket, statusCode, maxResponseSize } = this

    if (socket.destroyed) {
      return -1
    }

    const request = client[kQueue][client[kRunningIdx]]
    assert(request)

    assert(this.timeoutType === TIMEOUT_BODY)
    if (this.timeout != null) {
      this.timeout.refresh()
    }

    assert(statusCode >= 200)

    if (maxResponseSize > -1 && this.bytesRead + buf.length > maxResponseSize) {
      util.destroy(socket, new ResponseExceededMaxSizeError())
      return -1
    }

    this.bytesRead += buf.length

    if (request.onData(buf) === false) {
      // What milo already parsed is still handed on; no more is read until
      // the handler resumes.
      this.paused = true
    }

    return 0
  }

  /**
   * @returns {0|-1}
   */
  onMessageComplete () {
    const { client, socket, statusCode, upgrade, contentLength, bytesRead, shouldKeepAlive } = this

    if (
      socket.destroyed &&
      (
        client.destroyed ||
        !statusCode ||
        (
          shouldKeepAlive &&
          (contentLength === -1 || bytesRead !== contentLength)
        )
      )
    ) {
      return this.fail(ERROR_CALLBACK_ERROR, 'Other side closed')
    }

    /* istanbul ignore next: an upgrade stops parsing after its headers */
    if (upgrade) {
      return 0
    }

    assert(statusCode >= 100)

    const request = client[kQueue][client[kRunningIdx]]
    assert(request)

    this.statusCode = 0
    this.bytesRead = 0
    this.contentLength = -1
    this.keepAlive = ''
    // A pause asked for by this response's handler ends with the response.
    this.paused = false

    const trailers = this.takeHeaders()

    if (statusCode < 200) {
      return 0
    }

    // A 304 has no content; its Content-Length describes the selected representation.
    /* istanbul ignore next: milo frames a Content-Length body itself */
    if (request.method !== 'HEAD' && statusCode !== 304 && contentLength !== -1 && bytesRead !== contentLength) {
      util.destroy(socket, new ResponseContentLengthMismatchError())
      return -1
    }

    request.onComplete(trailers)

    client[kQueue][client[kRunningIdx]++] = null
    // Once the socket has served a response it is a reuse candidate; a
    // subsequently idle socket must be revalidated before dispatching the next
    // pending request (see resumeH1 / GHSA-35p6-xmwp-9g52).
    socket[kSocketUsed] = client[kPending] === 0

    if (socket[kWriting]) {
      assert(client[kRunning] === 0)
      // Response completed before request.
      util.destroy(socket, new InformationalError('reset'))
      return -1
    } else if (!shouldKeepAlive) {
      util.destroy(socket, new InformationalError('reset'))
      return -1
    } else if (socket[kReset] && client[kRunning] === 0) {
      // Destroy socket once all requests have completed.
      // The request at the tail of the pipeline is the one
      // that requested reset and no further requests should
      // have been queued since then.
      util.destroy(socket, new InformationalError('reset'))
      return -1
    } else if (client[kPipelining] == null || client[kPipelining] === 1) {
      // We must wait a full event loop cycle to reuse this socket to make sure
      // that non-spec compliant servers are not closing the connection even if they
      // said they won't.
      setImmediate(client[kResume])
    } else {
      client[kResume]()
    }

    return 0
  }
}

function onParserTimeout (parserWeakRef) {
  const parser = parserWeakRef.deref()
  if (!parser) {
    return
  }

  const { socket, timeoutType, client, paused } = parser

  /* istanbul ignore else */
  if (timeoutType === TIMEOUT_HEADERS) {
    if (!socket[kWriting] || socket.writableNeedDrain || client[kRunning] > 1) {
      assert(!paused, 'cannot be paused while waiting for headers')
      util.destroy(socket, new HeadersTimeoutError())
    }
  } else if (timeoutType === TIMEOUT_BODY) {
    if (!paused) {
      util.destroy(socket, new BodyTimeoutError())
    }
  }
}

function onParserKeepAliveTimeout (parserWeakRef) {
  const parser = parserWeakRef.deref()
  // The keep-alive timer stays armed after the parser moves on to the next
  // request (see Parser#setTimeout), so only act while the socket is idle.
  if (!parser || parser.timeoutType !== TIMEOUT_KEEP_ALIVE) {
    return
  }

  const { socket, client } = parser

  assert(client[kRunning] === 0 && client[kKeepAliveTimeoutValue])
  util.destroy(socket, new InformationalError('socket idle timeout'))
}

/**
 * @param {import ('./client.js')} client
 * @param {import('net').Socket} socket
 * @returns
 */
async function connectH1 (client, socket) {
  client[kSocket] = socket

  if (socket.errored) {
    throw socket.errored
  }

  if (socket.destroyed) {
    throw new SocketError('destroyed')
  }

  socket[kNoRef] = false
  socket[kWriting] = false
  socket[kReset] = false
  socket[kBlocking] = false
  socket[kIdleSocketValidation] = 0
  socket[kIdleSocketValidationTimeout] = null
  socket[kSocketUsed] = false
  socket[kParser] = new Parser(client, socket)

  util.addListener(socket, 'error', onHttpSocketError)
  util.addListener(socket, 'readable', onHttpSocketReadable)
  util.addListener(socket, 'end', onHttpSocketEnd)
  util.addListener(socket, 'close', onHttpSocketClose)

  socket[kClosed] = false
  socket.on('close', onSocketClose)

  return {
    version: 'h1',
    defaultPipelining: 1,
    write (request) {
      return writeH1(client, request)
    },
    resume () {
      resumeH1(client)
    },
    /**
     * @param {Error|undefined} err
     * @param {() => void} callback
     */
    destroy (err, callback) {
      if (socket[kClosed]) {
        queueMicrotask(callback)
      } else {
        socket.on('close', callback)
        socket.destroy(err)
      }
    },
    /**
     * @returns {boolean}
     */
    get destroyed () {
      return socket.destroyed
    },
    /**
     * @param {import('../core/request.js')} request
     * @returns {boolean}
     */
    busy (request) {
      if (socket[kWriting] || socket[kReset] || socket[kBlocking] || socket[kIdleSocketValidation] === 1) {
        return true
      }

      if (request) {
        if (client[kRunning] > 0 && !request.idempotent) {
          // Non-idempotent request cannot be retried.
          // Ensure that no other requests are inflight and
          // could cause failure.
          return true
        }

        if (client[kRunning] > 0 && (request.upgrade || request.method === 'CONNECT')) {
          // Don't dispatch an upgrade until all preceding requests have completed.
          // A misbehaving server might upgrade the connection before all pipelined
          // request has completed.
          return true
        }

        if (client[kRunning] > 0 && request.getBodyLength() !== 0 &&
          (util.isStream(request.body) || util.isAsyncIterable(request.body) || util.isFormDataLike(request.body) ||
            request.blob !== null)) {
          // Request with stream, iterator, or stream-backed Blob body can error
          // while other requests are inflight and indirectly error those as well.
          // Ensure this doesn't happen by waiting for inflight
          // to complete before dispatching.

          // Request with stream or iterator body cannot be retried.
          // Ensure that no other requests are inflight and
          // could cause failure.
          return true
        }
      }

      return false
    }
  }
}

function onHttpSocketError (err) {
  assert(err.code !== 'ERR_TLS_CERT_ALTNAME_INVALID')

  const parser = this[kParser]

  // On Mac OS, we get an ECONNRESET even if there is a full body to be forwarded
  // to the user.
  if (
    err.code === 'ECONNRESET' &&
    parser.statusCode &&
    (!parser.shouldKeepAlive || parser.paused)
  ) {
    const parserErr = parser.finish()
    if (parserErr) {
      this[kError] = parserErr
      this[kClient][kOnError](parserErr)
    }
    return
  }

  this[kError] = err

  this[kClient][kOnError](err)
}

function onHttpSocketReadable () {
  this[kParser]?.readMore()
}

function onHttpSocketEnd () {
  const parser = this[kParser]

  if (parser.statusCode && (!parser.shouldKeepAlive || parser.paused)) {
    const parserErr = parser.finish()
    if (parserErr) {
      util.destroy(this, parserErr)
    }
    return
  }

  util.destroy(this, new SocketError('other side closed', util.getSocketInfo(this)))
}

function onHttpSocketClose () {
  const parser = this[kParser]

  clearIdleSocketValidation(this)

  if (parser) {
    if (!this[kError] && parser.statusCode && !parser.shouldKeepAlive) {
      this[kError] = parser.finish() || this[kError]
    }

    this[kParser].destroy()
    this[kParser] = null
  }

  const err = this[kError] || new SocketError('closed', util.getSocketInfo(this))

  const client = this[kClient]

  client[kSocket] = null
  client[kHTTPContext] = null // TODO (fix): This is hacky...

  if (client.destroyed) {
    assert(client[kPending] === 0)

    // Fail entire queue.
    const requests = client[kQueue].splice(client[kRunningIdx])
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i]
      util.errorRequest(client, request, err)
    }
  } else if (client[kRunning] > 0 && err.code !== 'UND_ERR_INFO') {
    // Fail head of pipeline.
    const request = client[kQueue][client[kRunningIdx]]
    client[kQueue][client[kRunningIdx]++] = null

    util.errorRequest(client, request, err)
  }

  client[kPendingIdx] = client[kRunningIdx]

  assert(client[kRunning] === 0)

  client.emit('disconnect', client[kUrl], [client], err)

  client[kResume]()
}

function onSocketClose () {
  this[kClosed] = true
}

function clearIdleSocketValidation (socket) {
  if (socket[kIdleSocketValidationTimeout] != null) {
    clearImmediate(socket[kIdleSocketValidationTimeout])
    socket[kIdleSocketValidationTimeout] = null
  }

  socket[kIdleSocketValidation] = 0
}

function scheduleIdleSocketValidation (client, socket) {
  socket[kIdleSocketValidation] = 1
  socket[kIdleSocketValidationTimeout] = setImmediate(() => {
    socket[kIdleSocketValidationTimeout] = null
    socket[kIdleSocketValidation] = 2

    if (client[kSocket] === socket && !socket.destroyed) {
      client[kResume]()
    }
  })
  // Keep this referenced so the poll phase cannot defer queued work until an
  // unrelated timer or I/O event wakes the loop.
}

/**
 * @param {import('./client.js')} client
 */
function resumeH1 (client) {
  const socket = client[kSocket]

  if (socket && !socket.destroyed) {
    if (client[kSize] === 0) {
      if (!socket[kNoRef] && socket.unref) {
        socket.unref()
        socket[kNoRef] = true
      }
    } else if (socket[kNoRef] && socket.ref) {
      socket.ref()
      socket[kNoRef] = false
    }

    // Before dispatching a pending request onto a previously-used idle socket,
    // proactively read from it once to surface any unsolicited bytes a
    // misbehaving/malicious peer may have injected while it was idle. The
    // one-tick validation window lets a stray response (which onMessageBegin
    // turns into a 'bad response' teardown) close the socket before we bind the
    // next request to it, preventing response queue poisoning
    // (GHSA-35p6-xmwp-9g52). busy() reports the socket as busy while
    // validation (state 1) is pending so no request is dispatched meanwhile.
    if (client[kRunning] === 0 && client[kPending] > 0 && socket[kSocketUsed]) {
      if (socket[kIdleSocketValidation] === 0) {
        scheduleIdleSocketValidation(client, socket)
        socket[kParser].readMore()
        if (socket.destroyed) {
          return
        }
        return
      }

      if (socket[kIdleSocketValidation] === 1) {
        socket[kParser].readMore()
        if (socket.destroyed) {
          return
        }
        return
      }
    }

    if (client[kRunning] === 0) {
      socket[kParser].readMore()
      if (socket.destroyed) {
        return
      }
    }

    if (client[kSize] === 0) {
      // Socket is fully idle. If validation was scheduled/completed but the
      // pending request that triggered it went away before being written (e.g.
      // it was aborted), reset validation state here so the socket is
      // revalidated on its next reuse instead of getting stuck in state 1/2 and
      // skipping the poisoning check (GHSA-35p6-xmwp-9g52).
      clearIdleSocketValidation(socket)
      if (socket[kParser].timeoutType !== TIMEOUT_KEEP_ALIVE) {
        socket[kParser].setTimeout(client[kKeepAliveTimeoutValue], TIMEOUT_KEEP_ALIVE)
      }
    } else if (client[kRunning] > 0 && socket[kParser].statusCode < 200) {
      if (socket[kParser].timeoutType !== TIMEOUT_HEADERS) {
        const request = client[kQueue][client[kRunningIdx]]
        const headersTimeout = request.headersTimeout != null
          ? request.headersTimeout
          : client[kHeadersTimeout]
        socket[kParser].setTimeout(headersTimeout, TIMEOUT_HEADERS)
      }
    }
  }
}

// https://www.rfc-editor.org/rfc/rfc7230#section-3.3.2
function shouldSendContentLength (method) {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && method !== 'TRACE' && method !== 'CONNECT'
}

/**
 * @param {import('node:net').Socket} socket
 * @param {import('../core/request.js')} request
 */
function setTypeOfService (socket, request) {
  if (typeof socket.setTypeOfService !== 'function') {
    return
  }

  const typeOfService = request.typeOfService
  const currentTypeOfService = socket[kTOS]

  if (currentTypeOfService === typeOfService) {
    return
  }

  if (!request.hasTypeOfService && currentTypeOfService === undefined && typeOfService === 0) {
    return
  }

  try {
    socket.setTypeOfService(typeOfService)
    socket[kTOS] = typeOfService
  } catch {
    // QoS marking is best-effort and can fail synchronously depending on the
    // platform and socket state. A failed hint must not abort the request.
  }
}

/**
 * @param {import('./client.js')} client
 * @param {import('../core/request.js')} request
 * @returns
 */
function writeH1 (client, request) {
  const { method, path, host, upgrade, blocking, reset } = request

  let { body, headers, contentLength } = request
  const { blob } = request

  // https://tools.ietf.org/html/rfc7231#section-4.3.1
  // https://tools.ietf.org/html/rfc7231#section-4.3.2
  // https://tools.ietf.org/html/rfc7231#section-4.3.5

  // Sending a payload body on a request that does not
  // expect it can cause undefined behavior on some
  // servers and corrupt connection state. Do not
  // re-use the connection for further requests.

  const expectsPayload = (
    method === 'PUT' ||
    method === 'POST' ||
    method === 'PATCH' ||
    method === 'QUERY' ||
    method === 'PROPFIND' ||
    method === 'PROPPATCH'
  )

  if (blob === null && util.isFormDataLike(body)) {
    // This build does not bundle fetch/extractBody, so a raw FormData body
    // cannot be serialized. Error the request gracefully instead of throwing
    // synchronously: a throw here escapes the queueMicrotask dispatch path
    // (client.js) as an uncaught exception and, worse, unwinds resume() before
    // it can reset kResuming, permanently wedging the client's dispatcher.
    util.errorRequest(client, request, new InvalidArgumentError('Unsupported body type: FormData. Encode the body (e.g. URLSearchParams or a multipart Buffer/stream) before dispatching.'))
    return false
  }

  const bodyLength = request.getBodyLength()

  contentLength = bodyLength ?? contentLength

  if (contentLength === null) {
    contentLength = request.contentLength
  }

  if (contentLength === 0 && !expectsPayload) {
    // https://tools.ietf.org/html/rfc7230#section-3.3.2
    // A user agent SHOULD NOT send a Content-Length header field when
    // the request message does not contain a payload body and the method
    // semantics do not anticipate such a body.

    contentLength = null
  }

  // https://github.com/nodejs/undici/issues/2046
  // A user agent may send a Content-Length header with 0 value, this should be allowed.
  if (shouldSendContentLength(method) && contentLength > 0 && request.contentLength !== null && request.contentLength !== contentLength) {
    if (client[kStrictContentLength]) {
      util.errorRequest(client, request, new RequestContentLengthMismatchError())
      return false
    }

    process.emitWarning(new RequestContentLengthMismatchError())
  }

  const socket = client[kSocket]

  // The socket is being handed a request; cancel any in-flight idle validation
  // and reset its state so the reuse guard in resumeH1 starts clean next time.
  clearIdleSocketValidation(socket)

  /**
   * @param {*} [reason]
   * @returns {void}
   */
  const abort = (reason) => {
    if (request.aborted || request.completed) {
      return
    }

    util.errorRequest(client, request, reason ?? new RequestAbortedError())

    util.destroy(body)
    util.destroy(socket, new InformationalError('aborted'))
  }

  try {
    request.onConnect(abort)
  } catch (err) {
    util.errorRequest(client, request, err)
  }

  if (request.aborted) {
    return false
  }

  let blobStream
  if (blob !== null) {
    try {
      blobStream = blob.call(body)
    } catch (err) {
      // No request bytes have been written yet. Reject this request without
      // tearing down an otherwise reusable connection.
      util.errorRequest(client, request, err)
      return false
    }
  }

  if (bodyLength === 0 && util.isStream(body)) {
    // Empty streams bypass writeStream(), but an already-signalled EOF still
    // needs to be consumed so its 'end' lifecycle (including auto-destroy)
    // runs. Do this only after onConnect installed the request abort handler;
    // pre-reading arbitrary streams here can start user _read() code before
    // writeStream has attached its data/error/close listeners.
    if (typeof body.resume === 'function') {
      body.resume()
    }
  }

  if (method === 'HEAD') {
    // https://github.com/mcollina/undici/issues/258
    // Close after a HEAD request to interop with misbehaving servers
    // that may send a body in the response.

    socket[kReset] = true
  }

  if (upgrade || method === 'CONNECT') {
    // On CONNECT or upgrade, block pipeline from dispatching further
    // requests on this connection.

    socket[kReset] = true
  }

  if (reset != null) {
    socket[kReset] = reset
  }

  if (client[kMaxRequests] && ++socket[kCounter] >= client[kMaxRequests]) {
    socket[kReset] = true
  }

  if (blocking) {
    socket[kBlocking] = true
  }

  let header = `${method} ${path} HTTP/1.1\r\n`

  if (typeof host === 'string') {
    header += `host: ${host}\r\n`
  } else {
    header += client[kHostHeader]
  }

  if (upgrade) {
    header += `connection: upgrade\r\nupgrade: ${upgrade}\r\n`
  } else if (client[kPipelining] && !socket[kReset]) {
    header += 'connection: keep-alive\r\n'
  } else {
    header += 'connection: close\r\n'
  }

  if (Array.isArray(headers)) {
    for (let n = 0; n < headers.length; n += 2) {
      const key = headers[n + 0]
      const val = headers[n + 1]

      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          header += `${key}: ${val[i]}\r\n`
        }
      } else {
        header += `${key}: ${val}\r\n`
      }
    }
  }

  setTypeOfService(socket, request)

  /* istanbul ignore else: assertion */
  if (!body || bodyLength === 0) {
    writeBuffer(abort, null, client, request, socket, contentLength, header, expectsPayload)
  } else if (util.isBuffer(body)) {
    writeBuffer(abort, body, client, request, socket, contentLength, header, expectsPayload)
  } else if (blob !== null) {
    writeIterable(abort, blobStream, client, request, socket, contentLength, header, expectsPayload)
  } else if (util.isStream(body)) {
    writeStream(abort, body, client, request, socket, contentLength, header, expectsPayload)
  } else if (util.isIterable(body)) {
    writeIterable(abort, body, client, request, socket, contentLength, header, expectsPayload)
  } else {
    // Unreachable in practice — Request's constructor validates the body type.
    // Guard defensively anyway so an unexpected body can never crash the
    // process via a synchronous assertion thrown from this (uncaught) context.
    abort(new InvalidArgumentError('Unsupported body type'))
  }

  return true
}

/**
 * @param {AbortCallback} abort
 * @param {import('stream').Stream} body
 * @param {import('./client.js')} client
 * @param {import('../core/request.js')} request
 * @param {import('net').Socket} socket
 * @param {number} contentLength
 * @param {string} header
 * @param {boolean} expectsPayload
 */
function writeStream (abort, body, client, request, socket, contentLength, header, expectsPayload) {
  assert(contentLength !== 0 || client[kRunning] === 0, 'stream body cannot be pipelined')

  let finished = false

  const writer = new AsyncWriter({ abort, socket, request, contentLength, client, expectsPayload, header })

  /**
   * @param {Buffer} chunk
   * @returns {void}
   */
  const onData = function (chunk) {
    if (finished) {
      return
    }

    try {
      if (!writer.write(chunk) && this.pause) {
        this.pause()
      }
    } catch (err) {
      util.destroy(this, err)
    }
  }

  /**
   * @returns {void}
   */
  const onDrain = function () {
    if (finished) {
      return
    }

    if (body.resume) {
      body.resume()
    }
  }

  /**
   * @returns {void}
   */
  const onClose = function () {
    // 'close' might be emitted *before* 'error' for
    // broken streams. Wait a tick to avoid this case.
    queueMicrotask(() => {
      // It's only safe to remove 'error' listener after
      // 'close'.
      body.removeListener('error', onFinished)
    })

    if (!finished) {
      const err = new RequestAbortedError()
      queueMicrotask(() => onFinished(err))
    }
  }

  /**
   * @param {Error} [err]
   * @returns
   */
  const onFinished = function (err) {
    if (finished) {
      return
    }

    finished = true

    assert(socket.destroyed || (socket[kWriting] && client[kRunning] <= 1))

    socket
      .off('drain', onDrain)
      .off('error', onFinished)

    body
      .removeListener('data', onData)
      .removeListener('end', onFinished)
      .removeListener('close', onClose)

    if (!err) {
      try {
        writer.end()
      } catch (er) {
        err = er
      }
    }

    writer.destroy(err)

    if (err && (err.code !== 'UND_ERR_INFO' || err.message !== 'reset')) {
      util.destroy(body, err)
    } else {
      util.destroy(body)
    }
  }

  body
    .on('data', onData)
    .on('end', onFinished)
    .on('error', onFinished)
    .on('close', onClose)

  if (body.resume) {
    body.resume()
  }

  socket
    .on('drain', onDrain)
    .on('error', onFinished)

  if (body.errorEmitted ?? body.errored) {
    setImmediate(onFinished, body.errored)
  } else if (body.endEmitted ?? body.readableEnded) {
    setImmediate(onFinished, null)
  }

  if (body.closeEmitted ?? body.closed) {
    setImmediate(onClose)
  }
}

/**
 * @typedef AbortCallback
 * @type {Function}
 * @param {Error} [err]
 * @returns {void}
 */

/**
 * @param {AbortCallback} abort
 * @param {Uint8Array|null} body
 * @param {import('./client.js')} client
 * @param {import('../core/request.js')} request
 * @param {import('net').Socket} socket
 * @param {number} contentLength
 * @param {string} header
 * @param {boolean} expectsPayload
 * @returns {void}
 */
function writeBuffer (abort, body, client, request, socket, contentLength, header, expectsPayload) {
  try {
    if (!body) {
      if (contentLength === 0) {
        socket.write(`${header}content-length: 0\r\n\r\n`, 'latin1')
      } else {
        assert(contentLength === null, 'no body must not have content length')
        socket.write(`${header}\r\n`, 'latin1')
      }
    } else if (util.isBuffer(body)) {
      assert(contentLength === body.byteLength, 'buffer body must have content length')

      socket.cork()
      socket.write(`${header}content-length: ${contentLength}\r\n\r\n`, 'latin1')
      socket.write(body)
      socket.uncork()

      if (!expectsPayload && request.reset !== false) {
        socket[kReset] = true
      }
    }

    client[kResume]()
  } catch (err) {
    abort(err)
  }
}

/**
 * @param {AbortCallback} abort
 * @param {Iterable} body
 * @param {import('./client.js')} client
 * @param {import('../core/request.js')} request
 * @param {import('net').Socket} socket
 * @param {number} contentLength
 * @param {string} header
 * @param {boolean} expectsPayload
 * @returns {Promise<void>}
 */
async function writeIterable (abort, body, client, request, socket, contentLength, header, expectsPayload) {
  assert(contentLength !== 0 || client[kRunning] === 0, 'iterator body cannot be pipelined')

  let callback = null
  function onDrain () {
    if (callback) {
      const cb = callback
      callback = null
      cb()
    }
  }

  const waitForDrain = () => new Promise((resolve, reject) => {
    assert(callback === null)

    if (socket[kError]) {
      reject(socket[kError])
    } else if (socket.destroyed) {
      // Not every teardown records socket[kError]: an ECONNRESET that arrives
      // after the response has been fully parsed is swallowed by
      // onHttpSocketError. A destroyed socket never emits 'drain', and once
      // 'close' has fired nothing would ever call onDrain, so waiting here
      // would park the iterator forever and never run its finally block.
      reject(new SocketError('closed', util.getSocketInfo(socket)))
    } else {
      callback = resolve
    }
  })

  socket
    .on('close', onDrain)
    .on('drain', onDrain)

  const writer = new AsyncWriter({ abort, socket, request, contentLength, client, expectsPayload, header })
  try {
    // It's up to the user to somehow abort the async iterable.
    let pendingWrites = 0
    for await (const chunk of body) {
      if (socket[kError]) {
        throw socket[kError]
      }

      if (!writer.write(chunk)) {
        await waitForDrain()
        pendingWrites = 0
      } else if (++pendingWrites >= 1024) {
        // A synchronous iterable whose writes never trigger backpressure (e.g.
        // the kernel keeps draining the socket) would otherwise spin the
        // microtask queue without ever yielding to the event loop. That starves
        // the I/O phase, so socket 'error'/'close' events — and therefore
        // aborting this request when the peer goes away — are never observed and
        // the loop runs forever. Yield to the macrotask phase periodically so
        // they get a chance to fire and the socket[kError] check above can trip.
        pendingWrites = 0
        await new Promise((resolve) => setImmediate(resolve))
      }
    }

    writer.end()
  } catch (err) {
    writer.destroy(err)
  } finally {
    socket
      .off('close', onDrain)
      .off('drain', onDrain)
  }
}

class AsyncWriter {
  /**
   *
   * @param {object} arg
   * @param {AbortCallback} arg.abort
   * @param {import('net').Socket} arg.socket
   * @param {import('../core/request.js')} arg.request
   * @param {number} arg.contentLength
   * @param {import('./client.js')} arg.client
   * @param {boolean} arg.expectsPayload
   * @param {string} arg.header
   */
  constructor ({ abort, socket, request, contentLength, client, expectsPayload, header }) {
    this.socket = socket
    this.request = request
    this.contentLength = contentLength
    this.client = client
    this.bytesWritten = 0
    this.expectsPayload = expectsPayload
    this.header = header
    this.abort = abort

    socket[kWriting] = true
  }

  /**
   * @param {string | ArrayBuffer | ArrayBufferView} chunk
   * @returns
   */
  write (chunk) {
    if (chunk instanceof ArrayBuffer) {
      chunk = Buffer.from(chunk)
    }

    const { socket, request, contentLength, client, bytesWritten, expectsPayload, header } = this

    if (socket[kError]) {
      throw socket[kError]
    }

    if (socket.destroyed) {
      return false
    }

    const len = Buffer.byteLength(chunk)
    if (!len) {
      return true
    }

    // We should defer writing chunks.
    if (contentLength !== null && bytesWritten + len > contentLength) {
      if (client[kStrictContentLength]) {
        throw new RequestContentLengthMismatchError()
      }

      process.emitWarning(new RequestContentLengthMismatchError())
    }

    socket.cork()

    if (bytesWritten === 0) {
      if (!expectsPayload && request.reset !== false) {
        socket[kReset] = true
      }

      if (contentLength === null) {
        socket.write(`${header}transfer-encoding: chunked\r\n`, 'latin1')
      } else {
        socket.write(`${header}content-length: ${contentLength}\r\n\r\n`, 'latin1')
      }
    }

    if (contentLength === null) {
      socket.write(`\r\n${len.toString(16)}\r\n`, 'latin1')
    }

    this.bytesWritten += len

    const ret = socket.write(chunk)

    socket.uncork()

    if (!ret) {
      if (socket[kParser].timeout != null && socket[kParser].timeoutType === TIMEOUT_HEADERS) {
        socket[kParser].timeout.refresh()
      }
    }

    return ret
  }

  /**
   * @returns {void}
   */
  end () {
    const { socket, contentLength, client, bytesWritten, expectsPayload, header } = this

    socket[kWriting] = false

    if (socket[kError]) {
      throw socket[kError]
    }

    if (socket.destroyed) {
      return
    }

    if (bytesWritten === 0) {
      if (expectsPayload) {
        // https://tools.ietf.org/html/rfc7230#section-3.3.2
        // A user agent SHOULD send a Content-Length in a request message when
        // no Transfer-Encoding is sent and the request method defines a meaning
        // for an enclosed payload body.

        socket.write(`${header}content-length: 0\r\n\r\n`, 'latin1')
      } else {
        socket.write(`${header}\r\n`, 'latin1')
      }
    } else if (contentLength === null) {
      socket.write('\r\n0\r\n\r\n', 'latin1')
    }

    if (contentLength !== null && bytesWritten !== contentLength) {
      if (client[kStrictContentLength]) {
        throw new RequestContentLengthMismatchError()
      } else {
        process.emitWarning(new RequestContentLengthMismatchError())
      }
    }

    if (socket[kParser].timeout != null && socket[kParser].timeoutType === TIMEOUT_HEADERS) {
      socket[kParser].timeout.refresh()
    }

    client[kResume]()
  }

  /**
   * @param {Error} [err]
   * @returns {void}
   */
  destroy (err) {
    const { socket, client, abort } = this

    socket[kWriting] = false

    if (err) {
      assert(client[kRunning] <= 1, 'pipeline should only contain this request')
      abort(err)
    }
  }
}

module.exports = connectH1
