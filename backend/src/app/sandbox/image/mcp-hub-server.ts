/**
 * The persistent, sandbox-lifetime MCP HUB. ONE per sandbox, launched from `sandbox-init.sh`
 * (`start_mcp_hub`) as a detached background process — built-in Atlas infra, NOT an `atlas-svc` user
 * service. It solves the per-turn MCP cost + race: today every `docker exec` engine turn re-spawns every
 * stdio server and re-handshakes every remote server, and remote connects are NON-BLOCKING in the Claude
 * SDK so they race a short turn (tools absent at turn-1). The hub:
 *
 *   • connects UPSTREAM to each of the sandbox's user MCP servers ONCE (stdio spawn / http|sse handshake),
 *     runs `tools/list` once, caches it, and reconnects with backoff on drop;
 *   • serves each upstream to the per-turn engine on a LOCAL loopback route `127.0.0.1:<MCP_HUB_PORT>/<name>`
 *     (one stateless Streamable-HTTP MCP server per route). The engine points a Claude `type:'http'` server
 *     with `alwaysLoad:true` at each route (see `user-mcp-bridge-options.ts`); against the already-warm hub
 *     that connect resolves in ms, so tools are present at first inference — race killed — while the
 *     expensive upstream work is amortized to once per sandbox.
 *
 * Config (the resolved union of the sandbox's servers + a stdio `spawn` identity block) is written by the
 * host to `CONTAINER_MCP_HUB_CONFIG`; the hub reads it on boot, on `SIGHUP`, and on a slow mtime re-stat.
 *
 * FAILURE ISOLATION: a dead/slow upstream never blocks a turn — its route answers `tools/list` from cache
 * instantly and a `tools/call` returns an MCP error (not a hang). One bad upstream never stalls the listener
 * or another upstream (each connects independently).
 *
 * Bundled to `mcp-hub-server.mjs` (esbuild, no externals — `@modelcontextprotocol/sdk` bundled in) and
 * bind-mounted live like the engine bundle, so it hot-reloads without an image rebuild.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINER_MCP_HUB_CONFIG, CONTAINER_MCP_HUB_DIR, MCP_HUB_PORT } from '../container-paths';
import type { ResolvedMcpServer } from '../../engine/engine.types';
import {
  type McpHubConfig,
  type McpHubSpawnIdentity,
  parseHubConfig,
  serverKey,
} from './mcp-hub-config';
import { maybeDumpLargeResult, type DumpDeps } from './mcp-hub-dump';

const HUB_CLIENT_INFO = { name: 'atlas-mcp-hub', version: '1.0.0' };
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONFIG_POLL_MS = 10_000;

function log(msg: string): void {
  // eslint-disable-next-line no-console -- this process's stdout IS its log file (hub.log)
  console.log(`[mcp-hub] ${msg}`);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** setpriv (util-linux) location, or undefined if not installed — used to drop stdio children to host uid. */
export function findSetpriv(exists: (p: string) => boolean = existsSync): string | undefined {
  for (const p of ['/usr/bin/setpriv', '/bin/setpriv', '/sbin/setpriv', '/usr/sbin/setpriv']) {
    if (exists(p)) return p;
  }
  return undefined;
}

/**
 * Build the effective spawn for a STDIO upstream so it matches the per-turn `docker exec` identity rather
 * than the hub's own (root / PID1) one: cwd = `/workspace`, `HOME` = `/home/atlas`, base env + the server's
 * own env, and — when `setpriv` is present and a uid/gid was supplied — a privilege drop to the host uid so
 * files it writes to the worktree stay host-owned (not root). Degrades to a direct spawn (root) when setpriv
 * is unavailable, so a missing setpriv never breaks the server. Pure — unit-tested.
 */
export function buildStdioSpawn(
  spec: ResolvedMcpServer,
  spawn: McpHubSpawnIdentity,
  setprivPath: string | undefined,
): { command: string; args: string[]; env: Record<string, string>; cwd: string } {
  const env = { ...spawn.baseEnv, HOME: spawn.home, ...(spec.env ?? {}) };
  const origArgs = spec.args ?? [];
  const command = spec.command ?? '';
  if (setprivPath && spawn.uid !== undefined && spawn.gid !== undefined) {
    return {
      command: setprivPath,
      args: ['--reuid', String(spawn.uid), '--regid', String(spawn.gid), '--clear-groups', '--', command, ...origArgs],
      env,
      cwd: spawn.cwd,
    };
  }
  return { command, args: origArgs, env, cwd: spawn.cwd };
}

/** Decode the server name from a request URL path (`/deepwiki?x=1` → `deepwiki`), or null if none. */
export function decodeRoute(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split('?')[0].replace(/^\/+/, '');
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** Only servers with a name AND a usable endpoint are connectable — drop the rest (defensive; the host
 *  already filters reserved names). */
export function validServer(s: ResolvedMcpServer): boolean {
  if (!s.name) return false;
  return s.transport === 'stdio' ? Boolean(s.command) : Boolean(s.url);
}

/**
 * Reconcile diff — decide which upstreams to add, drop, or leave untouched, so a config edit to server A
 * never churns server B's live connection. Pure — unit-tested.
 */
export function diffServers(
  current: Map<string, { key: string }>,
  desired: ResolvedMcpServer[],
): { add: ResolvedMcpServer[]; remove: string[] } {
  const want = new Map(desired.filter(validServer).map((s) => [s.name, s]));
  const add: ResolvedMcpServer[] = [];
  const remove: string[] = [];
  for (const [name, s] of want) {
    const cur = current.get(name);
    if (!cur) add.push(s);
    else if (cur.key !== serverKey(s)) {
      remove.push(name);
      add.push(s);
    }
  }
  for (const name of current.keys()) if (!want.has(name)) remove.push(name);
  return { add, remove };
}

/** One persistent connection to an upstream MCP server: connect once, cache tools, reconnect on drop. */
class UpstreamConnection {
  readonly key: string;
  tools: Tool[] = [];
  private client: Client | undefined;
  private connected = false;
  private closed = false;
  private backoff = RECONNECT_MIN_MS;

  constructor(
    readonly spec: ResolvedMcpServer,
    private readonly spawn: McpHubSpawnIdentity,
    private readonly setprivPath: string | undefined,
  ) {
    this.key = serverKey(spec);
  }

  start(): void {
    void this.connectLoop();
  }

  private makeTransport(): Transport {
    if (this.spec.transport === 'stdio') {
      const s = buildStdioSpawn(this.spec, this.spawn, this.setprivPath);
      return new StdioClientTransport({ command: s.command, args: s.args, env: s.env, cwd: s.cwd, stderr: 'inherit' });
    }
    const url = new URL(this.spec.url as string);
    const requestInit = this.spec.headers ? { headers: this.spec.headers } : undefined;
    return this.spec.transport === 'sse'
      ? new SSEClientTransport(url, requestInit ? { requestInit } : undefined)
      : new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
  }

  private async connectLoop(): Promise<void> {
    while (!this.closed) {
      try {
        const client = new Client(HUB_CLIENT_INFO, { capabilities: {} });
        client.onclose = () => {
          if (!this.closed && this.connected) {
            this.connected = false;
            this.client = undefined;
            log(`upstream ${this.spec.name} disconnected — reconnecting`);
            void this.connectLoop();
          }
        };
        await client.connect(this.makeTransport());
        const listed = await client.listTools();
        this.client = client;
        this.tools = listed.tools ?? [];
        this.connected = true;
        this.backoff = RECONNECT_MIN_MS;
        log(`upstream ${this.spec.name} connected (${this.tools.length} tools, transport=${this.spec.transport})`);
        return; // stay connected; onclose re-enters connectLoop
      } catch (err) {
        log(`upstream ${this.spec.name} connect failed: ${String(err)} — retry in ${this.backoff}ms`);
        await delay(this.backoff);
        this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
      }
    }
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    if (!this.client || !this.connected) return errorResult(`MCP server "${this.spec.name}" is not connected`);
    try {
      return (await this.client.callTool({ name, arguments: args ?? {} })) as CallToolResult;
    } catch (err) {
      return errorResult(`MCP server "${this.spec.name}" call failed: ${String(err)}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    try {
      await this.client?.close();
    } catch {
      /* best-effort */
    }
  }
}

/** The hub: a route→UpstreamConnection map + one HTTP listener that proxies each route (stateful MCP
 *  sessions, so the SDK client's `initialize` → `tools/list` → `tools/call` sequence works as a normal MCP
 *  connection). Exported for integration testing (the process entry uses it via {@link main}). */
export class Hub {
  private readonly servers = new Map<string, UpstreamConnection>();
  /** Live Streamable-HTTP sessions keyed by the MCP session id the transport assigns on `initialize`. */
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private spawn: McpHubSpawnIdentity = { cwd: '/workspace', home: '/home/atlas', baseEnv: {} };
  private readonly setprivPath = findSetpriv();

  constructor(private readonly dumpDeps?: Partial<DumpDeps>) {}

  /** TEST-ONLY seam: register a pre-connected upstream directly, bypassing `reconcile()`'s real
   *  stdio/http spawn — lets integration tests drive the real `handle`/CallTool seam (and the dump
   *  middleware) against an in-process stub server instead of a live child process or network endpoint. */
  registerTestUpstream(conn: {
    spec: Pick<ResolvedMcpServer, 'name'>;
    tools: Tool[];
    callTool: (name: string, args: Record<string, unknown> | undefined) => Promise<CallToolResult>;
  }): void {
    this.servers.set(conn.spec.name, conn as UpstreamConnection);
  }

  listen(port: number): Promise<void> {
    const http = createServer((req, res) => void this.handle(req, res));
    return new Promise((resolve) => http.listen(port, '127.0.0.1', () => resolve()));
  }

  /** Route one HTTP request to its server's Streamable-HTTP transport (create the session on `initialize`,
   *  reuse it by `mcp-session-id` after). */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const name = decodeRoute(req.url);
    const conn = name ? this.servers.get(name) : undefined;
    if (!conn) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown mcp server route' }));
      return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400).end();
        return;
      }
    }
    const sidHeader = req.headers['mcp-session-id'];
    const sid = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;

    try {
      const existing = sid ? this.sessions.get(sid) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      // A new connection MUST open with `initialize` (POST). Anything else without a live session → 400.
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no valid mcp session (send initialize first)' }));
        return;
      }
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          this.sessions.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      const server = new Server({ name: `atlas-mcp-hub/${conn.spec.name}`, version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: conn.tools }));
      server.setRequestHandler(CallToolRequestSchema, async (r) => {
        const result = await conn.callTool(r.params.name, r.params.arguments);
        return maybeDumpLargeResult(
          {
            serverName: conn.spec.name,
            toolName: r.params.name,
            args: r.params.arguments,
            result,
          },
          this.dumpDeps,
        );
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`request error on route ${conn.spec.name}: ${String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  reconcile(config: McpHubConfig): void {
    this.spawn = config.spawn;
    const { add, remove } = diffServers(this.servers, config.servers);
    for (const name of remove) {
      const c = this.servers.get(name);
      if (c) {
        void c.close();
        this.servers.delete(name);
        log(`dropped upstream ${name}`);
      }
    }
    for (const s of add) {
      const c = new UpstreamConnection(s, this.spawn, this.setprivPath);
      this.servers.set(s.name, c);
      c.start();
    }
    log(`reconciled: ${this.servers.size} upstream server(s)`);
  }

  loadAndReconcile(): void {
    let raw: string;
    try {
      raw = readFileSync(CONTAINER_MCP_HUB_CONFIG, 'utf8');
    } catch {
      log('no hub config yet — waiting');
      return;
    }
    const config = parseHubConfig(raw);
    if (!config) {
      log('hub config unreadable/partial — keeping current connections');
      return;
    }
    this.reconcile(config);
  }
}

/** Read + JSON-parse a request body (empty body → undefined so a bodyless POST doesn't throw). */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

async function main(): Promise<void> {
  mkdirSync(CONTAINER_MCP_HUB_DIR, { recursive: true });
  try {
    writeFileSync(join(CONTAINER_MCP_HUB_DIR, 'hub.pid'), String(process.pid));
  } catch (err) {
    log(`could not write pidfile: ${String(err)}`);
  }
  const hub = new Hub();
  await hub.listen(MCP_HUB_PORT);
  log(`listening on 127.0.0.1:${MCP_HUB_PORT}`);
  hub.loadAndReconcile();

  // Host signals a config change with SIGHUP (see SandboxManager.kickMcpHubRefresh); an mtime re-stat is a
  // belt-and-suspenders fallback in case a signal is missed (inotify over bind mounts can be unreliable).
  process.on('SIGHUP', () => hub.loadAndReconcile());
  let lastMtime = 0;
  setInterval(() => {
    try {
      const m = statSync(CONTAINER_MCP_HUB_CONFIG).mtimeMs;
      if (m !== lastMtime) {
        lastMtime = m;
        hub.loadAndReconcile();
      }
    } catch {
      /* no config yet */
    }
  }, CONFIG_POLL_MS);
}

// Run only when invoked directly as the bundled entry (`node mcp-hub-server.mjs` from sandbox-init.sh),
// never when imported by the spec. `import.meta` is avoided so tsc's CommonJS typecheck accepts this file
// (it is esbuild-bundled to ESM separately for the sandbox); argv[1] is the launched script path.
if (process.argv[1]?.endsWith('mcp-hub-server.mjs')) {
  void main();
}
