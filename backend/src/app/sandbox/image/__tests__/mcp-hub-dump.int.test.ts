import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { Hub } from '../mcp-hub-server';
import { DUMP_SUBDIR, DUMP_THRESHOLD_BYTES } from '../mcp-hub-dump';

/** Grab a free loopback port by briefly binding to port 0, then releasing it — `Hub.listen()` takes a
 *  fixed port rather than returning the one it bound, so tests need to pick one up front. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe('hub dump middleware — end to end', () => {
  let playgroundDir: string;
  let hub: Hub | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    playgroundDir = mkdtempSync(join(tmpdir(), 'mcp-hub-dump-int-'));
  });

  afterEach(async () => {
    await client?.close();
    await hub?.close();
    rmSync(playgroundDir, { recursive: true, force: true });
  });

  it('writes an oversized tools/call result to /playground/atlas-mcp and returns a compact envelope', async () => {
    const bigRows = Array.from({ length: 2000 }, (_, i) => ({
      id: i,
      name: `row-${i}`,
      note: 'x'.repeat(20),
    }));
    const fullPayload = JSON.stringify({
      format: 'json',
      rows: bigRows,
      rowCount: bigRows.length,
    });
    expect(Buffer.byteLength(fullPayload, 'utf8')).toBeGreaterThan(
      DUMP_THRESHOLD_BYTES,
    );

    const stubTool: Tool = {
      name: 'big_query',
      description: 'returns a large result',
      inputSchema: { type: 'object' },
    };
    const stubResult: CallToolResult = {
      content: [{ type: 'text', text: fullPayload }],
    };

    hub = new Hub({ playgroundDir });
    hub.registerTestUpstream({
      spec: { name: 'stub-upstream' },
      tools: [stubTool],
      callTool: () => Promise.resolve(stubResult),
    });

    const port = await findFreePort();
    await hub.listen(port);

    client = new Client(
      { name: 'integration-test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/stub-upstream`),
    );
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['big_query']);

    const result = (await client.callTool({
      name: 'big_query',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const envelope = JSON.parse(
      (result.content[0] as { text: string }).text,
    ) as {
      dumpedTo: string;
      format: string;
      rowCount: number;
      bytes: number;
      preview: string;
    };

    const dumpDir = join(playgroundDir, DUMP_SUBDIR);
    expect(envelope.dumpedTo.startsWith(dumpDir + sep)).toBe(true);
    expect(envelope.format).toBe('json');
    expect(envelope.rowCount).toBe(bigRows.length);
    expect(envelope.bytes).toBeGreaterThan(DUMP_THRESHOLD_BYTES);
    expect(envelope.preview.length).toBeGreaterThan(0);

    const onDisk = readFileSync(envelope.dumpedTo, 'utf8');
    expect(JSON.parse(onDisk)).toEqual(bigRows);

    const mode = statSync(envelope.dumpedTo).mode;
    expect(mode & 0o400).toBeTruthy(); // owner-readable
  });
});
