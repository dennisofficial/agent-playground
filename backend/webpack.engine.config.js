const { join } = require('node:path');
const webpack = require('webpack');

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
    entry: './src/engine/main.ts',
    output: {
      path: join(__dirname, 'sandbox'),
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
