'use strict'

// Registry of live sockets opened by `Client#connect`, keyed by socket. The
// value is the connect options plus the pool `origin`.
//
// `@nxtedition/app`'s monitor reads this to report `undici.sockets` and, from
// the recorded origins, the per-origin breakdown. The bare count on its own is
// not actionable: a process that holds several pools can pile up thousands of
// sockets and the alert cannot say against WHICH upstream, so diagnosing it
// means reading code paths instead of stats.
//
// Published on a `Symbol.for` slot rather than a bare `__undici_sockets` global
// so the contract is namespaced, greppable and cannot collide with an unrelated
// global. `__undici_sockets` remains as a deprecated alias onto the SAME Map so
// a reader pinned to an older `@nxtedition/app` keeps working across a rollout.

const kSockets = Symbol.for('@nxtedition/undici/sockets')
const kLegacyName = '__undici_sockets'

const legacyDescriptor = Object.getOwnPropertyDescriptor(globalThis, kLegacyName)

// Absorb a Map published by an older copy of this package that happened to be
// evaluated first. Without this the two copies keep separate registries and
// every consumer undercounts by whatever the other copy owns.
const legacyValue = legacyDescriptor?.value
const sockets = (globalThis[kSockets] ??=
  legacyValue instanceof Map ? legacyValue : new Map())

// An older copy evaluated *after* us runs `globalThis.__undici_sockets ??= new Map()`.
// The getter below makes that read non-nullish, so `??=` normally short-circuits
// and never assigns — but a plain `=` from any other holdout must not replace the
// shared registry, and must not throw either (assigning to a getter-only property
// is a TypeError in strict-mode module code). Absorb the entries and discard the
// container, the way nxt-undici's dispatcher-stats provider handshake does.
// A non-configurable legacy property cannot be safely replaced. Reuse its Map
// above when possible, but do not make importing this package fail by trying to
// redefine it.
if (legacyDescriptor?.configurable !== false) {
  Object.defineProperty(globalThis, kLegacyName, {
    configurable: true,
    enumerable: legacyDescriptor?.enumerable ?? true,
    get () {
      return sockets
    },
    set (value) {
      if (value instanceof Map && value !== sockets) {
        for (const [socket, options] of value) {
          sockets.set(socket, options)
        }
      }
    }
  })
}

/**
 * Record a freshly connected socket until it closes.
 *
 * @param {import('node:net').Socket} socket
 * @param {string} origin Pool origin the socket belongs to, e.g. `http://tasks.query:6500`.
 * @param {object} options Connect options (host, hostname, protocol, port, ...).
 */
function trackSocket (socket, origin, options) {
  sockets.set(socket, { ...options, origin })
  socket.on('close', () => {
    sockets.delete(socket)
  })
}

module.exports = { kSockets, sockets, trackSocket }
