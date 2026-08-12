import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ZodRawShape } from 'zod';

/**
 * The server name, which is also half of every Atlas tool's wire name: the SDK exposes an in-process
 * MCP tool as `mcp__<server>__<tool>`. Short and stable, because it appears in every transcript.
 */
export const ATLAS_MCP_SERVER = 'atlas';

/**
 * A tool as the TRANSPORT sees it — a name, a description, a zod shape and a function from parsed
 * arguments to a string the agent reads back.
 *
 * Deliberately no MCP in this type, and no engine either. The registry above builds these out of
 * NestJS services and never imports the SDK; this file is the only place that knows an Atlas tool
 * becomes an MCP tool, which is what makes a second engine a second transport rather than a second
 * registry. The handler returns a plain string for the same reason: `CallToolResult` is an MCP
 * shape, and it stops here.
 */
export type EngineTool = {
  name: string;
  description: string;
  shape: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<string>;
};

/**
 * The Claude transport: an in-process SDK MCP server whose handlers are closures over live services.
 *
 * No subprocess, no socket, no Redis. Legacy needed a stdio bridge and a Redis round trip only
 * because the agent lived in a pod and the host did not; locally the agent is a child process of the
 * thing that owns the database, so a tool call is a function call.
 */
export function atlasToolServer(
  tools: readonly EngineTool[],
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: ATLAS_MCP_SERVER,
    version: '1.0.0',
    tools: tools.map((entry) =>
      tool(entry.name, entry.description, entry.shape, async (args) =>
        runTool(entry, args),
      ),
    ),
  });
}

/**
 * What the session must auto-approve. Distinct from which tools EXIST — `Options.tools` decides
 * that for natives and `mcpServers` decides it for these — and listed anyway so that Atlas's own
 * tools never depend on `permissionMode` to run.
 */
export function atlasToolNames(tools: readonly EngineTool[]): string[] {
  return tools.map((entry) => `mcp__${ATLAS_MCP_SERVER}__${entry.name}`);
}

/**
 * A throw becomes a tool ERROR the agent can read and react to, never an exception that takes the
 * turn down. A seam tool refusing — "that role is not offered in this phase" — is ordinary
 * conversation; the agent should get a sentence and another go, which is also why the message is
 * prose rather than a stack.
 */
async function runTool(
  entry: EngineTool,
  args: unknown,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const text = await entry.handler(asRecord(args));
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: detail }], isError: true };
  }
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) return {};
  return { ...args };
}
