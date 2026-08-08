'use strict'

const EventEmitter = require('node:events')

class Dispatcher extends EventEmitter {
  dispatch () {
    throw new Error('not implemented')
  }

  close () {
    throw new Error('not implemented')
  }

  destroy () {
    throw new Error('not implemented')
  }

  [Symbol.asyncDispose] () {
    this.destroy()
  }
}

module.exports = Dispatcher
