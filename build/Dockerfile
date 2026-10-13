# Use one architecture and immutable toolchains for byte-for-byte rebuilds.
FROM node:26.7.0-alpine3.23@sha256:beb1f82448d01c14c85266ee5ea8cca055e1e2dbf3880bbfcc6de85838f38c4f AS node
FROM ghcr.io/nodejs/wasm-builder@sha256:975f391d907e42a75b8c72eb77c782181e941608687d4d8694c3e9df415a0970

COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN node --version && "$WASM_OPT" --version
