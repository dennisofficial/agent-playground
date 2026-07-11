import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// CJS format is REQUIRED, not a preference: an esm bundle breaks at runtime because TypeORM's
// transitive deps use `__dirname`, which esm doesn't provide. CJS also fully preserves the
// `emitDecoratorMetadata` output TypeORM's decorators depend on. Verified by spike — do not switch to
// `format: 'esm'`.
const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..');

await build({
  entryPoints: [resolve(backendRoot, 'src/mcp-reader/main.ts')],
  outfile: resolve(backendRoot, 'dist/mcp-reader.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
  // No externals — everything (including @modelcontextprotocol/sdk, typeorm, pg) bundled into one file
  // so the runtime image only needs `node dist/mcp-reader.js`.
});

console.log('built dist/mcp-reader.js');
