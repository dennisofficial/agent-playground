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
 * The subprocess bundlers' TS/JS source directory (`bundleMcpBridge`/`bundleMcpHub`). `__dirname` resolves
 * to `src/app/sandbox` under ts-node/tsx (dev) and `dist/app/sandbox` when compiled — so the entry is taken
 * from the TS source in dev and the compiled JS in a built deployment.
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
 * committed) plus the bundles written here at boot by {@link ensureEngineApp}/{@link bundleMcpBridge}/
 * {@link bundleMcpHub} (gitignored). Anchored to the backend package root (see {@link backendRoot}).
 * Overridable via `SANDBOX_CONTEXT_DIR`.
 */
export function sandboxContextDir(): string {
  return process.env.SANDBOX_CONTEXT_DIR ?? join(backendRoot(), 'sandbox');
}

/** In-context home of the webpacked engine app (written here at BUILD time by `pnpm -C backend
 *  build:engine` — see webpack.engine.config.js — NOT re-bundled at runtime, unlike the esbuild
 *  subprocess bundlers below). COPY'd by the Dockerfile as a baked fallback, bind-mounted live for
 *  hot-reload. */
function engineAppImagePath(): string {
  return join(sandboxContextDir(), 'engine-app.js');
}
function engineAppMapImagePath(): string {
  return join(sandboxContextDir(), 'engine-app.js.map');
}

/** The live bind-mount source for the engine app bundle (honors `ENGINE_APP_BUNDLE_PATH`, same rationale
 *  as {@link mcpHubBundlePath}/{@link mcpBridgeBundlePath}). */
export function engineAppBundlePath(): string {
  return process.env.ENGINE_APP_BUNDLE_PATH ?? engineAppImagePath();
}
/** The live bind-mount source for the engine app's external sourcemap (honors `ENGINE_APP_MAP_PATH`). */
export function engineAppMapPath(): string {
  return process.env.ENGINE_APP_MAP_PATH ?? engineAppMapImagePath();
}

/**
 * Ensure the PRE-BUILT engine app (+ sourcemap) is mirrored to its live bind-mount location. Unlike
 * {@link bundleMcpBridge}/{@link bundleMcpHub}, this does NOT invoke any build tooling — `nest build engine
 * --webpack` only runs at image-build/dev time (where the `@nestjs/cli` devDependency exists; prod prunes
 * devDeps, so invoking the Nest CLI here would fail in a pruned runtime). It only copies the already-built
 * `backend/sandbox/engine-app.js`(`.map`) to the override path when `ENGINE_APP_BUNDLE_PATH`/
 * `ENGINE_APP_MAP_PATH` point elsewhere (mirrors the mirroring step in {@link bundleMcpBridge}). Throws if
 * the in-context file is missing (caller should catch + warn, same pattern as the other bundle refreshers)
 * — that means `pnpm build:engine` hasn't been run yet (dev) or the image build stage skipped it (prod bug).
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
 *  and spawned by codex inside the sandbox — see `mcp-bridge-server.ts`). Mirrors {@link engineAppImagePath}. */
function mcpBridgeImageBundlePath(): string {
  return join(sandboxContextDir(), 'mcp-bridge-server.mjs');
}

/** In-context home of the persistent MCP hub bundle (COPY'd by the Dockerfile, bind-mounted live, launched
 *  by `sandbox-init.sh` — see `image/mcp-hub-server.ts`). Mirrors {@link engineAppImagePath}. */
function mcpHubImageBundlePath(): string {
  return join(sandboxContextDir(), 'mcp-hub-server.mjs');
}

/** The live bind-mount source for the MCP hub bundle (honors `MCP_HUB_BUNDLE_PATH`, same rationale as
 *  {@link engineAppBundlePath}). */
export function mcpHubBundlePath(): string {
  return process.env.MCP_HUB_BUNDLE_PATH ?? mcpHubImageBundlePath();
}

/** The live bind-mount source for the MCP bridge bundle (honors `MCP_BRIDGE_BUNDLE_PATH`, same rationale
 *  as {@link engineAppBundlePath}). */
export function mcpBridgeBundlePath(): string {
  return process.env.MCP_BRIDGE_BUNDLE_PATH ?? mcpBridgeImageBundlePath();
}

/**
 * (Re)bundle the in-sandbox Codex MCP tool-bridge server. Standalone from the engine bundle: it has NO
 * externals (ioredis + `@modelcontextprotocol/sdk` are bundled in) because codex spawns it as a bare
 * `node mcp-bridge-server.mjs` subprocess with no access to the engine's node_modules. Same hot-reload
 * contract as {@link bundleMcpHub} (in-context copy + optional live-mount mirror). Returns the live path.
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
 * {@link bundleMcpBridge} (in-context copy + optional live-mount mirror). Returns the live path.
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
