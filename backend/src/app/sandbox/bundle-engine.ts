import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Bundle the in-container engine entrypoint into a single self-contained ESM file. The two engine SDKs
 * are kept EXTERNAL (installed in the sandbox image, dynamically imported at runtime); everything else
 * (EngineCore + helpers) is bundled in.
 *
 * The API calls this on every bootstrap (`SandboxImageBuilder`), which is what makes engine updates HOT:
 * the bundle is bind-mounted into every sandbox (see `SandboxManager`), so once the API (re)bundles, the
 * next turn in any running thread execs the new engine — no manual bundle step, no container restart, no
 * image rebuild, no SSH. A dev watch-restart and a prod deploy-restart both trigger it. (The image also
 * bakes a copy at build time via the Dockerfile `COPY`, used only as a fallback if the live mount is
 * absent; the build reads the `.mjs` this function wrote on boot.)
 *
 * `__dirname` resolves to `src/app/sandbox` under ts-node/tsx (dev) and `dist/app/sandbox` when compiled
 * — so the entry is taken from the TS source in dev and the compiled JS in a built deployment.
 */
function entrySourceDir(): string {
  return join(__dirname, 'image');
}

/**
 * The BACKEND package root — the nearest ancestor of THIS file that holds a `package.json`. Resolved from
 * `__dirname` (where the code physically lives), so it's independent of BOTH `cwd`/`WORKDIR` (dev runs
 * from `backend/`, prod's WORKDIR is `/srv/atlas/app`) AND of how deeply nest nests the compiled file
 * (`src/app/sandbox` vs `dist/app/sandbox`). `src`/`dist` carry no `package.json`, so the walk stops at
 * `backend/` in both. Falls back to `__dirname` if none is found (shouldn't happen).
 */
function backendRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) return __dirname; // hit the filesystem root without finding one
    dir = parent;
  }
  return dir;
}

/**
 * The docker BUILD CONTEXT dir — a FIXED, checked-in `backend/sandbox/` that is IDENTICAL at build time
 * and runtime, so it doesn't matter whether the process runs from `src` (dev) or `dist` (prod): no
 * nest-cli asset copy, no dist/src divergence. It holds the static context (Dockerfile + `*.sh`, all
 * committed) plus `engine-entrypoint.mjs` (written here at boot by {@link bundleEngine}; gitignored).
 * Anchored to the backend package root (see {@link backendRoot}). Overridable via `SANDBOX_CONTEXT_DIR`.
 */
export function sandboxContextDir(): string {
  return process.env.SANDBOX_CONTEXT_DIR ?? join(backendRoot(), 'sandbox');
}

/**
 * The bundle's home INSIDE the build context (`<sandboxContextDir>/engine-entrypoint.mjs`). `bundleEngine`
 * ALWAYS writes here, because the sandbox image Dockerfile `COPY`s it and the on-boot image build reads
 * it from this dir. This is also the default bind-mount source when no override is set.
 */
function imageBundlePath(): string {
  return join(sandboxContextDir(), 'engine-entrypoint.mjs');
}

/**
 * The bundle path bind-mounted live into every sandbox (the SOURCE handed to the Docker daemon).
 * Honors `ENGINE_BUNDLE_PATH` so a containerized backend can point the live mount at a host-resolvable
 * same-path location (e.g. `/srv/atlas/data/engine/engine-entrypoint.mjs`) while the image build still
 * uses the in-context copy. Falls back to {@link imageBundlePath} (the original behavior).
 */
export function engineBundlePath(): string {
  return process.env.ENGINE_BUNDLE_PATH ?? imageBundlePath();
}

/**
 * (Re)bundle the engine entrypoint. Always writes the in-context copy ({@link imageBundlePath}); when
 * `ENGINE_BUNDLE_PATH` points elsewhere, MIRRORS the result there too so the live bind mount sees the
 * fresh bundle without breaking the image-build `COPY`. Returns the live mount path.
 */
export async function bundleEngine(): Promise<string> {
  const dir = entrySourceDir();
  // Dev: bundle from the TS source. Built deployment: bundle from the compiled JS nest emits to dist.
  const tsEntry = join(dir, 'engine-entrypoint.ts');
  const jsEntry = join(dir, 'engine-entrypoint.js');
  const entry = existsSync(tsEntry) ? tsEntry : jsEntry;
  if (!existsSync(entry)) {
    throw new Error(`no engine entrypoint source at ${tsEntry} or ${jsEntry}`);
  }
  const outfile = imageBundlePath();
  mkdirSync(dirname(outfile), { recursive: true }); // the fixed context dir is committed, but be safe
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: [
      '@anthropic-ai/claude-agent-sdk',
      '@openai/codex-sdk',
      // `@nestjs/core`'s NestApplication/NestFactory lazily `require`s these OPTIONAL transport packages
      // (websockets/microservices) behind runtime guards. They aren't installed and the in-sandbox engine
      // never uses them, but esbuild fails the WHOLE bundle trying to resolve them (→ "engine rebundle
      // skipped, using existing bundle", leaving the sandbox on a STALE engine). Mark them external so the
      // rebundle succeeds; at runtime they're never required down the engine's code path.
      '@nestjs/microservices',
      '@nestjs/microservices/microservices-module',
      '@nestjs/websockets/socket-module',
    ],
    // The dev runtime is `nest start --watch` → bundles the COMPILED (CommonJS) entry, whose
    // `require("node:crypto")` becomes esbuild's throwing `__require` shim in ESM output. Provide a real
    // `require` so those dynamic requires of Node builtins resolve. (Harmless when the entry is TS/ESM.)
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'silent',
  });
  // Mirror to the live bind-mount location when it differs (containerized backend → host-resolvable path).
  const live = engineBundlePath();
  if (live !== outfile) {
    mkdirSync(dirname(live), { recursive: true });
    copyFileSync(outfile, live);
  }
  return live;
}

/** In-context home of the Codex MCP tool-bridge server bundle (COPY'd by the Dockerfile, bind-mounted live,
 *  and spawned by codex inside the sandbox — see `mcp-bridge-server.ts`). Mirrors {@link imageBundlePath}. */
function mcpBridgeImageBundlePath(): string {
  return join(sandboxContextDir(), 'mcp-bridge-server.mjs');
}

/** The live bind-mount source for the MCP bridge bundle (honors `MCP_BRIDGE_BUNDLE_PATH`, same rationale
 *  as {@link engineBundlePath}). */
export function mcpBridgeBundlePath(): string {
  return process.env.MCP_BRIDGE_BUNDLE_PATH ?? mcpBridgeImageBundlePath();
}

/**
 * (Re)bundle the in-sandbox Codex MCP tool-bridge server. Standalone from the engine bundle: it has NO
 * externals (ioredis + `@modelcontextprotocol/sdk` are bundled in) because codex spawns it as a bare
 * `node mcp-bridge-server.mjs` subprocess with no access to the engine's node_modules. Same hot-reload
 * contract as {@link bundleEngine} (in-context copy + optional live-mount mirror). Returns the live path.
 */
export async function bundleMcpBridge(): Promise<string> {
  const dir = entrySourceDir();
  const tsEntry = join(dir, 'mcp-bridge-server.ts');
  const jsEntry = join(dir, 'mcp-bridge-server.js');
  const entry = existsSync(tsEntry) ? tsEntry : jsEntry;
  if (!existsSync(entry)) {
    throw new Error(`no mcp-bridge-server source at ${tsEntry} or ${jsEntry}`);
  }
  const outfile = mcpBridgeImageBundlePath();
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'silent',
  });
  const live = mcpBridgeBundlePath();
  if (live !== outfile) {
    mkdirSync(dirname(live), { recursive: true });
    copyFileSync(outfile, live);
  }
  return live;
}
