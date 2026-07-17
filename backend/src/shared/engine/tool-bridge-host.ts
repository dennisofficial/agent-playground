
import { inspect } from 'node:util';

import { ATLAS_PROD_TOOL_NAMES } from '../bridge-names/atlas-prod-bridge-options';
import type { HostFrame, ToolBridgeOptions, ToolRequestFrame } from './engine.types';

const CROSS_JOB_TOOL_NAMES: ReadonlySet<string> = new Set(ATLAS_PROD_TOOL_NAMES);

export function formatToolError(err: unknown): string {
  if (err instanceof Error) {
    const m = (err.message ?? '').trim();
    if (m) return m;
    if (err.name) return err.name; // e.g. "QueryFailedError"
    if (err.stack) return err.stack.split('\n')[0].trim();
    return inspect(err);
  }
  const s = String(err ?? '').trim();
  return s || inspect(err) || 'unknown tool error (empty)';
}

export async function dispatchToolRequest(
  bridge: ToolBridgeOptions,
  req: ToolRequestFrame,
): Promise<HostFrame> {
  const { id, name } = req;
  const args = (req.args ?? {}) as Record<string, unknown>;
  if (
    !CROSS_JOB_TOOL_NAMES.has(name) &&
    typeof args['jobId'] === 'string' &&
    args['jobId'] !== bridge.jobId
  ) {
    return {
      t: 'tool_error',
      id,
      message: `Thread scope violation: tool '${name}' requested for thread '${args['jobId']}' but this exec belongs to thread '${bridge.jobId}'`,
    };
  }
  const impl = bridge.tools[name];
  if (!impl) return { t: 'tool_error', id, message: `Unknown tool: '${name}'` };
  try {
    const result = await impl(args);
    return { t: 'tool_response', id, result };
  } catch (err) {
    const message = formatToolError(err);
    const detail = err instanceof Error ? (err.stack ?? err.message) : inspect(err);
    (bridge.onToolError ?? ((l: string) => console.error(l)))(
      `[tool-bridge] tool '${name}' (job ${bridge.jobId}) failed: ${detail}`,
    );
    return { t: 'tool_error', id, message };
  }
}
