/**
 * Host-side tool-bridge DISPATCH. When a turn's `RunEngineArgs.toolBridge` is set, the in-container
 * entrypoint proxies each host tool as a `tool_request` over Redis (`turn:{T}:tools`); the host executes
 * it here and replies with `tool_response`/`tool_error` on `turn:{T}:replies`, correlated by `id`. The
 * dispatch is transport-agnostic + Nest-free; `RedisEngineRunner.consumeTools` calls it. (The former pipe
 * `ToolBridgeHost` class + stdin/stdout framing were removed at the Redis cutover — ADR 0001.)
 */

import type { HostFrame, ToolBridgeOptions, ToolRequestFrame } from './engine.types';

/**
 * Normalise the arguments a bridged tool call arrives with. The in-sandbox proxy registers EVERY host tool
 * under a generic `{ args: <record> }` schema (see `engine-entrypoint.ts` `makeProxyTool`), and the model
 * frequently MIS-NESTS its payload against that meta-schema — double-wrapping (`{ args: { passed: true } }`)
 * or even passing the whole thing as a JSON STRING — which the entrypoint's single `input.args` unwrap does
 * not fully undo. Left as-is the handler reads its fields off a wrapper (`args['passed']` → undefined) and
 * silently mis-parses to a wrong/empty payload (this is the `report_verification` gate false-halt bug).
 *
 * This JSON-parses a stringified payload and peels any LONE-`args` wrapper layers until the real payload
 * surfaces. Safe: a genuine payload (`{ passed, remaining }`, `{ summary }`, `{ jobId, … }`) has keys beyond
 * a single `args`, so it is never over-unwrapped; and it is bounded against pathological nesting.
 */
export function unwrapBridgeArgs(raw: unknown): Record<string, unknown> {
  let cur: unknown = raw;
  for (let i = 0; i < 6; i++) {
    if (typeof cur === 'string') {
      try {
        cur = JSON.parse(cur);
        continue;
      } catch {
        return {};
      }
    }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return {};
    const keys = Object.keys(cur as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === 'args') {
      cur = (cur as Record<string, unknown>)['args'];
      continue;
    }
    return cur as Record<string, unknown>;
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>) : {};
}

/**
 * Execute ONE host-bridge tool request and return the correlated reply frame. Enforces the per-thread
 * scope (a request naming another thread is denied) and never throws (errors → `tool_error`).
 */
export async function dispatchToolRequest(
  bridge: ToolBridgeOptions,
  req: ToolRequestFrame,
): Promise<HostFrame> {
  const { id, name } = req;
  // Peel the model's `{ args }` mis-nesting / stringification before the handler sees it (and before the
  // scope check reads `jobId`), so every host tool gets its real payload regardless of how the model wrapped it.
  const args = unwrapBridgeArgs(req.args);
  if (typeof args['jobId'] === 'string' && args['jobId'] !== bridge.jobId) {
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
    return { t: 'tool_error', id, message: err instanceof Error ? err.message : String(err) };
  }
}
