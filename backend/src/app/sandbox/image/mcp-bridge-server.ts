/**
 * The in-sandbox stdio MCP server that gives a CODEX turn a host tool bridge (parity with the Claude
 * in-process bridge in `engine-entrypoint.ts`). Codex spawns THIS as a subprocess (declared in the
 * per-sandbox `config.toml` `[mcp_servers.atlasbridge]` block written by `codex-auth-home.ts`), so unlike
 * the Claude bridge — which runs in the engine process and shares its Redis client — this owns its OWN
 * Redis connections and does the identical `tool_request`/reply round-trip over the turn's streams:
 *
 *   XADD `turn:{T}:tools`  { t:'tool_request', id, name, args }   (engine→host; served by the host's
 *   await reply on `turn:{T}:replies`  { t:'tool_response'|'tool_error', id, … }   `consumeTools` loop)
 *
 * The host side (`redis-engine-runner.ts` `consumeTools` + `tool-bridge-host.ts` `dispatchToolRequest`)
 * is engine-agnostic and reused unchanged — it doesn't care that the frame came from this subprocess
 * rather than the engine. Env is supplied by the config.toml `[mcp_servers.atlasbridge.env]` block:
 * `TURN_ID`, `REDIS_URL`, `BRIDGE_TOOLS` (comma-separated host tool names). A fresh docker exec per Atlas
 * turn → fresh codex → fresh spawn of this server reading the CURRENT turn's `config.toml`, so the turn
 * id is always current (no stale-key risk across a resumed session).
 *
 * NOTE: codex surfaces these tools NAMESPACED to the model (e.g. `atlasbridge__complete_thread`), but the
 * `name` we put in the `tool_request` frame is the BARE tool name, so the host's `dispatchToolRequest`
 * (which matches on the bare name) resolves it exactly like a Claude bridge call.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ToolBridgeReader } from './tool-bridge-reader';
import { toolJsonSchema, TOOL_DESCRIPTIONS } from './host-tool-schemas';

async function main(): Promise<void> {
  const turnId = process.env.TURN_ID;
  if (!turnId) throw new Error('mcp-bridge-server: TURN_ID is required');
  const redisUrl = process.env.REDIS_URL ?? 'redis://redis:6379';
  const toolNames = (process.env.BRIDGE_TOOLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (toolNames.length === 0) throw new Error('mcp-bridge-server: BRIDGE_TOOLS is empty');

  const toolsKey = `turn:${turnId}:tools`;
  const repliesKey = `turn:${turnId}:replies`;

  const pub = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
  await pub.connect();

  // Reply reader: a blocking read on the replies stream (its own connection(s) — a blocking read can't
  // share `pub`), resolving pending calls by id. Reads from '0-0' — the stream is fresh per turn, so
  // there are no stale replies to skip. `makeSub` also assigns the outer `sub` so stdin-close cleanup
  // always disconnects whichever connection is CURRENT (the reader swaps it internally on a stall-reset).
  let sub: Redis | undefined;
  const reader = new ToolBridgeReader({
    repliesKey,
    makeSub: () => {
      sub = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
      return sub;
    },
    log: (m) => process.stderr.write(`[mcp-bridge-server] ${m}\n`),
  });
  reader.start();

  const callHostTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const id = randomUUID();
    const p = reader.register(id);
    try {
      await pub.xadd(toolsKey, '*', 'data', JSON.stringify({ t: 'tool_request', id, name, args }));
    } catch (err) {
      reader.cancel(id);
      throw err;
    }
    return p;
  };

  const server = new Server({ name: 'atlasbridge', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name] ?? `Host-side tool '${name}' proxied via the Atlas bridge.`,
      inputSchema: toolJsonSchema(name),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await callHostTool(name, args);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)) || 'host tool error (no message)';
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  // Keep the process alive; codex terminates it when the turn ends. Clean up on stdin close.
  process.stdin.on('close', () => {
    reader.stopReader();
    pub.disconnect();
    sub?.disconnect();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[mcp-bridge-server] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
