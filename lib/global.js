'use strict'

// We include a version number for the Dispatcher API. In case of breaking changes,
// this version number must be increased to avoid conflicts.
const globalDispatcher = Symbol.for('nxtedition.globalDispatcher.2')
const { InvalidArgumentError } = require('./core/errors')
const Agent = require('./dispatcher/agent')

let fallbackDispatcher

if (getGlobalDispatcher() === undefined) {
  setGlobalDispatcher(new Agent())
}

function setGlobalDispatcher (agent) {
  if (!agent || typeof agent.dispatch !== 'function') {
    throw new InvalidArgumentError('Argument agent must implement Agent')
  }

  try {
    Object.defineProperty(globalThis, globalDispatcher, {
      value: agent,
      writable: true,
      enumerable: false,
      configurable: false
    })
  } catch (err) {
    if (err instanceof TypeError) {
      fallbackDispatcher = agent
      return
    }
    throw err
  }

  fallbackDispatcher = undefined
}

function getGlobalDispatcher () {
  // A frozen global can retain the previous dispatcher after a later set, so
  // a successfully stored fallback must take precedence over the global slot.
  return fallbackDispatcher ?? globalThis[globalDispatcher]
}

module.exports = {
  setGlobalDispatcher,
  getGlobalDispatcher
}
