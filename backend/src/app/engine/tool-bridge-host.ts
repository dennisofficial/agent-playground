/**
 * Host-side tool-bridge DISPATCH. When a turn's `RunEngineArgs.toolBridge` is set, the in-container
 * entrypoint proxies each host tool as a `tool_request` over Redis (`turn:{T}:tools`); the host executes
 * it here and replies with `tool_response`/`tool_error` on `turn:{T}:replies`, correlated by `id`. The
 * dispatch is transport-agnostic + Nest-free; `RedisEngineRunner.consumeTools` calls it. (The former pipe
 * `ToolBridgeHost` class + stdin/stdout framing were removed at the Redis cutover — ADR 0001.)
 */

import { inspect } from 'node:util';

import { ATLAS_PROD_TOOL_NAMES } from '../sandbox/image/atlas-prod-bridge-options';
import type { HostFrame, ToolBridgeOptions, ToolRequestFrame } from './engine.types';

/**
 * Tools that LEGITIMATELY carry a foreign `jobId` and are therefore EXEMPT from the per-thread scope
 * guard below. The `atlas-prod` diagnostics connector is repo-level by design: every read tool takes an
 * explicit `jobId` to inspect ANY job in the repo, and the whole bridge is only ever registered for the
 * Atlas repo (see atlas-prod-bridge-options.ts). It already grants full prod-read via `atlas_query`, so
 * exempting it crosses no new data boundary — it just stops the guard from clobbering the connector's
 * entire purpose. Every OTHER (thread-scoped) tool still has its foreign `jobId` denied.
 */
const CROSS_JOB_TOOL_NAMES: ReadonlySet<string> = new Set(ATLAS_PROD_TOOL_NAMES);

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
  // DEFENSIVE per-thread scope guard: a thread-scoped tool must never act on a DIFFERENT thread, so a
  // foreign `jobId` in its args is denied. The repo-level `atlas-prod` diagnostics tools are the exception
  // (CROSS_JOB_TOOL_NAMES) — they take an explicit `jobId` by design to inspect any job in the repo, so the
  // guard must skip them or it clobbers their whole purpose. Covered by r6-invariants.spec.ts.
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
