/**
 * Bundle the in-container engine entrypoint into a single self-contained ESM file that the sandbox
 * image bakes in. The two engine SDKs are kept EXTERNAL (installed in the image, dynamically imported
 * at runtime); everything else (EngineCore + its helpers) is bundled in. Run via:
 *   pnpm -C backend atlas:sandbox:bundle
 * This must run before building the sandbox image (the Dockerfile COPYs the produced .mjs).
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'image', 'engine-entrypoint.ts');
const outfile = join(here, 'image', 'engine-entrypoint.mjs');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // The engine SDKs ship native CLIs per platform — install them in the image, don't bundle them.
  external: ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'],
  logLevel: 'info',
});

console.log(`bundled → ${outfile}`);
