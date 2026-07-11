import { Blob } from 'node:buffer'
import { EventEmitter } from 'node:events'
import undici, {
  Agent,
  Client,
  Dispatcher,
  Pool,
  Readable,
  buildConnector,
  errors,
  getGlobalDispatcher,
  request,
  setGlobalDispatcher,
  util
} from '../..'
import undiciRequire = require('../..')

function acceptsUnknown (_value: unknown) {}

async function types () {
  const client = new Client('http://localhost', {
    socketPath: '/tmp/undici.sock',
    connect (options, callback) {
      options.socketPath?.toUpperCase()
      callback(new Error('fixture'))
    },
    allowH2: false
  })

  client.pipelining = 2
  client.closed satisfies boolean
  client.destroyed satisfies boolean

  const handler: Dispatcher.DispatchHandler = {
    onConnect (abort) {
      abort(false)
    },
    onHeaders (statusCode, headers, resume) {
      statusCode.toFixed()
      headers['content-type']?.toString()
      resume()
      return true
    },
    onData (chunk) {
      return chunk.byteLength > 0
    },
    onComplete (trailers) {
      trailers.date?.toString()
    },
    onError (reason) {
      acceptsUnknown(reason)
    }
  }

  client.dispatch({
    path: '/',
    method: 'POST',
    headers: new Headers([['x-test', 'yes']]),
    body: (async function * () {
      yield 'hello'
      yield Buffer.from(' world')
    })(),
    upgrade: null,
    typeOfService: 16
  }, handler)

  client.dispatch({
    path: '/',
    method: 'GET',
    upgrade: 'websocket'
  }, {
    onConnect (abort) {
      abort({ application: 'reason' })
    },
    onUpgrade (statusCode, headers, socket) {
      statusCode.toFixed()
      headers.connection?.toString()
      socket.destroy()
    },
    onError (reason) {
      acceptsUnknown(reason)
    }
  })

  const eventEmitterSignal = new EventEmitter()
  const eventTargetSignal = {
    aborted: false,
    reason: 0,
    addEventListener (_type: 'abort', _listener: (event: Event) => void) {},
    removeEventListener (_type: 'abort', _listener: (event: Event) => void) {}
  }
  const opaque = { requestId: 42 } as const

  const response = await client.request({
    path: '/',
    method: 'GET',
    opaque,
    signal: eventEmitterSignal
  })

  response.opaque.requestId satisfies 42
  response.context satisfies unknown
  response.headers.date?.toString()
  response.trailers.date?.toString()
  await response.body.dump({ limit: 1024, signal: AbortSignal.timeout(10) }) satisfies null
  await response.body.dump({ signal: eventTargetSignal }) satisfies null
  await response.body.text() satisfies string
  await response.body.json() satisfies unknown
  await response.body.blob() satisfies Blob
  await response.body.bytes() satisfies Uint8Array
  await response.body.arrayBuffer() satisfies ArrayBuffer

  const omittedOpaqueResponse = await client.request({
    path: '/',
    method: 'GET'
  })
  omittedOpaqueResponse.opaque satisfies null

  const undefinedOpaqueResponse = await client.request({
    path: '/',
    method: 'GET',
    opaque: undefined
  })
  undefinedOpaqueResponse.opaque satisfies null

  const optionalOpaque: string | undefined = Math.random() > 0.5 ? 'value' : undefined
  const optionalOpaqueResponse = await client.request({
    path: '/',
    method: 'GET',
    opaque: optionalOpaque
  })
  optionalOpaqueResponse.opaque satisfies string | null

  client.request({ path: '/', method: 'GET', opaque: 0 }, (error, data) => {
    acceptsUnknown(error)
    data.opaque satisfies number | null | undefined
  })

  const pool = new Pool(new URL('http://localhost'), {
    connections: 2,
    socketPath: '/tmp/undici.sock',
    factory (origin, options) {
      origin satisfies URL
      return new Client(origin, options)
    }
  })

  pool.stats.connected satisfies number
  pool.stats.free satisfies number
  pool.stats.pending satisfies number
  pool.stats.queued satisfies number
  pool.stats.running satisfies number
  pool.stats.size satisfies number

  const agent = new Agent({
    factory (origin, options) {
      return new Pool(origin, options)
    }
  })

  agent.dispatch({ origin: 'http://localhost', path: '/', method: 'GET' }, handler)
  await agent.request({ origin: new URL('http://localhost'), path: '/', method: 'GET' })

  const customDispatcher: Dispatcher = agent
  setGlobalDispatcher(customDispatcher)
  getGlobalDispatcher() satisfies Dispatcher

  await request('http://localhost/path', {
    path: '/replacement',
    method: 'PUT',
    dispatcher: pool,
    body: new Blob(['body']),
    signal: AbortSignal.abort('arbitrary reason'),
    opaque: Symbol('opaque')
  }) satisfies Dispatcher.ResponseData<symbol>

  // @ts-expect-error Legacy structural BlobLike shims are no longer accepted.
  await request('http://localhost/path', {
    method: 'POST',
    body: {
      [Symbol.toStringTag]: 'Blob',
      async arrayBuffer () {
        return new ArrayBuffer(0)
      }
    }
  })

  request('http://localhost', (error, data) => {
    acceptsUnknown(error)
    data.opaque satisfies null | undefined
  })

  request('http://localhost', { opaque: 'value' }, (error, data) => {
    acceptsUnknown(error)
    data.opaque satisfies string | null | undefined
  })

  const connector = buildConnector({
    socketPath: '/tmp/undici.sock',
    timeout: 1000,
    maxCachedSessions: 0,
    rejectUnauthorized: false
  })

  connector({ hostname: 'localhost', protocol: 'http:', socketPath: '/tmp/undici.sock' }, (error, socket) => {
    if (error === null && socket) {
      socket.destroy()
    }
  })

  util.headerNameToString(Buffer.from('Content-Type')) satisfies string
  const parsed = util.parseHeaders([Buffer.from('x-test'), Buffer.from('yes')], { existing: 'value' })
  parsed.existing satisfies string

  const body = new Readable({
    resume () {},
    abort (reason) {
      acceptsUnknown(reason)
    }
  })
  body.setEncoding('utf8')
  await body.dump({ limit: 1 }) satisfies null

  new errors.ConnectTimeoutError().code satisfies 'UND_ERR_CONNECT_TIMEOUT'
  new errors.AbortError().name satisfies 'AbortError'
  new errors.HTTPParserError('bad', 'INVALID', Buffer.from('data')).data satisfies string | undefined

  undici.Client satisfies typeof Client
  undici.Dispatcher satisfies typeof Dispatcher
  undici.request satisfies typeof request
  undiciRequire.Pool satisfies typeof Pool

  await client.close() satisfies null
  await pool.destroy({ arbitrary: 'reason' }) satisfies null
  client.destroy(() => {}) satisfies void

  // @ts-expect-error H2 is intentionally unavailable in this build.
  const invalidH2Client = new Client('http://localhost', { allowH2: true })
  invalidH2Client satisfies Client

  // @ts-expect-error The high-level request API cannot upgrade protocols.
  client.request({ path: '/', method: 'GET', upgrade: 'websocket' })

  // @ts-expect-error Agent requests require an origin.
  agent.request({ path: '/', method: 'GET' })

  // @ts-expect-error The reduced runtime does not export fetch.
  const unsupportedFetch = undici.fetch
  acceptsUnknown(unsupportedFetch)

  // @ts-expect-error Request headers cannot contain object values.
  client.request({ path: '/', method: 'GET', headers: { invalid: {} } })

  // @ts-expect-error A response handler must implement the complete callback lifecycle.
  client.dispatch({ path: '/', method: 'GET' }, { onConnect () {}, onError () {} })
}

types satisfies () => Promise<void>

// Keep this fixture a module even if imports are mechanically changed.
export {}
