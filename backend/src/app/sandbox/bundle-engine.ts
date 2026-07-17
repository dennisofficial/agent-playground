import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const NODE_CJS_SHIM_BANNER =
  "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __ftu } from 'node:url'; import { dirname as __dname } from 'node:path'; const require = __cr(import.meta.url); const __filename = __ftu(import.meta.url); const __dirname = __dname(__filename);";

function entrySourceDir(): string {
  return join(__dirname, 'image');
}

function backendRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) return __dirname; // hit the filesystem root without finding one
    dir = parent;
  }
  return dir;
}

export function sandboxContextDir(): string {
  return process.env.SANDBOX_CONTEXT_DIR ?? join(backendRoot(), 'sandbox');
}

function engineAppImagePath(): string {
  return join(sandboxContextDir(), 'engine-app.js');
}
function engineAppMapImagePath(): string {
  return join(sandboxContextDir(), 'engine-app.js.map');
}

export function engineAppBundlePath(): string {
  return process.env.ENGINE_APP_BUNDLE_PATH ?? engineAppImagePath();
}
export function engineAppMapPath(): string {
  return process.env.ENGINE_APP_MAP_PATH ?? engineAppMapImagePath();
}

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

function mcpBridgeImageBundlePath(): string {
  return join(sandboxContextDir(), 'mcp-bridge-server.mjs');
}

function mcpHubImageBundlePath(): string {
  return join(sandboxContextDir(), 'mcp-hub-server.mjs');
}

export function mcpHubBundlePath(): string {
  return process.env.MCP_HUB_BUNDLE_PATH ?? mcpHubImageBundlePath();
}

export function mcpBridgeBundlePath(): string {
  return process.env.MCP_BRIDGE_BUNDLE_PATH ?? mcpBridgeImageBundlePath();
}

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
