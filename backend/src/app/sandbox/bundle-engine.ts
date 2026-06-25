import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bundle the in-container engine entrypoint into a single self-contained ESM file. The two engine SDKs
 * are kept EXTERNAL (installed in the sandbox image, dynamically imported at runtime); everything else
 * (EngineCore + helpers) is bundled in.
 *
 * This is the SAME bundle the CLI (`build-entrypoint.mjs`, run before a Docker image build) produces —
 * but exposed as a function so the API can refresh it itself on bootstrap. That is what makes engine
 * updates HOT: the bundle is bind-mounted into every sandbox (see `SandboxManager`), so once the API
 * (re)bundles, the next turn in any running thread execs the new engine — no container restart, no image
 * rebuild, no SSH. A dev watch-restart and a prod deploy-restart both trigger it.
 *
 * `__dirname` resolves to `src/app/sandbox` under ts-node/tsx (dev) and `dist/app/sandbox` when compiled
 * — so the entry is taken from the TS source in dev and the compiled JS in a built deployment.
 */
function imageDir(): string {
  return join(__dirname, 'image');
}

/** The canonical path of the bundled engine entrypoint (baked into the image AND bind-mounted live). */
export function engineBundlePath(): string {
  return join(imageDir(), 'engine-entrypoint.mjs');
}

/** (Re)bundle the engine entrypoint to {@link engineBundlePath}. Returns the output path. */
export async function bundleEngine(): Promise<string> {
  const dir = imageDir();
  // Dev: bundle from the TS source. Built deployment: bundle from the compiled JS nest emits to dist.
  const tsEntry = join(dir, 'engine-entrypoint.ts');
  const jsEntry = join(dir, 'engine-entrypoint.js');
  const entry = existsSync(tsEntry) ? tsEntry : jsEntry;
  if (!existsSync(entry)) {
    throw new Error(`no engine entrypoint source at ${tsEntry} or ${jsEntry}`);
  }
  const outfile = engineBundlePath();
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'],
    // The dev runtime is `nest start --watch` → bundles the COMPILED (CommonJS) entry, whose
    // `require("node:crypto")` becomes esbuild's throwing `__require` shim in ESM output. Provide a real
    // `require` so those dynamic requires of Node builtins resolve. (Harmless when the entry is TS/ESM.)
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'silent',
  });
  return outfile;
}
