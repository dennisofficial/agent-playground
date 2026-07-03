#!/usr/bin/env node
/**
 * atlas-lsp-launcher — a stdio MCP proxy that sits in front of `mcp-language-server` and re-roots it at
 * the nearest enclosing `tsconfig.json` of the file a tool call targets. See ADR 0004.
 *
 * WHY: `mcp-language-server` v0.1.1 takes ONE fixed `--workspace` at spawn and eagerly opens EVERY file
 * under it. Pointed at a monorepo root (the turn's cwd is always the repo root), that loads every package
 * — hundreds/thousands of files — and a `rename_symbol` then crawls references across all of them and
 * times out. The turn doesn't know which package it will touch until a tool is actually called, so the
 * root can't be chosen at spawn time. This shim defers that choice: it proxies the MCP session and, on the
 * first tool call that carries a `filePath` (rename_symbol / hover / diagnostics), walks up from that file
 * to its nearest `tsconfig.json` and (re)starts the underlying server rooted THERE — the same project
 * tsserver itself would select for that file. Name-based calls (references / definition) have no path, so
 * they run against the current (or repo-root) child.
 *
 * It also normalizes a relative `filePath` to absolute (resolved against the repo root): `mcp-language-server`
 * v0.1.1 mis-resolves relative paths when applying a WorkspaceEdit, so rename silently fails on them.
 *
 * Framing: MCP stdio is newline-delimited JSON-RPC 2.0. We line-buffer both directions.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute } from 'node:path';

const UNDERLYING = '/usr/local/bin/mcp-language-server';

// Parse our own argv (the same args the SDK would have passed to mcp-language-server):
//   --workspace <root> --lsp <cmd> -- <lsp args...>
const argv = process.argv.slice(2);
const wsIdx = argv.indexOf('--workspace');
const repoRoot = wsIdx >= 0 && argv[wsIdx + 1] ? argv[wsIdx + 1] : process.cwd();

/** The child's argv for a given workspace root — same as ours but with --workspace swapped. */
function childArgs(root) {
  const a = argv.slice();
  if (wsIdx >= 0) a[wsIdx + 1] = root;
  else a.unshift('--workspace', root);
  return a;
}

/** Nearest ancestor dir of `absFile` (up to and including repoRoot) that has a tsconfig.json, else repoRoot. */
function nearestTsconfigDir(absFile) {
  let dir = dirname(absFile);
  for (;;) {
    if (existsSync(join(dir, 'tsconfig.json'))) return dir;
    if (dir === repoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return repoRoot;
}

// ── MCP framing helpers ───────────────────────────────────────────────────────────────────────────────
function writeLine(stream, obj) {
  stream.write(JSON.stringify(obj) + '\n');
}
function lineReader(stream, onMessage) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(msg);
    }
  });
}

// ── Child (underlying mcp-language-server) lifecycle ──────────────────────────────────────────────────
let child = null;
let childRoot = null;
let initParams = null; // the client's initialize params, replayed to each child
let synId = 1_000_000_000; // synthetic ids for the internal per-child handshake (won't collide w/ client ids)
const internalWaiters = new Map();

function killChild() {
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {}
    child = null;
    childRoot = null;
  }
}

/** Start a child rooted at `root`, run the MCP handshake with it, resolve with its initialize result. */
function startChild(root) {
  return new Promise((ready) => {
    const c = spawn(UNDERLYING, childArgs(root), { stdio: ['pipe', 'pipe', 'inherit'] });
    child = c;
    childRoot = root;
    c.on('exit', () => {
      if (child === c) {
        child = null;
        childRoot = null;
      }
    });
    lineReader(c.stdout, (msg) => {
      if (msg.id != null && internalWaiters.has(msg.id)) {
        internalWaiters.get(msg.id)(msg);
        internalWaiters.delete(msg.id);
      } else {
        writeLine(process.stdout, msg); // forward child → client (responses + notifications)
      }
    });
    const id = ++synId;
    internalWaiters.set(id, (resp) => {
      writeLine(c.stdin, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      ready(resp);
    });
    writeLine(c.stdin, {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: initParams ?? {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'atlas-lsp-launcher', version: '1' },
      },
    });
  });
}

async function ensureChild(root) {
  if (!child) return startChild(root);
  if (root && root !== childRoot) {
    killChild();
    return startChild(root);
  }
}

// ── Client (SDK) → shim ───────────────────────────────────────────────────────────────────────────────
const pending = Promise.resolve();
let queue = pending;
lineReader(process.stdin, (msg) => {
  // Serialize handling so a re-root restart can't interleave with the next message.
  queue = queue.then(() => handleClient(msg)).catch(() => {});
});

async function handleClient(msg) {
  const method = msg.method;

  if (method === 'initialize') {
    initParams = msg.params;
    const initResp = await startChild(repoRoot);
    writeLine(process.stdout, { jsonrpc: '2.0', id: msg.id, result: initResp.result });
    return;
  }
  if (method === 'notifications/initialized') {
    return; // already handshaked each child in startChild()
  }

  if (method === 'tools/call') {
    const args = (msg.params && msg.params.arguments) || {};
    const fp = args.filePath;
    if (typeof fp === 'string' && fp.length) {
      const abs = isAbsolute(fp) ? fp : resolve(repoRoot, fp);
      args.filePath = abs; // normalize (v0.1.1 mis-applies relative paths)
      await ensureChild(nearestTsconfigDir(abs));
    } else {
      await ensureChild(childRoot ?? repoRoot);
    }
    writeLine(child.stdin, msg);
    return;
  }

  // tools/list, ping, anything else → forward to the current child
  await ensureChild(childRoot ?? repoRoot);
  writeLine(child.stdin, msg);
}
