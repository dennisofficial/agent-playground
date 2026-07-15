import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read package.json to auto-detect externals
const packageJson = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

const external = [
  ...Object.keys(packageJson.peerDependencies || {}),
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.devDependencies || {}).filter(
    (dep) => !dep.startsWith('@types/') && !['typescript', 'tsup'].includes(dep),
  ),
];

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  // No d.ts emission: consumers resolve types straight from src (package.json `types`), the same
  // contract as the other workspace packages — they travel with the submodule, no build step needed.
  dts: false,
  splitting: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  external,
  treeshake: true,
  minify: false,
  target: 'es2023',
});
