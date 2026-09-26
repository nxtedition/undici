import { type HeaderMap, type IncomingHttpHeaders, util } from '../..'

function headerMapTypes () {
  const headers: HeaderMap = { 'content-type': 'text/plain', 'set-cookie': ['a', 'b'] }
  headers satisfies IncomingHttpHeaders

  // Dynamic reads and copies remain supported; producers must lowercase names.
  const copy: HeaderMap = {}
  for (const [key, value] of Object.entries(headers)) {
    copy[key] = value
  }
  for (const key of Object.keys(copy)) {
    copy[key] satisfies string | string[] | undefined
  }

  // Values that exist are never nullish, while arbitrary lookups can miss.
  for (const value of Object.values(headers)) {
    value satisfies string | string[]
  }
  headers.missing satisfies string | string[] | undefined
  // @ts-expect-error Missing fields require a check with noUncheckedIndexedAccess.
  headers.missing satisfies string | string[]

  // @ts-expect-error A stored header value cannot be undefined.
  const undefinedValue: HeaderMap = { 'x-test': undefined }
  // @ts-expect-error A stored header value cannot be null.
  const nullValue: HeaderMap = { 'x-test': null }
  // @ts-expect-error The literal __proto__ field is excluded.
  const protoField: HeaderMap = { __proto__: ['a', 'b'] }
  // @ts-expect-error Direct __proto__ writes are excluded.
  headers.__proto__ = 'value' // eslint-disable-line no-proto
  // @ts-expect-error Literal indexed __proto__ writes are excluded.
  headers['__proto__'] = ['a', 'b'] // eslint-disable-line no-proto

  const historical: IncomingHttpHeaders = { 'x-test': undefined }
  // @ts-expect-error The historical spelling allows undefined values.
  historical satisfies HeaderMap
  // @ts-expect-error util.parseHeaders was removed.
  util.parseHeaders([])

  undefinedValue satisfies HeaderMap
  nullValue satisfies HeaderMap
  protoField satisfies HeaderMap
}

headerMapTypes satisfies () => void
