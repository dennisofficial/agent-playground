const { join } = require('node:path');
const webpack = require('webpack');

const OPTIONAL_NEST_PEERS = [
  '@nestjs/platform-express',
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
  '@nestjs/websockets',
  '@nestjs/websockets/socket-module',
  'cache-manager',
];

module.exports = function (options) {
  return {
    ...options,
    target: 'node',
    entry: './src/engine/main.ts',
    output: {
      // Build output belongs in dist/ (git- + docker-ignored), NOT the source `sandbox/` dir. Its own subdir
      // (not dist/engine) so the webpack megabundle never mingles with tsc's compiled src/engine output. The
      // Docker image rebuilds this itself in its builder stage and COPYs from the matching path — nothing
      // consumes the local artifact, so this is just the local compile check.
      path: join(__dirname, 'dist', 'engine-bundle'),
      filename: 'engine-app.js',
      environment: { dynamicImport: true },
    },
    devtool: 'source-map',
    externalsType: 'import',
    externals: ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'],
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      alias: {
        '@shared': join(__dirname, 'src/_shared'),
        '@core': join(__dirname, 'src/_core'),
        '@lib': join(__dirname, 'src/_lib'),
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
