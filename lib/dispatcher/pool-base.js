'use strict'

const DispatcherBase = require('./dispatcher-base')
const FixedQueue = require('./fixed-queue')
const { kConnected, kSize, kRunning, kPending, kQueued, kBusy, kFree, kUrl, kClose, kDestroy, kDispatch } = require('../core/symbols')
const PoolStats = require('./pool-stats')

const kClients = Symbol('clients')
const kNeedDrain = Symbol('needDrain')
const kQueue = Symbol('queue')
const kClosedResolve = Symbol('closed resolve')
const kOnDrain = Symbol('onDrain')
const kOnConnect = Symbol('onConnect')
const kOnDisconnect = Symbol('onDisconnect')
const kOnConnectionError = Symbol('onConnectionError')
const kGetDispatcher = Symbol('get dispatcher')
const kAddClient = Symbol('add client')
const kRemoveClient = Symbol('remove client')
const kDetachClient = Symbol('detach client')
const kResumeQueue = Symbol('resume queue')
const kScheduleDrain = Symbol('schedule drain')
const kClientListeners = Symbol('client listeners')
const kDrainScheduled = Symbol('drain scheduled')
const kStats = Symbol('stats')

class PoolBase extends DispatcherBase {
  constructor () {
    super()

    this[kQueue] = new FixedQueue()
    this[kClients] = []
    this[kQueued] = 0
    this[kClientListeners] = new WeakMap()
    this[kDrainScheduled] = new WeakSet()

    const pool = this

    this[kOnDrain] = function onDrain (client, origin, targets) {
      // A client can emit drain immediately after connectionError. Ignore it
      // once the client has been detached so queued work is never dispatched
      // through a client the pool no longer owns.
      if (!pool[kClientListeners].has(client)) {
        return
      }

      const queue = pool[kQueue]

      let needDrain = false

      while (!needDrain) {
        const item = queue.shift()
        if (!item) {
          break
        }
        pool[kQueued]--
        needDrain = !client.dispatch(item.opts, item.handler)
      }

      client[kNeedDrain] = needDrain

      if (!needDrain && pool[kNeedDrain]) {
        pool[kNeedDrain] = false
        pool.emit('drain', origin, [pool, ...targets])
      }

      if (pool[kClosedResolve] && queue.isEmpty()) {
        const closeAll = []
        for (let i = 0; i < pool[kClients].length; i++) {
          const c = pool[kClients][i]
          if (!c.destroyed) {
            closeAll.push(c.close())
          }
        }
        Promise.all(closeAll).then(pool[kClosedResolve])
      }
    }

    this[kOnConnect] = (origin, targets) => {
      pool.emit('connect', origin, [pool, ...targets])
    }

    this[kOnDisconnect] = (origin, targets, err) => {
      pool.emit('disconnect', origin, [pool, ...targets], err)
    }

    this[kOnConnectionError] = (origin, targets, err) => {
      pool.emit('connectionError', origin, [pool, ...targets], err)
    }

    this[kStats] = new PoolStats(this)
  }

  get [kBusy] () {
    return this[kNeedDrain]
  }

  get [kConnected] () {
    return this[kClients].filter(client => client[kConnected]).length
  }

  get [kFree] () {
    return this[kClients].filter(client => client[kConnected] && !client[kNeedDrain]).length
  }

  get [kPending] () {
    let ret = this[kQueued]
    for (const { [kPending]: pending } of this[kClients]) {
      ret += pending
    }
    return ret
  }

  get [kRunning] () {
    let ret = 0
    for (const { [kRunning]: running } of this[kClients]) {
      ret += running
    }
    return ret
  }

  get [kSize] () {
    let ret = this[kQueued]
    for (const { [kSize]: size } of this[kClients]) {
      ret += size
    }
    return ret
  }

  get stats () {
    return this[kStats]
  }

  async [kClose] () {
    if (this[kQueue].isEmpty()) {
      const closeAll = []
      for (let i = 0; i < this[kClients].length; i++) {
        const client = this[kClients][i]
        if (!client.destroyed) {
          closeAll.push(client.close())
        }
      }
      await Promise.all(closeAll)
    } else {
      await new Promise((resolve) => {
        this[kClosedResolve] = resolve
      })
    }
  }

  async [kDestroy] (err) {
    while (true) {
      const item = this[kQueue].shift()
      if (!item) {
        break
      }
      item.handler.onError(err)
    }

    // A close() that parked on kClosedResolve (because the pool queue was
    // non-empty) is otherwise only ever resolved by kOnDrain on a client
    // 'drain' event. Destroyed clients never emit 'drain', so destroying the
    // pool here would leave that close() promise — and every callback queued
    // in dispatcher-base's kOnClosed — pending forever. Resolve it explicitly,
    // mirroring client.js[kDestroy].
    if (this[kClosedResolve]) {
      this[kClosedResolve]()
      this[kClosedResolve] = null
    }

    await Promise.all(this[kClients].map(c => c.destroy(err)))
  }

  [kDispatch] (opts, handler) {
    const dispatcher = this[kGetDispatcher]()

    if (!dispatcher) {
      this[kNeedDrain] = true
      this[kQueue].push({ opts, handler })
      this[kQueued]++
    } else if (!dispatcher.dispatch(opts, handler)) {
      dispatcher[kNeedDrain] = true
      this[kNeedDrain] = !this[kGetDispatcher]()
    }

    return !this[kNeedDrain]
  }

  [kScheduleDrain] (client) {
    if (
      !this[kNeedDrain] ||
      this.destroyed ||
      !this[kClients].includes(client) ||
      client.closed === true ||
      client.destroyed === true ||
      client[kNeedDrain] ||
      this[kDrainScheduled].has(client)
    ) {
      return
    }

    this[kDrainScheduled].add(client)
    queueMicrotask(() => {
      this[kDrainScheduled].delete(client)
      if (
        this[kNeedDrain] &&
        !this.destroyed &&
        this[kClients].includes(client) &&
        client.closed !== true &&
        client.destroyed !== true &&
        !client[kNeedDrain]
      ) {
        this[kOnDrain](client, client[kUrl], [client])
      }
    })
  }

  [kResumeQueue] () {
    if (!this[kNeedDrain] || this.destroyed) {
      return
    }

    const dispatcher = this[kGetDispatcher]()
    if (dispatcher) {
      this[kScheduleDrain](dispatcher)
    }
  }

  [kAddClient] (client) {
    const listeners = {
      drain: this[kOnDrain].bind(this, client),
      connect: this[kOnConnect],
      disconnect: this[kOnDisconnect],
      connectionError: this[kOnConnectionError]
    }
    this[kClientListeners].set(client, listeners)

    client
      .on('drain', listeners.drain)
      .on('connect', listeners.connect)
      .on('disconnect', listeners.disconnect)
      .on('connectionError', listeners.connectionError)

    this[kClients].push(client)
    this[kScheduleDrain](client)

    return this
  }

  [kDetachClient] (client) {
    const listeners = this[kClientListeners].get(client)
    if (listeners) {
      client
        .off('drain', listeners.drain)
        .off('connect', listeners.connect)
        .off('disconnect', listeners.disconnect)
        .off('connectionError', listeners.connectionError)
      this[kClientListeners].delete(client)
    }

    const idx = this[kClients].indexOf(client)
    if (idx === -1) {
      return false
    }

    this[kClients].splice(idx, 1)
    return true
  }

  [kRemoveClient] (client) {
    client.close(() => {
      this[kDetachClient](client)
    })

    this[kNeedDrain] = this[kClients].some(dispatcher => (
      !dispatcher[kNeedDrain] &&
      dispatcher.closed !== true &&
      dispatcher.destroyed !== true
    ))
  }
}

module.exports = {
  PoolBase,
  kClients,
  kNeedDrain,
  kAddClient,
  kRemoveClient,
  kDetachClient,
  kResumeQueue,
  kGetDispatcher
}
