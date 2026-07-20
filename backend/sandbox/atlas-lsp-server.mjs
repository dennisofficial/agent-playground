#!/usr/bin/env node
/**
 * atlas-lsp-server — an MCP server that drives `typescript-language-server` DIRECTLY over LSP, so the
 * navigation tools are POSITION-based (file+line+col) and reliable. See ADR 0004 (addendum).
 *
 * Why we own this instead of using mcp-language-server: its `references`/`definition` resolve a
 * `symbolName` via LSP `workspace/symbol` (a fuzzy, flaky search) — on real monorepos that silently
 * returns zero for symbols with many usages. `textDocument/references`/`definition` at a POSITION
 * (which the agent always has from a Read/grep) are reliable and are exactly what `rename` already
 * used. So this process is both an MCP server (to the Claude SDK) and an LSP client (to tsserver).
 *
 * TWO framings in one process:
 *   - MCP (to the SDK) over our stdin/stdout: newline-delimited JSON-RPC 2.0.
 *   - LSP (to tsserver) over the child's stdio: `Content-Length: N\r\n\r\n<json>` framed JSON-RPC 2.0.
 *
 * Re-rooting (kept from the old proxy): the language server is (re)started rooted at the nearest
 * `tsconfig.json` of the file a tool call targets — the project tsserver itself would select — so a
 * monorepo turn only loads the relevant package. Relative filePaths are normalized to absolute.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── argv: --workspace <root> --lsp <cmd> -- <lsp args...> ───────────────────────────────────────────
const argv = process.argv.slice(2);
const wsIdx = argv.indexOf('--workspace');
const repoRoot = wsIdx >= 0 && argv[wsIdx + 1] ? argv[wsIdx + 1] : process.cwd();
const lspIdx = argv.indexOf('--lsp');
const ddIdx = argv.indexOf('--');
const LSP_CMD = lspIdx >= 0 && argv[lspIdx + 1] ? argv[lspIdx + 1] : 'typescript-language-server';
const LSP_ARGS = ddIdx >= 0 ? argv.slice(ddIdx + 1) : ['--stdio'];

const log = (...a) => process.stderr.write('[atlas-lsp] ' + a.join(' ') + '\n');

// ── path / language helpers ─────────────────────────────────────────────────────────────────────────
function nearestTsconfigDir(absFile) {
  let dir = dirname(absFile);
  for (;;) {
    if (existsSync(join(dir, 'tsconfig.json')) || existsSync(join(dir, 'jsconfig.json')))
      return dir;
    if (dir === repoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return repoRoot;
}
function toAbs(fp) {
  return isAbsolute(fp) ? fp : resolve(repoRoot, fp);
}
function languageId(file) {
  switch (extname(file)) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'typescriptreact';
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'javascriptreact';
    default:
      return 'typescript';
  }
}
const uriOf = (absFile) => pathToFileURL(absFile).href;
const pathOf = (uri) => fileURLToPath(uri);

// ── LSP client (Content-Length framed JSON-RPC to the language server) ──────────────────────────────
let child = null;
let childRoot = null;
let lspNextId = 1;
const lspWaiters = new Map(); // id -> resolve
const openDocs = new Set(); // uris opened in the CURRENT child
const diagnostics = new Map(); // uri -> { items, version }
const diagWaiters = new Map(); // uri -> [resolve,...]

function killChild() {
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  child = null;
  childRoot = null;
  openDocs.clear();
  diagnostics.clear();
  for (const [, list] of diagWaiters) for (const r of list) r();
  diagWaiters.clear();
}

function lspSend(method, params) {
  const id = lspNextId++;
  const p = new Promise((res) => lspWaiters.set(id, res));
  writeLsp({ jsonrpc: '2.0', id, method, params });
  return p;
}
function lspNotify(method, params) {
  writeLsp({ jsonrpc: '2.0', method, params });
}
function writeLsp(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

function handleLspMessage(msg) {
  // server → client REQUEST (has id AND method): must reply or tsserver blocks.
  if (msg.id != null && msg.method) {
    let result = null;
    if (msg.method === 'workspace/configuration') {
      result = Array.isArray(msg.params?.items) ? msg.params.items.map(() => ({})) : [];
    }
    writeLsp({ jsonrpc: '2.0', id: msg.id, result });
    return;
  }
  // response to our request
  if (msg.id != null && lspWaiters.has(msg.id)) {
    lspWaiters.get(msg.id)(msg);
    lspWaiters.delete(msg.id);
    return;
  }
  // notifications
  if (msg.method === 'textDocument/publishDiagnostics') {
    const { uri, diagnostics: items } = msg.params ?? {};
    if (uri) {
      diagnostics.set(uri, { items: items ?? [] });
      const list = diagWaiters.get(uri);
      if (list) {
        diagWaiters.delete(uri);
        for (const r of list) r();
      }
    }
  }
  // window/logMessage, $/progress, etc. → ignore
}

async function startChild(root) {
  const c = spawn(LSP_CMD, LSP_ARGS, { stdio: ['pipe', 'pipe', 'inherit'] });
  child = c;
  childRoot = root;
  c.on('exit', () => {
    if (child === c) killChild();
  });
  // LSP Content-Length frame reader.
  let buf = Buffer.alloc(0);
  c.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buf.slice(0, headerEnd).toString('utf8');
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) return; // wait for full body
      const body = buf.slice(start, start + len).toString('utf8');
      buf = buf.slice(start + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      handleLspMessage(msg);
    }
  });
  // initialize handshake
  const rootUri = pathToFileURL(root).href;
  await lspSend('initialize', {
    processId: process.pid,
    rootUri,
    rootPath: root,
    capabilities: {
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: true },
        publishDiagnostics: { relatedInformation: true },
        rename: { dynamicRegistration: false, prepareSupport: false },
        references: { dynamicRegistration: false },
        definition: { dynamicRegistration: false, linkSupport: false },
        hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
      },
      workspace: {
        workspaceEdit: { documentChanges: true, resourceOperations: ['rename'] },
        configuration: true,
        workspaceFolders: true,
      },
    },
    workspaceFolders: [{ uri: rootUri, name: 'root' }],
    initializationOptions: {},
  });
  lspNotify('initialized', {});
  log('language server rooted at', root);
}

async function ensureChild(absFile) {
  const root = absFile ? nearestTsconfigDir(absFile) : (childRoot ?? repoRoot);
  if (!child) {
    await startChild(root);
    return;
  }
  if (root !== childRoot) {
    killChild();
    await startChild(root);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openAndSettle(absFile, { waitDiag = true, timeoutMs = 15000 } = {}) {
  const uri = uriOf(absFile);
  if (!openDocs.has(uri)) {
    let text = '';
    try {
      text = readFileSync(absFile, 'utf8');
    } catch {}
    lspNotify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageId(absFile), version: 1, text },
    });
    openDocs.add(uri);
  }
  if (!waitDiag) return uri;
  if (diagnostics.has(uri)) return uri;
  await new Promise((resolve) => {
    const list = diagWaiters.get(uri) ?? [];
    list.push(resolve);
    diagWaiters.set(uri, list);
    setTimeout(() => {
      const l = diagWaiters.get(uri);
      if (l) {
        const i = l.indexOf(resolve);
        if (i >= 0) l.splice(i, 1);
      }
      resolve();
    }, timeoutMs);
  });
  return uri;
}

// ── WorkspaceEdit application (rename) ──────────────────────────────────────────────────────────────
function lineStarts(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1);
  return starts;
}
function offsetOf(starts, pos) {
  const base = pos.line < starts.length ? starts[pos.line] : starts[starts.length - 1];
  return base + pos.character;
}

function applyTextEdits(content, edits) {
  const starts = lineStarts(content);
  const sorted = edits.slice().sort((a, b) => {
    const dl = b.range.start.line - a.range.start.line;
    return dl !== 0 ? dl : b.range.start.character - a.range.start.character;
  });
  let out = content;
  for (const e of sorted) {
    const s = offsetOf(starts, e.range.start);
    const en = offsetOf(starts, e.range.end);
    out = out.slice(0, s) + (e.newText ?? '') + out.slice(en);
  }
  return out;
}

function applyWorkspaceEdit(edit) {
  // Normalize to a map uri -> TextEdit[]
  const byUri = new Map();
  if (edit?.documentChanges) {
    for (const dc of edit.documentChanges) {
      if (dc.textDocument && dc.edits) {
        const uri = dc.textDocument.uri;
        byUri.set(uri, (byUri.get(uri) ?? []).concat(dc.edits));
      }
      // (ignore pure rename/create/delete resource ops — not produced by textDocument/rename of a symbol)
    }
  } else if (edit?.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      byUri.set(uri, (byUri.get(uri) ?? []).concat(edits));
    }
  }
  const files = [];
  for (const [uri, edits] of byUri) {
    const file = pathOf(uri);
    let content = '';
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const updated = applyTextEdits(content, edits);
    if (updated !== content) writeFileSync(file, updated, 'utf8');
    files.push({ file, count: edits.length });
  }
  return files;
}

// ── formatting helpers for tool results ─────────────────────────────────────────────────────────────
function fmtLocations(result) {
  const locs = Array.isArray(result) ? result : result ? [result] : [];
  return locs.map((l) => {
    const uri = l.uri ?? l.targetUri;
    const range = l.range ?? l.targetSelectionRange ?? l.targetRange;
    const p = range?.start ?? { line: 0, character: 0 };
    return `${pathOf(uri)}:${p.line + 1}:${p.character + 1}`;
  });
}

// ── the 5 tools (position-based) ────────────────────────────────────────────────────────────────────
async function toolRename({ filePath, line, column, newName }) {
  const abs = toAbs(filePath);
  await ensureChild(abs);
  await openAndSettle(abs);
  const res = await lspSend('textDocument/rename', {
    textDocument: { uri: uriOf(abs) },
    position: { line: line - 1, character: column - 1 },
    newName,
  });
  if (res.error) return `rename failed: ${res.error.message}`;
  if (!res.result)
    return `No rename produced (is the cursor on a renameable symbol at ${line}:${column}?)`;
  const files = applyWorkspaceEdit(res.result);
  if (!files.length) return `Rename produced no on-disk changes.`;
  const total = files.reduce((n, f) => n + f.count, 0);
  const list = files.map((f) => `  ${f.file} (${f.count})`).join('\n');
  return `Renamed to '${newName}' — ${total} occurrences across ${files.length} file(s):\n${list}`;
}

async function toolReferences({ filePath, line, column }) {
  const abs = toAbs(filePath);
  await ensureChild(abs);
  await openAndSettle(abs);
  const res = await lspSend('textDocument/references', {
    textDocument: { uri: uriOf(abs) },
    position: { line: line - 1, character: column - 1 },
    context: { includeDeclaration: true },
  });
  if (res.error) return `references failed: ${res.error.message}`;
  const locs = fmtLocations(res.result);
  if (!locs.length) return `No references found at ${filePath}:${line}:${column}.`;
  return `${locs.length} reference(s):\n` + locs.map((l) => `  ${l}`).join('\n');
}

async function toolDefinition({ filePath, line, column }) {
  const abs = toAbs(filePath);
  await ensureChild(abs);
  await openAndSettle(abs);
  const res = await lspSend('textDocument/definition', {
    textDocument: { uri: uriOf(abs) },
    position: { line: line - 1, character: column - 1 },
  });
  if (res.error) return `definition failed: ${res.error.message}`;
  const locs = fmtLocations(res.result);
  if (!locs.length) return `No definition found at ${filePath}:${line}:${column}.`;
  return `Definition:\n` + locs.map((l) => `  ${l}`).join('\n');
}

async function toolHover({ filePath, line, column }) {
  const abs = toAbs(filePath);
  await ensureChild(abs);
  await openAndSettle(abs);
  const res = await lspSend('textDocument/hover', {
    textDocument: { uri: uriOf(abs) },
    position: { line: line - 1, character: column - 1 },
  });
  if (res.error) return `hover failed: ${res.error.message}`;
  const c = res.result?.contents;
  if (!c) return `No hover info at ${filePath}:${line}:${column}.`;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x.value)).join('\n');
  return c.value ?? JSON.stringify(c);
}

async function toolDiagnostics({ filePath }) {
  const abs = toAbs(filePath);
  await ensureChild(abs);
  await openAndSettle(abs, { waitDiag: true, timeoutMs: 15000 });
  // tsserver may emit syntactic then semantic rounds; give a short settle for the semantic pass.
  await sleep(600);
  const entry = diagnostics.get(uriOf(abs));
  const items = entry?.items ?? [];
  if (!items.length) return `No diagnostics for ${filePath}.`;
  const sev = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
  const lines = items.map((d) => {
    const p = d.range?.start ?? { line: 0, character: 0 };
    return `  ${sev[d.severity] ?? 'info'} ${p.line + 1}:${p.character + 1} ${d.message}${d.code != null ? ` [${d.code}]` : ''}`;
  });
  return `${items.length} diagnostic(s) for ${filePath}:\n` + lines.join('\n');
}

const TOOLS = {
  rename_symbol: {
    handler: toolRename,
    schema: {
      description:
        'Rename a symbol project-wide via the language server and APPLY the edits to disk. Give the ' +
        'position of the symbol (from a Read/grep). Returns a summary of changed files — do NOT re-read ' +
        "or re-write them. Scoped to the target file's package.",
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'File containing the symbol (absolute or repo-relative).',
          },
          line: { type: 'number', description: '1-indexed line of the symbol.' },
          column: { type: 'number', description: '1-indexed column of the symbol identifier.' },
          newName: { type: 'string', description: 'New name.' },
        },
        required: ['filePath', 'line', 'column', 'newName'],
      },
    },
  },
  references: {
    handler: toolReferences,
    schema: {
      description:
        'Find every usage of the symbol at the given POSITION (type-accurate, not text matches). ' +
        'Returns file:line:col locations.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          line: { type: 'number', description: '1-indexed line.' },
          column: { type: 'number', description: '1-indexed column of the symbol.' },
        },
        required: ['filePath', 'line', 'column'],
      },
    },
  },
  definition: {
    handler: toolDefinition,
    schema: {
      description:
        'Go to the definition of the symbol at the given POSITION. Returns file:line:col.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          line: { type: 'number', description: '1-indexed line.' },
          column: { type: 'number', description: '1-indexed column.' },
        },
        required: ['filePath', 'line', 'column'],
      },
    },
  },
  hover: {
    handler: toolHover,
    schema: {
      description: 'Type/signature/doc info for the symbol at the given POSITION.',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          line: { type: 'number', description: '1-indexed line.' },
          column: { type: 'number', description: '1-indexed column.' },
        },
        required: ['filePath', 'line', 'column'],
      },
    },
  },
  diagnostics: {
    handler: toolDiagnostics,
    schema: {
      description: 'Type errors/warnings for a file (from the language server, no full compile).',
      inputSchema: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
  },
};

// ── MCP server (newline-delimited JSON-RPC to the SDK) ──────────────────────────────────────────────
function mcpReply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function mcpError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handleMcp(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    mcpReply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'atlas-lsp-ts', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    mcpReply(id, {});
    return;
  }
  if (method === 'tools/list') {
    mcpReply(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.schema.description,
        inputSchema: t.schema.inputSchema,
      })),
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const tool = TOOLS[name];
    if (!tool) {
      mcpError(id, -32601, `Unknown tool: ${name}`);
      return;
    }
    try {
      const text = await tool.handler(args);
      mcpReply(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (err) {
      mcpReply(id, {
        content: [{ type: 'text', text: `Error: ${err?.message ?? err}` }],
        isError: true,
      });
    }
    return;
  }
  if (id != null) mcpError(id, -32601, `Unknown method: ${method}`);
}

// Serialize MCP handling so a re-root (child restart) can't interleave with the next call.
let mcpQueue = Promise.resolve();
let inBuf = '';
process.stdin.on('data', (d) => {
  inBuf += d.toString();
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i).trim();
    inBuf = inBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    mcpQueue = mcpQueue
      .then(() => handleMcp(msg))
      .catch((e) => log('handler error', e?.message ?? e));
  }
});
process.stdin.on('end', () => killChild());
