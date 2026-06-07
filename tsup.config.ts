import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm'],
  target: 'es2023',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  minify: false,
  banner: { js: '#!/usr/bin/env node' }, // make dist/index.js runnable as the `bin`
});
