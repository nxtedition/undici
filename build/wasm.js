'use strict'

const { execSync, execFileSync } = require('node:child_process')
const { writeFileSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '../')
const WASM_SRC = resolve(__dirname, '../deps/llhttp')
const WASM_OUT = resolve(__dirname, '../lib/llhttp')

// These are defined by build environment
const WASM_CC = process.env.WASM_CC || 'clang'
let WASM_CFLAGS = process.env.WASM_CFLAGS || '--sysroot=/usr/share/wasi-sysroot -target wasm32-unknown-wasi'
let WASM_LDFLAGS = process.env.WASM_LDFLAGS || ''
const WASM_LDLIBS = process.env.WASM_LDLIBS || ''
const WASM_OPT = process.env.WASM_OPT || 'wasm-opt'

// For compatibility with Node.js' `configure --shared-builtin-undici/undici-path ...`
const EXTERNAL_PATH = process.env.EXTERNAL_PATH

// These are relevant for undici and should not be overridden
WASM_CFLAGS += ' -Ofast -fno-exceptions -fvisibility=hidden -mexec-model=reactor'
WASM_LDFLAGS += ' -Wl,-error-limit=0 -Wl,-O3 -Wl,--lto-O3 -Wl,--strip-all'
WASM_LDFLAGS += ' -Wl,--allow-undefined -Wl,--export-dynamic -Wl,--export-table'
WASM_LDFLAGS += ' -Wl,--export=malloc -Wl,--export=free -Wl,--no-entry'

const WASM_OPT_FLAGS = '-O4 --converge --strip-debug --strip-dwarf --strip-producers'
const wasmOptFlags = WASM_OPT_FLAGS.split(/\s+/).filter(Boolean)

const writeWasmChunk = (path, dest) => {
  const base64 = readFileSync(join(WASM_OUT, path)).toString('base64')
  writeFileSync(join(WASM_OUT, dest), `'use strict'

const { Buffer } = require('node:buffer')

const wasmBase64 = '${base64}'

let wasmBuffer

Object.defineProperty(module, 'exports', {
  get: () => {
    return wasmBuffer
      ? wasmBuffer
      : (wasmBuffer = Buffer.from(wasmBase64, 'base64'))
  }
})
`)
}

if (process.argv[2] === '--docker') {
  // The upstream arm64 image lacks Binaryen 116. Always use the pinned amd64
  // toolchain so Docker builds optimize identically on every host.
  const image = execFileSync('docker', [
    'build', '--platform=linux/amd64', '--quiet', '-f', join(__dirname, 'Dockerfile'), __dirname
  ], { encoding: 'utf8' }).trim()
  const args = ['run', '--rm', '--platform=linux/amd64']
  if (process.platform === 'linux') {
    args.push('--user', `${process.getuid()}:${process.getegid()}`)
  }
  for (const dir of ['lib/llhttp', 'build', 'deps']) {
    args.push('--mount', `type=bind,source=${join(ROOT, dir)},target=/home/node/build/${dir}`)
  }
  args.push(image, 'node', 'build/wasm.js')
  execFileSync('docker', args, { stdio: 'inherit' })
  process.exit(0)
}

const hasApk = (function () {
  try { execSync('command -v apk'); return true } catch { return false }
})()
// Do not silently generate different, unoptimized artifacts when it is absent.
execFileSync(WASM_OPT, ['--version'], { stdio: 'inherit' })
if (hasApk) {
  // Gather information about the tools used for the build
  const buildInfo = execSync('apk info -v').toString()
  if (!buildInfo.includes('wasi-sdk')) {
    throw new Error('Failed to generate build environment information')
  }
  console.log(buildInfo)
}

// Build wasm binary
execSync(`${WASM_CC} ${WASM_CFLAGS} ${WASM_LDFLAGS} \
${join(WASM_SRC, 'src')}/*.c \
-I${join(WASM_SRC, 'include')} \
-o ${join(WASM_OUT, 'llhttp.wasm')} \
${WASM_LDLIBS}`, { stdio: 'inherit' })

execFileSync(WASM_OPT, [...wasmOptFlags, '-o', join(WASM_OUT, 'llhttp.wasm'), join(WASM_OUT, 'llhttp.wasm')], { stdio: 'inherit' })
writeWasmChunk('llhttp.wasm', 'llhttp-wasm.js')

// Build wasm simd binary
execSync(`${WASM_CC} ${WASM_CFLAGS} -msimd128 ${WASM_LDFLAGS} \
${join(WASM_SRC, 'src')}/*.c \
-I${join(WASM_SRC, 'include')} \
-o ${join(WASM_OUT, 'llhttp_simd.wasm')} \
${WASM_LDLIBS}`, { stdio: 'inherit' })

execFileSync(
  WASM_OPT,
  [
    ...wasmOptFlags,
    '--enable-simd',
    '-o',
    join(WASM_OUT, 'llhttp_simd.wasm'),
    join(WASM_OUT, 'llhttp_simd.wasm')
  ],
  { stdio: 'inherit' }
)
writeWasmChunk('llhttp_simd.wasm', 'llhttp_simd-wasm.js')

// For compatibility with Node.js' `configure --shared-builtin-undici/undici-path ...`
if (EXTERNAL_PATH) {
  writeFileSync(join(ROOT, 'loader.js'), `
'use strict'
globalThis.__UNDICI_IS_NODE__ = true
module.exports = require('node:module').createRequire('${EXTERNAL_PATH}/loader.js')('./index-fetch.js')
delete globalThis.__UNDICI_IS_NODE__
`)
}
