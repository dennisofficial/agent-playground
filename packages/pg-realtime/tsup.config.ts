import { readFileSync } from 'fs';
import { join } from 'path';
import { defineConfig } from 'tsup';

// Externalize runtime deps (don't bundle pg / mingo / pg-logical-replication).
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const external = Object.keys(pkg.dependencies || {});

export default defineConfig({
  // Two entries: the full core ('.') and the LISTEN/NOTIFY bus ('./bus'). Code splitting keeps the
  // shared types in their own chunk, so importing '@workspace/pg-realtime/bus' pulls ONLY the bus +
  // pg (never the CDC engine / pg-logical-replication / mingo).
  entry: ['src/index.ts', 'src/bus/pg-notify-bus.ts'],
  format: ['cjs', 'esm'],
  dts: false,
  splitting: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  external,
  treeshake: true,
  target: 'es2023',
});
