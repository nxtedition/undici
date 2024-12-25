'use strict'

const diagnosticsChannel = require('node:diagnostics_channel')
const util = require('node:util')

const undiciDebugLog = util.debuglog('undici')

const channels = {
  // Client
  beforeConnect: diagnosticsChannel.channel('undici:client:beforeConnect'),
  connected: diagnosticsChannel.channel('undici:client:connected'),
  connectError: diagnosticsChannel.channel('undici:client:connectError'),
  sendHeaders: diagnosticsChannel.channel('undici:client:sendHeaders'),
  // Request
  create: diagnosticsChannel.channel('undici:request:create'),
  headers: diagnosticsChannel.channel('undici:request:headers'),
  trailers: diagnosticsChannel.channel('undici:request:trailers'),
  error: diagnosticsChannel.channel('undici:request:error')
}

let isTrackingClientEvents = false

function trackClientEvents (debugLog = undiciDebugLog) {
  if (isTrackingClientEvents) {
    return
  }

  isTrackingClientEvents = true

  diagnosticsChannel.subscribe('undici:client:beforeConnect',
    evt => {
      const {
        connectParams: { version, protocol, port, host }
      } = evt
      debugLog(
        'connecting to %s%s using %s%s',
        host,
        port ? `:${port}` : '',
        protocol,
        version
      )
    })

  diagnosticsChannel.subscribe('undici:client:connected',
    evt => {
      const {
        connectParams: { version, protocol, port, host }
      } = evt
      debugLog(
        'connected to %s%s using %s%s',
        host,
        port ? `:${port}` : '',
        protocol,
        version
      )
    })

  diagnosticsChannel.subscribe('undici:client:connectError',
    evt => {
      const {
        connectParams: { version, protocol, port, host },
        error
      } = evt
      debugLog(
        'connection to %s%s using %s%s errored - %s',
        host,
        port ? `:${port}` : '',
        protocol,
        version,
        error.message
      )
    })

  diagnosticsChannel.subscribe('undici:client:sendHeaders',
    evt => {
      const {
        request: { method, path, origin }
      } = evt
      debugLog('sending request to %s %s/%s', method, origin, path)
    })
}

let isTrackingRequestEvents = false

function trackRequestEvents (debugLog = undiciDebugLog) {
  if (isTrackingRequestEvents) {
    return
  }

  isTrackingRequestEvents = true

  diagnosticsChannel.subscribe('undici:request:headers',
    evt => {
      const {
        request: { method, path, origin },
        response: { statusCode }
      } = evt
      debugLog(
        'received response to %s %s/%s - HTTP %d',
        method,
        origin,
        path,
        statusCode
      )
    })

  diagnosticsChannel.subscribe('undici:request:trailers',
    evt => {
      const {
        request: { method, path, origin }
      } = evt
      debugLog('trailers received from %s %s/%s', method, origin, path)
    })

  diagnosticsChannel.subscribe('undici:request:error',
    evt => {
      const {
        request: { method, path, origin },
        error
      } = evt
      debugLog(
        'request to %s %s/%s errored - %s',
        method,
        origin,
        path,
        error.message
      )
    })
}

if (undiciDebugLog.enabled) {
  trackClientEvents(undiciDebugLog)
  trackRequestEvents(undiciDebugLog)
}

module.exports = {
  channels
}
