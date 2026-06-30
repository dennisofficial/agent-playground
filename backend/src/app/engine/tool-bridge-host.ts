/**
 * Host-side tool-bridge DISPATCH. When a turn's `RunEngineArgs.toolBridge` is set, the in-container
 * entrypoint proxies each host tool as a `tool_request` over Redis (`turn:{T}:tools`); the host executes
 * it here and replies with `tool_response`/`tool_error` on `turn:{T}:replies`, correlated by `id`. The
 * dispatch is transport-agnostic + Nest-free; `RedisEngineRunner.consumeTools` calls it. (The former pipe
 * `ToolBridgeHost` class + stdin/stdout framing were removed at the Redis cutover — ADR 0001.)
 */

import type { HostFrame, ToolBridgeOptions, ToolRequestFrame } from './engine.types';

/**
 * Execute ONE host-bridge tool request and return the correlated reply frame. Enforces the per-thread
 * scope (a request naming another thread is denied) and never throws (errors → `tool_error`).
 */
export async function dispatchToolRequest(
  bridge: ToolBridgeOptions,
  req: ToolRequestFrame,
): Promise<HostFrame> {
  const { id, name, args } = req;
  if (typeof args['threadId'] === 'string' && args['threadId'] !== bridge.threadId) {
    return {
      t: 'tool_error',
      id,
      message: `Thread scope violation: tool '${name}' requested for thread '${args['threadId']}' but this exec belongs to thread '${bridge.threadId}'`,
    };
  }
  const impl = bridge.tools[name];
  if (!impl) return { t: 'tool_error', id, message: `Unknown tool: '${name}'` };
  try {
    const result = await impl(args);
    return { t: 'tool_response', id, result };
  } catch (err) {
    return { t: 'tool_error', id, message: err instanceof Error ? err.message : String(err) };
  }
}
