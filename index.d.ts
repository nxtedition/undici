import type { Blob } from 'node:buffer'
import type { EventEmitter } from 'node:events'
import type { IpcNetConnectOpts, Socket, TcpNetConnectOpts } from 'node:net'
import type { ParsedUrlQueryInput } from 'node:querystring'
import type { Readable as NodeReadable } from 'node:stream'
import type { ConnectionOptions, TLSSocket } from 'node:tls'
import type { UrlObject } from 'node:url'

export type URLInput = string | URL | UrlObject

export type IncomingHttpHeaders = Record<string, string | string[] | undefined>

export type HeaderValue = string | number | bigint | boolean | null | undefined

export type HeadersInit =
  | Record<string, HeaderValue | readonly HeaderValue[]>
  | readonly (string | HeaderValue | readonly HeaderValue[])[]
  | Iterable<readonly [string, HeaderValue | readonly HeaderValue[]]>
  | null

export type RequestBodyChunk = string | ArrayBuffer | ArrayBufferView

export type RequestBody =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | NodeJS.ReadableStream
  | Iterable<RequestBodyChunk>
  | AsyncIterable<RequestBodyChunk>
  | Blob
  | null

/** A structural EventTarget-style signal accepted by request() and Readable.dump(). */
export interface AbortSignalLike {
  readonly aborted: boolean
  readonly reason?: unknown
  addEventListener(type: 'abort', listener: (event: Event) => void, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: 'abort', listener: (event: Event) => void, options?: boolean | EventListenerOptions): void
}

/** A structural EventEmitter-style signal accepted by request(). */
export interface AbortEventEmitterLike {
  readonly aborted?: boolean
  readonly reason?: unknown
  on(event: 'abort', listener: () => void): unknown
  once(event: 'abort', listener: () => void): unknown
  removeListener(event: 'abort', listener: () => void): unknown
}

export type RequestSignal = AbortSignal | AbortSignalLike | AbortEventEmitterLike

export interface RequestErrorData<TOpaque = null> {
  opaque: TOpaque | null | undefined
}

export type RequestCallback<TOpaque = null> = (
  error: unknown,
  data: Dispatcher.ResponseData<TOpaque> | RequestErrorData<TOpaque>
) => void

/** The core dispatcher API implemented by Client, Pool, Agent, and custom dispatchers. */
export class Dispatcher extends EventEmitter<Dispatcher.EventMap> {
  dispatch (options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean

  request<TOpaque = null>(options: Dispatcher.RequestOptions<TOpaque>): Promise<Dispatcher.ResponseData<TOpaque>>
  request<TOpaque = null>(options: Dispatcher.RequestOptions<TOpaque>, callback: RequestCallback<TOpaque>): void

  close (): Promise<null>
  close (callback: Dispatcher.CompletionCallback): void

  destroy (): Promise<null>
  destroy (callback: Dispatcher.CompletionCallback): void
  destroy (reason: unknown): Promise<null>
  destroy (reason: unknown, callback: Dispatcher.CompletionCallback): void
}

export namespace Dispatcher {
  type CompletionCallback = (error: unknown, data: null) => void

  interface EventMap {
    connect: [origin: URL, targets: readonly Dispatcher[]]
    disconnect: [origin: URL, targets: readonly Dispatcher[], error: unknown]
    connectionError: [origin: URL, targets: readonly Dispatcher[], error: unknown]
    drain: [origin: URL, targets: readonly Dispatcher[]]
  }

  interface DispatchOptions {
    origin?: string | URL
    path: string
    method: string
    body?: RequestBody
    headers?: HeadersInit
    query?: ParsedUrlQueryInput
    idempotent?: boolean
    blocking?: boolean
    typeOfService?: number | null
    /** Protocol name for an upgrade request. */
    upgrade?: string | null
    /**
     * The time, in milliseconds, allowed to receive complete response headers.
     * Use `0` to disable it. HTTP/1.1 parser timeouts use lower-overhead fast
     * timers with a target resolution around 500 ms, so they are not guaranteed
     * to fire with exact millisecond precision.
     */
    headersTimeout?: number | null
    /**
     * The time, in milliseconds, allowed between response body chunks. Use `0`
     * to disable it. HTTP/1.1 parser timeouts use lower-overhead fast timers
     * with a target resolution around 500 ms, so they are not guaranteed to
     * fire with exact millisecond precision.
     */
    bodyTimeout?: number | null
    reset?: boolean | null
    expectContinue?: boolean | null
    servername?: string | null
  }

  interface RequestOptions<TOpaque = null> extends Omit<DispatchOptions, 'upgrade'> {
    /** Passed through on successful responses; nullish values are normalized to null. */
    opaque?: TOpaque
    signal?: RequestSignal | null
    highWaterMark?: number | null
    /** The high-level request API does not support protocol upgrades. */
    upgrade?: null
    /** This reduced build does not implement throwOnError. */
    throwOnError?: null
  }

  interface ResponseData<TOpaque = null> {
    statusCode: number
    headers: IncomingHttpHeaders
    trailers: IncomingHttpHeaders
    /** The request opaque value, with null and undefined normalized to null. */
    opaque: TOpaque extends null | undefined ? null : TOpaque
    body: Readable
    context: unknown
  }

  interface DispatchHandlerBase {
    /** Called before bytes are written. The callback accepts arbitrary abort reasons. */
    onConnect(abort: (reason?: unknown) => void, context?: unknown): void
    onError(error: unknown): void
  }

  interface ResponseDispatchHandler extends DispatchHandlerBase {
    onHeaders(statusCode: number, headers: IncomingHttpHeaders, resume: () => void): boolean | void
    onData(chunk: Buffer): boolean | void
    onComplete(trailers: IncomingHttpHeaders): void
    onUpgrade?(statusCode: number, headers: IncomingHttpHeaders, socket: Socket): void
  }

  interface UpgradeDispatchHandler extends DispatchHandlerBase {
    onUpgrade(statusCode: number, headers: IncomingHttpHeaders, socket: Socket): void
    onHeaders?(statusCode: number, headers: IncomingHttpHeaders, resume: () => void): boolean | void
    onData?(chunk: Buffer): boolean | void
    onComplete?(trailers: IncomingHttpHeaders): void
  }

  type DispatchHandler = ResponseDispatchHandler | UpgradeDispatchHandler
}

/** A single-origin HTTP/1.1 dispatcher backed by one connection. */
export class Client extends Dispatcher {
  constructor (origin: URLInput, options?: Client.Options)

  pipelining: number
  readonly closed: boolean
  readonly destroyed: boolean
}

export namespace Client {
  interface Options {
    maxHeaderSize?: number
    /**
     * The time, in milliseconds, allowed to receive complete response headers.
     * Use `0` to disable it. Defaults to 300 seconds. HTTP/1.1 parser timeouts
     * use lower-overhead fast timers with a target resolution around 500 ms, so
     * they are not guaranteed to fire with exact millisecond precision.
     */
    headersTimeout?: number
    connectTimeout?: number
    /**
     * The time, in milliseconds, allowed between response body chunks. Use `0`
     * to disable it. Defaults to 300 seconds. HTTP/1.1 parser timeouts use
     * lower-overhead fast timers with a target resolution around 500 ms, so they
     * are not guaranteed to fire with exact millisecond precision.
     */
    bodyTimeout?: number
    keepAliveTimeout?: number
    keepAliveMaxTimeout?: number
    keepAliveTimeoutThreshold?: number
    socketPath?: string
    pipelining?: number
    strictContentLength?: boolean
    maxCachedSessions?: number
    connect?: buildConnector.BuildOptions | buildConnector.Connector
    tls?: buildConnector.BuildOptions
    maxRequestsPerClient?: number
    localAddress?: string
    maxResponseSize?: number
    autoSelectFamily?: boolean
    autoSelectFamilyAttemptTimeout?: number

    /** Unsupported by this HTTP/1.1-only build. */
    allowH2?: false | null
    /** Unsupported by this HTTP/1.1-only build. */
    maxConcurrentStreams?: null
    /** Unsupported; use headersTimeout and bodyTimeout. */
    socketTimeout?: never
    /** Unsupported; use headersTimeout and bodyTimeout. */
    requestTimeout?: never
    /** Unsupported; use keepAliveTimeout. */
    idleTimeout?: never
    /** Unsupported; use pipelining = 0. */
    keepAlive?: never
    /** Unsupported; use keepAliveMaxTimeout. */
    maxKeepAliveTimeout?: never
  }

  interface SocketInfo {
    localAddress?: string
    localPort?: number
    remoteAddress?: string
    remotePort?: number
    remoteFamily?: string
    timeout?: number
    bytesWritten?: number
    bytesRead?: number
  }
}

/** A single-origin dispatcher that manages a set of clients. */
export class Pool extends Dispatcher {
  constructor (origin: URLInput, options?: Pool.Options)

  readonly closed: boolean
  readonly destroyed: boolean
  readonly stats: Pool.Stats
}

export namespace Pool {
  interface Options extends Client.Options {
    connections?: number | null
    factory?(origin: URL, options: Client.Options): Dispatcher
  }

  interface Stats {
    readonly connected: number
    readonly free: number
    readonly pending: number
    readonly queued: number
    readonly running: number
    readonly size: number
  }
}

/** A multi-origin dispatcher that lazily creates a dispatcher for each origin. */
export class Agent extends Dispatcher {
  constructor (options?: Agent.Options)

  readonly closed: boolean
  readonly destroyed: boolean

  dispatch (options: Agent.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean
  request<TOpaque = null>(options: Agent.RequestOptions<TOpaque>): Promise<Dispatcher.ResponseData<TOpaque>>
  request<TOpaque = null>(options: Agent.RequestOptions<TOpaque>, callback: RequestCallback<TOpaque>): void
}

export namespace Agent {
  interface Options extends Omit<Pool.Options, 'factory'> {
    factory?(origin: string | URL, options: Omit<Pool.Options, 'factory'>): Dispatcher
  }

  interface DispatchOptions extends Dispatcher.DispatchOptions {
    origin: string | URL
  }

  interface RequestOptions<TOpaque = null> extends Dispatcher.RequestOptions<TOpaque> {
    origin: string | URL
  }
}

export interface ReadableOptions {
  resume(this: NodeReadable, size: number): void
  abort(reason?: unknown): void | null
  contentType?: string
  contentLength?: number | null
  highWaterMark?: number
}

/** The response body stream returned by request(). */
export class Readable extends NodeReadable {
  constructor (options: ReadableOptions)

  readonly bodyUsed: boolean
  text (): Promise<string>
  json (): Promise<unknown>
  blob (): Promise<Blob>
  bytes (): Promise<Uint8Array>
  arrayBuffer (): Promise<ArrayBuffer>
  formData (): Promise<never>
  dump (options?: { limit?: number, signal?: AbortSignal | AbortSignalLike } | null): Promise<null>
  setEncoding (encoding: BufferEncoding): this
}

export function buildConnector (options?: buildConnector.BuildOptions): buildConnector.Connector

export namespace buildConnector {
  type BuildOptions = Partial<ConnectionOptions> &
    Partial<TcpNetConnectOpts> &
    Partial<IpcNetConnectOpts> & {
      maxCachedSessions?: number | null
      socketPath?: string | null
      timeout?: number | null
      keepAlive?: boolean | null
      keepAliveInitialDelay?: number | null
    }

  interface Options {
    hostname: string
    host?: string
    protocol: 'http:' | 'https:' | string
    port?: string | number
    servername?: string | null
    localAddress?: string | null
    socketPath?: string | null
    httpSocket?: Socket
  }

  type Callback = (error: unknown, socket?: Socket | TLSSocket) => void

  interface Connector {
    (options: Options, callback: Callback): Socket | TLSSocket | void
  }
}

export namespace errors {
  class UndiciError extends Error {
    constructor (message?: string, options?: ErrorOptions)
    name: string
    code: string
  }

  class ConnectTimeoutError extends UndiciError {
    name: 'ConnectTimeoutError'
    code: 'UND_ERR_CONNECT_TIMEOUT'
  }

  class HeadersTimeoutError extends UndiciError {
    name: 'HeadersTimeoutError'
    code: 'UND_ERR_HEADERS_TIMEOUT'
  }

  class HeadersOverflowError extends UndiciError {
    name: 'HeadersOverflowError'
    code: 'UND_ERR_HEADERS_OVERFLOW'
  }

  class BodyTimeoutError extends UndiciError {
    name: 'BodyTimeoutError'
    code: 'UND_ERR_BODY_TIMEOUT'
  }

  class ResponseStatusCodeError extends UndiciError {
    constructor (message?: string, statusCode?: number, headers?: IncomingHttpHeaders | null, body?: unknown)
    name: 'ResponseStatusCodeError'
    code: 'UND_ERR_RESPONSE_STATUS_CODE'
    status: number | undefined
    statusCode: number | undefined
    headers: IncomingHttpHeaders | null | undefined
    body: unknown
  }

  class InvalidArgumentError extends UndiciError {
    name: 'InvalidArgumentError'
    code: 'UND_ERR_INVALID_ARG'
  }

  class InvalidReturnValueError extends UndiciError {
    name: 'InvalidReturnValueError'
    code: 'UND_ERR_INVALID_RETURN_VALUE'
  }

  class AbortError extends UndiciError {
    name: 'AbortError'
  }

  class RequestAbortedError extends AbortError {
    name: 'AbortError'
    code: 'UND_ERR_ABORTED'
  }

  class InformationalError extends UndiciError {
    name: 'InformationalError'
    code: 'UND_ERR_INFO'
  }

  class RequestContentLengthMismatchError extends UndiciError {
    name: 'RequestContentLengthMismatchError'
    code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH'
  }

  class ResponseContentLengthMismatchError extends UndiciError {
    name: 'ResponseContentLengthMismatchError'
    code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH'
  }

  class ClientDestroyedError extends UndiciError {
    name: 'ClientDestroyedError'
    code: 'UND_ERR_DESTROYED'
  }

  class ClientClosedError extends UndiciError {
    name: 'ClientClosedError'
    code: 'UND_ERR_CLOSED'
  }

  class SocketError extends UndiciError {
    constructor (message?: string, socket?: Client.SocketInfo | null)
    name: 'SocketError'
    code: 'UND_ERR_SOCKET'
    socket: Client.SocketInfo | null | undefined
  }

  class NotSupportedError extends UndiciError {
    name: 'NotSupportedError'
    code: 'UND_ERR_NOT_SUPPORTED'
  }

  class BalancedPoolMissingUpstreamError extends UndiciError {
    name: 'MissingUpstreamError'
    code: 'UND_ERR_BPL_MISSING_UPSTREAM'
  }

  class HTTPParserError extends Error {
    constructor (message?: string, code?: string, data?: string | Buffer)
    name: 'HTTPParserError'
    code: string | undefined
    data: string | undefined
  }

  class ResponseExceededMaxSizeError extends UndiciError {
    name: 'ResponseExceededMaxSizeError'
    code: 'UND_ERR_RES_EXCEEDED_MAX_SIZE'
  }

  class RequestRetryError extends UndiciError {
    constructor (message: string | undefined, statusCode: number, options: { headers: IncomingHttpHeaders, data: unknown })
    name: 'RequestRetryError'
    code: 'UND_ERR_REQ_RETRY'
    statusCode: number
    data: unknown
    headers: IncomingHttpHeaders
  }

  class ResponseError extends UndiciError {
    constructor (message: string | undefined, statusCode: number, options: { headers: IncomingHttpHeaders, body: unknown })
    name: 'ResponseError'
    code: 'UND_ERR_RESPONSE'
    statusCode: number
    body: unknown
    headers: IncomingHttpHeaders
  }

  class SecureProxyConnectionError extends UndiciError {
    constructor (cause?: unknown, message?: string, options?: ErrorOptions)
    name: 'SecureProxyConnectionError'
    code: 'UND_ERR_PRX_TLS'
    cause: unknown
  }
}

export namespace util {
  function headerNameToString (value: string | Buffer): string

  function parseHeaders (headers: readonly (Buffer | string | readonly (Buffer | string)[])[]): IncomingHttpHeaders
  function parseHeaders<T extends IncomingHttpHeaders> (
    headers: readonly (Buffer | string | readonly (Buffer | string)[])[],
    object: T
  ): T
}

export interface TopLevelRequestOptions<TOpaque = null>
  extends Omit<Dispatcher.RequestOptions<TOpaque>, 'origin' | 'path' | 'method'> {
  dispatcher?: Dispatcher
  /** Replaces the path contained in the URL. */
  path?: string
  method?: string
  /** Unsupported; use dispatcher. */
  agent?: never
}

export function request<TOpaque = null> (
  url: URLInput,
  options?: TopLevelRequestOptions<TOpaque>
): Promise<Dispatcher.ResponseData<TOpaque>>
export function request<TOpaque = null> (
  url: URLInput,
  callback: RequestCallback<TOpaque>
): void
export function request<TOpaque = null> (
  url: URLInput,
  options: TopLevelRequestOptions<TOpaque>,
  callback: RequestCallback<TOpaque>
): void

export function setGlobalDispatcher (dispatcher: Dispatcher): void
export function getGlobalDispatcher (): Dispatcher

declare const Undici: {
  Dispatcher: typeof Dispatcher
  Client: typeof Client
  Pool: typeof Pool
  Agent: typeof Agent
  Readable: typeof Readable
  buildConnector: typeof buildConnector
  errors: typeof errors
  util: typeof util
  setGlobalDispatcher: typeof setGlobalDispatcher
  getGlobalDispatcher: typeof getGlobalDispatcher
  request: typeof request
}

export default Undici
