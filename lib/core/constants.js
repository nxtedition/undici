'use strict'

/**
 * @see https://developer.mozilla.org/docs/Web/HTTP/Headers
 */
const wellknownHeaderNames = /** @type {const} */ ([
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Accept-Ranges',
  'Access-Control-Allow-Credentials',
  'Access-Control-Allow-Headers',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Origin',
  'Access-Control-Expose-Headers',
  'Access-Control-Max-Age',
  'Access-Control-Request-Headers',
  'Access-Control-Request-Method',
  'Age',
  'Allow',
  'Alt-Svc',
  'Alt-Used',
  'Authorization',
  'Cache-Control',
  'Clear-Site-Data',
  'Connection',
  'Content-Disposition',
  'Content-Encoding',
  'Content-Language',
  'Content-Length',
  'Content-Location',
  'Content-Range',
  'Content-Security-Policy',
  'Content-Security-Policy-Report-Only',
  'Content-Type',
  'Cookie',
  'Cross-Origin-Embedder-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
  'Date',
  'Device-Memory',
  'Downlink',
  'ECT',
  'ETag',
  'Expect',
  'Expect-CT',
  'Expires',
  'Forwarded',
  'From',
  'Host',
  'If-Match',
  'If-Modified-Since',
  'If-None-Match',
  'If-Range',
  'If-Unmodified-Since',
  'Keep-Alive',
  'Last-Modified',
  'Link',
  'Location',
  'Max-Forwards',
  'Origin',
  'Permissions-Policy',
  'Pragma',
  'Proxy-Authenticate',
  'Proxy-Authorization',
  'RTT',
  'Range',
  'Referer',
  'Referrer-Policy',
  'Refresh',
  'Retry-After',
  'Sec-WebSocket-Accept',
  'Sec-WebSocket-Extensions',
  'Sec-WebSocket-Key',
  'Sec-WebSocket-Protocol',
  'Sec-WebSocket-Version',
  'Server',
  'Server-Timing',
  'Service-Worker-Allowed',
  'Service-Worker-Navigation-Preload',
  'Set-Cookie',
  'SourceMap',
  'Strict-Transport-Security',
  'Supports-Loading-Mode',
  'TE',
  'Timing-Allow-Origin',
  'Trailer',
  'Transfer-Encoding',
  'Upgrade',
  'Upgrade-Insecure-Requests',
  'User-Agent',
  'Vary',
  'Via',
  'WWW-Authenticate',
  'X-Content-Type-Options',
  'X-DNS-Prefetch-Control',
  'X-Frame-Options',
  'X-Permitted-Cross-Domain-Policies',
  'X-Powered-By',
  'X-Requested-With',
  'X-XSS-Protection'
])

/**
 * Lowercased response header names that stringifyHTTPHeader returns as
 * preallocated strings, most frequent first: an estimate of the share of
 * responses carrying each name, from HTTP Archive / Web Almanac,
 * webtechsurvey.com response header prevalence, the HPACK and QPACK static
 * tables and the headers the large CDNs and object stores send. The last four
 * are sent by the services undici talks to here (@nxtedition/http, CouchDB and
 * Elasticsearch).
 *
 * stringifyHTTPHeader finds a name with a perfect hash; run
 * `node build/header-name-hash.js` after changing this list.
 */
const wellknownResponseHeaderNames = /** @type {const} */ ([
  'date',
  'content-type',
  'server',
  'content-length',
  'cache-control',
  'last-modified',
  'etag',
  'accept-ranges',
  'expires',
  'vary',
  'access-control-allow-origin',
  'connection',
  'age',
  'content-encoding',
  'x-content-type-options',
  'strict-transport-security',
  'alt-svc',
  'timing-allow-origin',
  'cross-origin-resource-policy',
  'x-frame-options',
  'via',
  'x-cache',
  'cf-ray',
  'transfer-encoding',
  'cf-cache-status',
  'x-xss-protection',
  'keep-alive',
  'report-to',
  'nel',
  'server-timing',
  'pragma',
  'set-cookie',
  'access-control-expose-headers',
  'x-amz-cf-pop',
  'x-amz-cf-id',
  'x-powered-by',
  'content-security-policy',
  'referrer-policy',
  'access-control-allow-credentials',
  'p3p',
  'x-served-by',
  'x-cache-hits',
  'x-timer',
  'x-request-id',
  'link',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'upgrade',
  'x-amz-request-id',
  'x-amz-id-2',
  'location',
  'access-control-max-age',
  'content-disposition',
  'cross-origin-opener-policy',
  'permissions-policy',
  'expect-ct',
  'x-amz-server-side-encryption',
  'x-varnish',
  'content-range',
  'content-language',
  'x-robots-tag',
  'x-ua-compatible',
  'accept-ch',
  'x-litespeed-cache',
  'x-redirect-by',
  'x-pingback',
  'x-cache-status',
  'x-proxy-cache',
  'x-dns-prefetch-control',
  'x-permitted-cross-domain-policies',
  'x-amz-version-id',
  'x-download-options',
  'cross-origin-embedder-policy',
  'content-security-policy-report-only',
  'origin-agent-cluster',
  'retry-after',
  'x-aspnet-version',
  'x-guploader-uploadid',
  'www-authenticate',
  'surrogate-control',
  'cdn-cache-control',
  'cache-status',
  'x-envoy-upstream-service-time',
  'x-nginx-cache',
  'x-vercel-cache',
  'x-vercel-id',
  'x-github-request-id',
  'x-azure-ref',
  'surrogate-key',
  'reporting-endpoints',
  'speculation-rules',
  'sec-websocket-accept',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-runtime',
  'x-amzn-requestid',
  'x-fastly-request-id',
  'x-nf-request-id',
  'x-matched-path',
  'x-drupal-cache',
  'x-generator',
  'x-aspnetmvc-version',
  'x-litespeed-tag',
  'x-turbo-charged-by',
  'x-akamai-transformed',
  'cf-edge-cache',
  'x-amzn-trace-id',
  'x-ms-request-id',
  'x-sucuri-id',
  'x-sucuri-cache',
  'x-iinfo',
  'x-cdn',
  'akamai-grn',
  'status',
  'refresh',
  'feature-policy',
  'allow',
  'x-correlation-id',
  'x-nextjs-prerender',
  'x-goog-hash',
  'x-goog-generation',
  'x-goog-metageneration',
  'x-goog-storage-class',
  'x-goog-stored-content-length',
  'x-goog-stored-content-encoding',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'x-content-security-policy',
  'content-location',
  'proxy-authenticate',
  'trailer',
  'warning',
  'clear-site-data',
  'content-md5',
  'content-digest',
  'repr-digest',
  'ratelimit',
  'ratelimit-policy',
  'accept-patch',
  'accept-post',
  'service-worker-allowed',
  'sourcemap',
  'request-id',
  'x-couch-request-id',
  'x-couchdb-body-time',
  'x-elastic-product'
])

/** @type {Record<typeof wellknownHeaderNames[number]|Lowercase<typeof wellknownHeaderNames[number]>, string>} */
const headerNameLowerCasedRecord = {}

// Note: object prototypes should not be able to be referenced. e.g. `Object#hasOwnProperty`.
Object.setPrototypeOf(headerNameLowerCasedRecord, null)

/**
 * @type {Record<Lowercase<typeof wellknownHeaderNames[number]>, Buffer>}
 */
const wellknownHeaderNameBuffers = {}

// Note: object prototypes should not be able to be referenced. e.g. `Object#hasOwnProperty`.
Object.setPrototypeOf(wellknownHeaderNameBuffers, null)

/**
 * @param {string} header Lowercased header
 * @returns {Buffer}
 */
function getHeaderNameAsBuffer (header) {
  let buffer = wellknownHeaderNameBuffers[header]

  if (buffer === undefined) {
    buffer = Buffer.from(header)
  }

  return buffer
}

for (let i = 0; i < wellknownHeaderNames.length; ++i) {
  const key = wellknownHeaderNames[i]
  const lowerCasedKey = key.toLowerCase()
  headerNameLowerCasedRecord[key] = headerNameLowerCasedRecord[lowerCasedKey] =
    lowerCasedKey
}

module.exports = {
  wellknownHeaderNames,
  wellknownResponseHeaderNames,
  headerNameLowerCasedRecord,
  getHeaderNameAsBuffer
}
