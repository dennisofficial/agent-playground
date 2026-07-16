const { join } = require('node:path');
const webpack = require('webpack');

// `@nestjs/core`'s NestFactory/NestApplication code paths reference these OPTIONAL peer packages behind
// runtime guards (platform-express, microservices, websockets transports, class-validator/-transformer
// pipes, cache-manager). None are installed or used by the engine app, but webpack fails the whole bundle
// trying to resolve them unless they're explicitly ignored.
const OPTIONAL_NEST_PEERS = [
  '@nestjs/platform-express',
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
  '@nestjs/websockets',
  '@nestjs/websockets/socket-module',
  'class-validator',
  'class-transformer',
  'cache-manager',
];

module.exports = function (options) {
  return {
    ...options,
    target: 'node',
    // Nest CLI's webpackDefaultsFactory derives the default entry from `sourceRoot` + `entryFilename`;
    // this project's `sourceRoot` is the monorepo-wide `"src"`, not `"src/engine"`, so the default entry
    // is wrong for a monorepo sub-project — must be pinned explicitly.
    entry: './src/engine/main.ts',
    output: {
      path: join(__dirname, 'sandbox'),
      filename: 'engine-app.js',
      // Required alongside `externalsType: 'import'` below — an `import()` inside an otherwise-CommonJS
      // bundle needs this flag or webpack refuses to emit it.
      environment: { dynamicImport: true },
    },
    // External map file — required for readable stack traces (see `--enable-source-maps` at exec time).
    devtool: 'source-map',
    // The two agent SDKs stay OUT of the bundle (installed flat in the sandbox image's node_modules);
    // everything else (Nest, ioredis, rxjs, reflect-metadata, eventemitter2, ...) is inlined. This
    // REPLACES nest-cli's default `externals: [nodeExternals()]`, which would externalize everything.
    // `externalsType: 'import'` is REQUIRED (not the plain string-array default, which emits a bare
    // `typeof @anthropic-ai/claude-agent-sdk` — invalid JS, since a package name isn't a JS identifier):
    // it makes webpack emit a real `import(...)` for each external, which is also the only CORRECT choice
    // here regardless — `@openai/codex-sdk` is pure-ESM, so a `require()`-based external
    // (`externalsType: 'commonjs'`) fails at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Both SDKs are
    // already consumed via `await import(...)` (`turn-runner.service.ts`), so this matches call sites.
    externalsType: 'import',
    externals: ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'],
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      // tsconfig-paths do not resolve reliably under this webpack setup — alias explicitly instead.
      alias: {
        '@shared': join(__dirname, 'src/shared'),
        '@core': join(__dirname, 'src/_core'),
      },
    },
    plugins: [
      new webpack.IgnorePlugin({
        checkResource(resource) {
          return OPTIONAL_NEST_PEERS.includes(resource);
        },
      }),
    ],
  };
};
