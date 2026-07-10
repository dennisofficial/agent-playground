import 'reflect-metadata';

import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DataSource } from 'typeorm';
import { audit } from './audit';
import { initDataSource } from './data-source';
import { loadEnv } from './env';
import { redactSecrets } from './redact';
import {
  TOOL_DEFS,
  TOOL_HANDLERS,
  type ToolCtx,
  type ToolRoots,
} from './tools';

/**
 * atlas-mcp-reader — a standalone, READ-ONLY MCP server exposing production job diagnostics to an
 * operator's MCP client (Claude Desktop, etc). Runs as its OWN process (`node dist/mcp-reader.js`,
 * NEVER wired into the Nest backend), against a SELECT-only Postgres role, over Streamable-HTTP with a
 * static `x-api-key` header. Every tool result is redacted (see redact.ts) before it leaves the process,
 * and every call is audited to stdout (see audit.ts). Session/transport plumbing mirrors
 * `app/sandbox/image/mcp-hub-server.ts`, minus the multi-upstream proxying (this process serves ITS OWN
 * tools directly — there's nothing to proxy to).
 */

function isAuthorized(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers['x-api-key'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(apiKey);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
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

class ReaderServer {
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();

  constructor(
    private readonly ds: DataSource,
    private readonly roots: ToolRoots,
    private readonly apiKey: string,
  ) {}

  listen(port: number): Promise<void> {
    const http = createServer((req, res) => void this.handle(req, res));
    return new Promise((resolve) =>
      http.listen(port, '0.0.0.0', () => resolve()),
    );
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const remote = req.socket.remoteAddress ?? 'unknown';
    if (!isAuthorized(req, this.apiKey)) {
      audit({ tool: 'auth', ok: false, remote });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
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
      // A new connection MUST open with `initialize` (POST); anything else without a live session → 400.
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'no valid mcp session (send initialize first)',
          }),
        );
        return;
      }
      const transport: StreamableHTTPServerTransport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            this.sessions.set(id, transport);
          },
        });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      const server = this.buildMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      const error = String(redactSecrets(String(err)));
      // eslint-disable-next-line no-console -- stdout IS this process's log
      console.log(`[mcp-reader] request error: ${error}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  private buildMcpServer(): Server {
    const server = new Server(
      { name: 'atlas-mcp-reader', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: TOOL_DEFS,
    }));
    server.setRequestHandler(CallToolRequestSchema, (r) =>
      this.callTool(r.params.name, r.params.arguments),
    );
    return server;
  }

  /** Dispatch one `tools/call`, redact the result at THE serialization choke point, and audit ok/error
   *  either way. A thrown handler error becomes an MCP `isError` result, never an HTTP-level failure. */
  private async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const jobId = typeof args?.jobId === 'string' ? args.jobId : undefined;
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      audit({ tool: name, jobId, ok: false, error: 'unknown tool' });
      return {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      };
    }
    const ctx: ToolCtx = { ds: this.ds, roots: this.roots, audit: {} };
    try {
      const result = await handler(ctx, args ?? {});
      audit({ tool: name, jobId, orgId: ctx.audit.orgId, ok: true });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(redactSecrets(result), null, 2),
          },
        ],
      };
    } catch (err) {
      const error = String(redactSecrets(String(err)));
      audit({ tool: name, jobId, orgId: ctx.audit.orgId, ok: false, error });
      return { content: [{ type: 'text', text: error }], isError: true };
    }
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const ds = await initDataSource(env);
  const server = new ReaderServer(
    ds,
    { agentHome: env.agentHomeRoot, repos: env.reposRoot },
    env.apiKey,
  );
  await server.listen(env.port);
  // eslint-disable-next-line no-console -- stdout IS this process's log
  console.log(`[mcp-reader] listening on 0.0.0.0:${env.port}`);
}

void main();
