'use strict'

const { InvalidArgumentError } = require('./errors')

const defaults = new WeakMap()
const kContext = Symbol('telemetryContext')
const kPrepared = Symbol('telemetryPrepared')
const kFields = Symbol('telemetryFields')

function setTelemetry (dispatcher, telemetry) {
  if (telemetry != null && telemetry !== false && typeof telemetry.capture !== 'function') {
    throw new InvalidArgumentError('telemetry must have a capture function or be false')
  }
  defaults.set(dispatcher, telemetry)
}

function getTelemetry (dispatcher) {
  return defaults.get(dispatcher)
}

// Keep original header values and validation in the transport. Only fields
// supplied by telemetry are replaced; undefined explicitly removes a field.
function injectHeaders (headers, fields, allowRequestId = false) {
  if (fields == null) return headers
  const replacements = new Map(Object.entries(fields)
    .map(([name, value]) => [name.toLowerCase(), value])
    .filter(([name]) => allowRequestId || name !== 'request-id'))
  const result = []
  const append = (name, value) => {
    if (typeof name !== 'string' || !replacements.has(name.toLowerCase())) {
      result.push(name, value)
    }
  }
  if (Array.isArray(headers)) {
    if (headers.length && Array.isArray(headers[0])) {
      for (const pair of headers) {
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new InvalidArgumentError('headers must be in key-value pair format')
        }
        append(pair[0], pair[1])
      }
    } else {
      if (headers.length % 2) throw new InvalidArgumentError('headers array must be even')
      for (let i = 0; i < headers.length; i += 2) append(headers[i], headers[i + 1])
    }
  } else if (headers != null && typeof headers === 'object') {
    if (typeof headers[Symbol.iterator] === 'function') {
      for (const pair of headers) {
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new InvalidArgumentError('headers must be in key-value pair format')
        }
        append(pair[0], pair[1])
      }
    } else {
      for (const name of Object.keys(headers)) append(name, headers[name])
    }
  } else if (headers != null) {
    throw new InvalidArgumentError('headers must be an object or an array')
  }
  for (const [name, value] of replacements) {
    if (value !== undefined) result.push(name, value)
  }
  // Generated propagation fields describe this hop, even when copied incoming
  // Connection nominations would otherwise strip them in a proxy pipeline.
  for (let i = 0; i < result.length; i += 2) {
    if (typeof result[i] === 'string' && result[i].toLowerCase() === 'connection' && result[i + 1] !== undefined) {
      const tokens = String(result[i + 1]).split(',').filter(name => !replacements.has(name.trim().toLowerCase()))
      if (tokens.length) result[i + 1] = tokens.join(',')
      else {
        result.splice(i, 2)
        i -= 2
      }
    }
  }
  return result
}

function bindHandler (handler, scope, span) {
  let ended = false
  let aborted = false
  const run = callback => scope.run ? scope.run(callback) : callback()
  const notify = callback => run(() => {
    // Observer failures must not prevent transport cleanup or terminal delivery.
    try { callback() } catch {}
  })
  const end = result => {
    if (!ended) {
      ended = true
      if (span) notify(() => span.end(result))
    }
  }
  const wrapped = { ...handler }
  const copied = new Set()
  // Preserve symbol metadata on class handlers, invoking methods on their owner.
  for (let source = handler; source && source !== Object.prototype; source = Object.getPrototypeOf(source)) {
    for (const key of Object.getOwnPropertySymbols(source)) {
      if (!copied.has(key)) {
        copied.add(key)
        const value = handler[key]
        wrapped[key] = typeof value === 'function' ? value.bind(handler) : value
      }
    }
  }
  for (const name of ['onConnect', 'onHeaders', 'onData', 'onComplete', 'onError', 'onUpgrade', 'onBodySent', 'onRequestSent']) {
    if (typeof handler[name] !== 'function') continue
    wrapped[name] = (...args) => {
      if (name === 'onConnect') {
        const abort = args[0]
        args[0] = reason => {
          aborted = true
          return run(() => abort(reason))
        }
      } else if (name === 'onHeaders') {
        if (span?.onHeaders) notify(() => span.onHeaders(args[0]))
        const resume = args[2]
        args[2] = () => run(resume)
      } else if (name === 'onComplete') {
        end({ type: 'complete' })
      } else if (name === 'onUpgrade') {
        if (span?.onHeaders) notify(() => span.onHeaders(args[0]))
        end({ type: 'upgrade' })
      } else if (name === 'onError') {
        end({ type: 'error', error: args[0], aborted })
      }
      return run(() => handler[name](...args))
    }
  }
  return { handler: wrapped, end }
}

function prepareTelemetry (opts, handler, telemetry) {
  if (opts[kPrepared]) return { opts, handler }
  telemetry = opts.telemetry ?? telemetry
  if (telemetry == null || telemetry === false) return { opts, handler }
  if (typeof telemetry.capture !== 'function') {
    throw new InvalidArgumentError('telemetry must have a capture function or be false')
  }
  const context = telemetry.capture()
  const prepared = { ...opts, telemetry: false, [kPrepared]: true, [kContext]: context }
  if (context == null) return { opts: prepared, handler }
  prepared[kFields] = new Set(Object.keys(context.headers ?? {}).map(name => name.toLowerCase()).filter(name => name !== 'request-id'))
  prepared.headers = injectHeaders(opts.headers, context.headers)
  if (context.requestId && !opts.id) {
    // The high-level client's request-id interceptor keeps an explicit header
    // ahead of this inherited id; raw transport calls do not add request-id hops.
    const pairs = injectHeaders(prepared.headers, {})
    const hasId = pairs.some((name, index) => index % 2 === 0 && typeof name === 'string' && name.toLowerCase() === 'request-id' && pairs[index + 1] !== undefined && (!Array.isArray(pairs[index + 1]) || pairs[index + 1].length > 0))
    if (!hasId) {
      prepared.id = context.requestId
      prepared.headers = injectHeaders(prepared.headers, { 'request-id': context.requestId }, true)
    }
  }
  return { opts: prepared, handler: bindHandler(handler, context).handler }
}

function dispatchTelemetry (dispatch, opts, handler) {
  const context = opts[kContext]
  if (context?.start == null) return dispatch(opts, handler)
  const span = context.run(() => context.start(opts))
  if (span == null) return dispatch({ ...opts, [kContext]: undefined }, handler)
  const bound = bindHandler(handler, span.run ? span : context, span)
  try {
    for (const name of Object.keys(span.headers ?? {})) {
      const lower = name.toLowerCase()
      if (lower !== 'request-id' && !opts[kFields].has(lower)) {
        throw new InvalidArgumentError('attempt telemetry headers must be declared in the captured headers')
      }
    }
    const headers = injectHeaders(opts.headers, span.headers)
    const result = (span.run ? span : context).run(() => dispatch({ ...opts, headers, [kContext]: undefined }, bound.handler))
    return result && typeof result.then === 'function'
      ? Promise.resolve(result).catch(error => {
        bound.end({ type: 'error', error, aborted: false })
        throw error
      })
      : result
  } catch (error) {
    bound.end({ type: 'error', error, aborted: false })
    throw error
  }
}

function hasTelemetryContext (opts) {
  return opts[kContext] != null
}

function getTelemetryFields (opts) {
  // Propagation-only fields are already in the key before cache lookup. Only
  // a start hook can regenerate them after that lookup.
  return opts[kContext]?.start == null ? undefined : opts[kFields]
}

module.exports = { setTelemetry, getTelemetry, prepareTelemetry, dispatchTelemetry, hasTelemetryContext, getTelemetryFields }
