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
  // Single entry: `@workspace/shared` — the web-safe frontend/backend contract (DTOs, enums,
  // types). TypeORM entities live backend-local; the legacy `src/schemas/` is kept only as
  // archive and is intentionally NOT exported or built (see package.json exports).
  entry: {
    index: 'src/index.ts',
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
