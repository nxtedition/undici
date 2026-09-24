# Rebuilding llhttp

Run `npm run build:wasm` with Docker available. The build uses the immutable
images in `build/Dockerfile`: Node.js 26.7.0, Clang 17.0.6, wasi-sdk 21 and
Binaryen 116. Docker always targets Linux/amd64, including on ARM hosts. The
upstream v0.0.9 ARM64 image lacks Binaryen 116; silently skipping optimization
produced different artifacts. A missing or failing optimizer now fails the build.

The generated C and header in `deps/llhttp` come from llhttp
[`release/v9.4.3`](https://github.com/nodejs/llhttp/tree/0e815792b167a9bd8ace259b95b7da953776c288)
(commit `0e815792b167a9bd8ace259b95b7da953776c288`), with trailing whitespace
removed from five generated blank lines. Keep the constants in
`lib/llhttp/constants.js` in sync with the release when updating the parser.

To check reproducibility, run the build twice and check that the four generated
files in `lib/llhttp` are unchanged on the second run:

```sh
npm run build:wasm
sha256sum lib/llhttp/*.wasm lib/llhttp/*-wasm.js > /tmp/llhttp.sha256
npm run build:wasm
sha256sum -c /tmp/llhttp.sha256
```

The same toolchain also reproduces the previously committed llhttp 9.3.1 WASM
files and JavaScript wrappers byte for byte. Its WASM SHA-256 hashes are:

```text
ab4573a06c43574936dc98c3943b10a4ee32798e9797329e9f327e5f64115f54  llhttp.wasm
18403ee56fab07f89a845028bad358bb3ebcda213f8e2ec0989a991e9c33da69  llhttp_simd.wasm
```

For a native toolchain, invoke `node build/wasm.js` with `WASM_CC`, `WASM_CFLAGS`,
`WASM_LDFLAGS`, `WASM_LDLIBS` and `WASM_OPT` as needed. Native toolchain overrides
are supported but are not expected to reproduce the pinned Docker output.
