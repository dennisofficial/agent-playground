import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { TOOL_DESCRIPTIONS, toolJsonSchema } from './host-tool-schemas';
import { ToolBridgeReader } from './tool-bridge-reader';

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

  const pub = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
  await pub.connect();

  let sub: Redis | undefined;
  const reader = new ToolBridgeReader({
    repliesKey,
    makeSub: () => {
      sub = new Redis(redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: null,
      });
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

  const server = new Server(
    { name: 'atlasbridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map((name) => ({
      name,
      description:
        TOOL_DESCRIPTIONS[name] ?? `Host-side tool '${name}' proxied via the Atlas bridge.`,
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
      const message =
        (err instanceof Error ? err.message : String(err)) || 'host tool error (no message)';
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
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
