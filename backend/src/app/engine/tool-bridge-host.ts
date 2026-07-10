/**
 * Host-side tool-bridge DISPATCH. When a turn's `RunEngineArgs.toolBridge` is set, the in-container
 * entrypoint proxies each host tool as a `tool_request` over Redis (`turn:{T}:tools`); the host executes
 * it here and replies with `tool_response`/`tool_error` on `turn:{T}:replies`, correlated by `id`. The
 * dispatch is transport-agnostic + Nest-free; `RedisEngineRunner.consumeTools` calls it. (The former pipe
 * `ToolBridgeHost` class + stdin/stdout framing were removed at the Redis cutover — ADR 0001.)
 */

import { inspect } from 'node:util';

import type { HostFrame, ToolBridgeOptions, ToolRequestFrame } from './engine.types';

/**
 * Never-empty, BOUNDED error text for a thrown tool value — safe to send back through the sandbox
 * reader/proxy to the model/UI (no full stack; the stack goes only to the host-side `onToolError` sink).
 * A bare `Error:` in the operator UI is what this exists to prevent (an empty `.message` on a thrown
 * error would otherwise ride back verbatim). Uses `inspect` (NOT `JSON.stringify`, which throws on
 * circular/BigInt — and this runs inside `dispatchToolRequest`'s never-throw catch).
 */
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

/**
 * Execute ONE host-bridge tool request and return the correlated reply frame. Enforces the per-thread
 * scope (a request naming another thread is denied) and never throws (errors → `tool_error`).
 */
export async function dispatchToolRequest(
  bridge: ToolBridgeOptions,
  req: ToolRequestFrame,
): Promise<HostFrame> {
  const { id, name } = req;
  const args = (req.args ?? {}) as Record<string, unknown>;
  // DEFENSIVE: both engines now send flat, strict-validated payloads and no tool schema declares `jobId`,
  // so the model can no longer smuggle a foreign jobId (it is stripped client-side before it reaches us).
  // This host-side guard remains as defense-in-depth for any permissive path (covered by r6-invariants.spec.ts).
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
    // Bounded message rides back to the sandbox; the FULL stack goes only to the host log so a real
    // cause (e.g. a bare `QueryFailedError`) is never swallowed into an empty `Error:` in the UI.
    const message = formatToolError(err);
    const detail = err instanceof Error ? (err.stack ?? err.message) : inspect(err);
    (bridge.onToolError ?? ((l: string) => console.error(l)))(
      `[tool-bridge] tool '${name}' (job ${bridge.jobId}) failed: ${detail}`,
    );
    return { t: 'tool_error', id, message };
  }
}
