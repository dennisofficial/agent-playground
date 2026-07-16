import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * ESM banner for the sandbox bundles. esbuild's `format: 'esm'` output does NOT provide the CommonJS
 * globals `require`/`__filename`/`__dirname`, yet bundled-in code references them — e.g. engine-core's
 * `createRequire(__filename)` (used to resolve the `@openai/codex` binary). Without these shims the whole
 * ESM bundle throws `__filename is not defined in ES module scope` on load, killing every engine turn.
 */
const NODE_CJS_SHIM_BANNER =
  "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __ftu } from 'node:url'; import { dirname as __dname } from 'node:path'; const require = __cr(import.meta.url); const __filename = __ftu(import.meta.url); const __dirname = __dname(__filename);";

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
    banner: { js: NODE_CJS_SHIM_BANNER },
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

/** In-context home of the NEW webpacked engine app (written here at BUILD time by `pnpm -C backend
 *  build:engine` — see webpack.engine.config.js — NOT re-bundled at runtime, unlike the old esbuild
 *  bundle above). COPY'd by the Dockerfile as a baked fallback, bind-mounted live for hot-reload. */
function engineAppImagePath(): string {
  return join(sandboxContextDir(), 'engine-app.js');
}
function engineAppMapImagePath(): string {
  return join(sandboxContextDir(), 'engine-app.js.map');
}

/** The live bind-mount source for the engine app bundle (honors `ENGINE_APP_BUNDLE_PATH`, same rationale
 *  as {@link engineBundlePath}). */
export function engineAppBundlePath(): string {
  return process.env.ENGINE_APP_BUNDLE_PATH ?? engineAppImagePath();
}
/** The live bind-mount source for the engine app's external sourcemap (honors `ENGINE_APP_MAP_PATH`). */
export function engineAppMapPath(): string {
  return process.env.ENGINE_APP_MAP_PATH ?? engineAppMapImagePath();
}

/**
 * Ensure the PRE-BUILT engine app (+ sourcemap) is mirrored to its live bind-mount location. Unlike
 * {@link bundleEngine}, this does NOT invoke any build tooling — `nest build engine --webpack` only runs
 * at image-build/dev time (where the `@nestjs/cli` devDependency exists; prod prunes devDeps, so invoking
 * the Nest CLI here would fail in a pruned runtime). It only copies the already-built
 * `backend/sandbox/engine-app.js`(`.map`) to the override path when `ENGINE_APP_BUNDLE_PATH`/
 * `ENGINE_APP_MAP_PATH` point elsewhere (mirrors the mirroring step in {@link bundleEngine}). Throws if the
 * in-context file is missing (caller should catch + warn, same pattern as the other bundle refreshers) —
 * that means `pnpm build:engine` hasn't been run yet (dev) or the image build stage skipped it (prod bug).
 */
export function ensureEngineApp(): { js: string; map: string } {
  const jsSrc = engineAppImagePath();
  if (!existsSync(jsSrc)) {
    throw new Error(
      `engine-app.js not found at ${jsSrc} — run \`pnpm -C backend build:engine\` first`,
    );
  }
  const jsLive = engineAppBundlePath();
  if (jsLive !== jsSrc) {
    mkdirSync(dirname(jsLive), { recursive: true });
    copyFileSync(jsSrc, jsLive);
  }
  const mapSrc = engineAppMapImagePath();
  const mapLive = engineAppMapPath();
  if (existsSync(mapSrc) && mapLive !== mapSrc) {
    mkdirSync(dirname(mapLive), { recursive: true });
    copyFileSync(mapSrc, mapLive);
  }
  return { js: jsLive, map: mapLive };
}

/** In-context home of the Codex MCP tool-bridge server bundle (COPY'd by the Dockerfile, bind-mounted live,
 *  and spawned by codex inside the sandbox — see `mcp-bridge-server.ts`). Mirrors {@link imageBundlePath}. */
function mcpBridgeImageBundlePath(): string {
  return join(sandboxContextDir(), 'mcp-bridge-server.mjs');
}

/** In-context home of the persistent MCP hub bundle (COPY'd by the Dockerfile, bind-mounted live, launched
 *  by `sandbox-init.sh` — see `image/mcp-hub-server.ts`). Mirrors {@link imageBundlePath}. */
function mcpHubImageBundlePath(): string {
  return join(sandboxContextDir(), 'mcp-hub-server.mjs');
}

/** The live bind-mount source for the MCP hub bundle (honors `MCP_HUB_BUNDLE_PATH`, same rationale as
 *  {@link engineBundlePath}). */
export function mcpHubBundlePath(): string {
  return process.env.MCP_HUB_BUNDLE_PATH ?? mcpHubImageBundlePath();
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
    banner: { js: NODE_CJS_SHIM_BANNER },
    logLevel: 'silent',
  });
  const live = mcpBridgeBundlePath();
  if (live !== outfile) {
    mkdirSync(dirname(live), { recursive: true });
    copyFileSync(outfile, live);
  }
  return live;
}

/**
 * (Re)bundle the persistent in-sandbox MCP hub (`image/mcp-hub-server.ts`). Standalone from the engine
 * bundle: NO externals (`@modelcontextprotocol/sdk` bundled in) because `sandbox-init.sh` launches it as a
 * bare `node mcp-hub-server.mjs` with no access to the engine's node_modules. Same hot-reload contract as
 * {@link bundleEngine} (in-context copy + optional live-mount mirror). Returns the live path.
 */
export async function bundleMcpHub(): Promise<string> {
  const dir = entrySourceDir();
  const tsEntry = join(dir, 'mcp-hub-server.ts');
  const jsEntry = join(dir, 'mcp-hub-server.js');
  const entry = existsSync(tsEntry) ? tsEntry : jsEntry;
  if (!existsSync(entry)) {
    throw new Error(`no mcp-hub-server source at ${tsEntry} or ${jsEntry}`);
  }
  const outfile = mcpHubImageBundlePath();
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: NODE_CJS_SHIM_BANNER },
    logLevel: 'silent',
  });
  const live = mcpHubBundlePath();
  if (live !== outfile) {
    mkdirSync(dirname(live), { recursive: true });
    copyFileSync(outfile, live);
  }
  return live;
}
