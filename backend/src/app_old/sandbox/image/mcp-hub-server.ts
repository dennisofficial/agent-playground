import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import type { ResolvedMcpServer } from '../../../_shared/engine/engine.types';
import { CONTAINER_MCP_HUB_CONFIG, CONTAINER_MCP_HUB_DIR, MCP_HUB_PORT } from '../container-paths';
import {
  parseHubConfig,
  serverKey,
  type McpHubConfig,
  type McpHubSpawnIdentity,
} from './mcp-hub-config';
import { maybeDumpLargeResult, type DumpDeps } from './mcp-hub-dump';

const HUB_CLIENT_INFO = { name: 'atlas-mcp-hub', version: '1.0.0' };
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONFIG_POLL_MS = 10_000;

function log(msg: string): void {
  console.log(`[mcp-hub] ${msg}`);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function findSetpriv(exists: (p: string) => boolean = existsSync): string | undefined {
  for (const p of ['/usr/bin/setpriv', '/bin/setpriv', '/sbin/setpriv', '/usr/sbin/setpriv']) {
    if (exists(p)) return p;
  }
  return undefined;
}

export function buildStdioSpawn(
  spec: ResolvedMcpServer,
  spawn: McpHubSpawnIdentity,
  setprivPath: string | undefined,
): {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
} {
  const env = { ...spawn.baseEnv, HOME: spawn.home, ...(spec.env ?? {}) };
  const origArgs = spec.args ?? [];
  const command = spec.command ?? '';
  if (setprivPath && spawn.uid !== undefined && spawn.gid !== undefined) {
    return {
      command: setprivPath,
      args: [
        '--reuid',
        String(spawn.uid),
        '--regid',
        String(spawn.gid),
        '--clear-groups',
        '--',
        command,
        ...origArgs,
      ],
      env,
      cwd: spawn.cwd,
    };
  }
  return { command, args: origArgs, env, cwd: spawn.cwd };
}

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

export function validServer(s: ResolvedMcpServer): boolean {
  if (!s.name) return false;
  return s.transport === 'stdio' ? Boolean(s.command) : Boolean(s.url);
}

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
      return new StdioClientTransport({
        command: s.command,
        args: s.args,
        env: s.env,
        cwd: s.cwd,
        stderr: 'inherit',
      });
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
        log(
          `upstream ${this.spec.name} connected (${this.tools.length} tools, transport=${this.spec.transport})`,
        );
        return; // stay connected; onclose re-enters connectLoop
      } catch (err) {
        log(
          `upstream ${this.spec.name} connect failed: ${String(err)} — retry in ${this.backoff}ms`,
        );
        await delay(this.backoff);
        this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
      }
    }
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    if (!this.client || !this.connected)
      return errorResult(`MCP server "${this.spec.name}" is not connected`);
    try {
      return (await this.client.callTool({
        name,
        arguments: args ?? {},
      })) as CallToolResult;
    } catch (err) {
      return errorResult(`MCP server "${this.spec.name}" call failed: ${String(err)}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    try {
      await this.client?.close();
    } catch {}
  }
}

export class Hub {
  private readonly servers = new Map<string, UpstreamConnection>();
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private spawn: McpHubSpawnIdentity = {
    cwd: '/workspace',
    home: '/home/atlas',
    baseEnv: {},
  };
  private readonly setprivPath = findSetpriv();
  private http: HttpServer | undefined;

  constructor(private readonly dumpDeps?: Partial<DumpDeps>) {}

  registerTestUpstream(conn: {
    spec: Pick<ResolvedMcpServer, 'name'>;
    tools: Tool[];
    callTool: (name: string, args: Record<string, unknown> | undefined) => Promise<CallToolResult>;
  }): void {
    this.servers.set(conn.spec.name, conn as UpstreamConnection);
  }

  listen(port: number): Promise<void> {
    const http = createServer((req, res) => void this.handle(req, res));
    this.http = http;
    return new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const closeHttp =
      this.http === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            this.http?.close((err) => (err ? reject(err) : resolve()));
          });
    this.http = undefined;
    for (const transport of this.sessions.values()) {
      await transport.close();
    }
    this.sessions.clear();
    await Promise.all(
      [...this.servers.values()].map((conn) => {
        const close = (conn as { close?: () => Promise<void> }).close;
        return close ? close.call(conn) : Promise.resolve();
      }),
    );
    await closeHttp;
  }

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
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'no valid mcp session (send initialize first)',
          }),
        );
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
      const server = new Server(
        { name: `atlas-mcp-hub/${conn.spec.name}`, version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: conn.tools,
      }));
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

  process.on('SIGHUP', () => hub.loadAndReconcile());
  let lastMtime = 0;
  setInterval(() => {
    try {
      const m = statSync(CONTAINER_MCP_HUB_CONFIG).mtimeMs;
      if (m !== lastMtime) {
        lastMtime = m;
        hub.loadAndReconcile();
      }
    } catch {}
  }, CONFIG_POLL_MS);
}

if (process.argv[1]?.endsWith('mcp-hub-server.mjs')) {
  void main();
}
