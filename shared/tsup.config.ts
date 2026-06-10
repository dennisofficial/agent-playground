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
  // Subpath entries: `@workspace/shared` (DTOs/types — safe for the web bundle) and
  // `@workspace/shared/schemas` (TypeORM entities — backend-only; kept out of the root barrel
  // so the web never pulls TypeORM decorators).
  entry: {
    index: 'src/index.ts',
    schemas: 'src/schemas/index.ts',
  },
  format: ['cjs', 'esm'],
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
