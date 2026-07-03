/**
 * Context7 docs MCP → Claude SDK option assembly. Mirrors `lsp-bridge-options.ts`: the SHAPE of the
 * options handed to the SDK lives here, unit-testable without spawning the bundled entrypoint.
 *
 * Context7 is a REMOTE (HTTP) MCP server — unlike `atlas-lsp-ts` (a stdio server baked into the image),
 * the SDK talks to Upstash's hosted endpoint over the sandbox's NAT egress. It gives the `docs` subagent
 * curated, version-pinned library docs (see engine/context7-tools.ts for the rationale + tool names).
 *
 * OFF BY DEFAULT — returns `undefined` unless `CONTEXT7_API_KEY` is present in the container env, so an
 * unconfigured deployment adds no network dependency at sandbox boot. Registered on execute-mode turns
 * only (same gate as the LSP bridge): that covers the brain/chat turn and the build turns, which are the
 * only turns that can spawn the `docs` subagent.
 *
 * Tool-name constants live in `engine/context7-tools.ts` (shared with `engine-core.ts`'s `docs` tool
 * list) — not here, to keep this file's only job the SDK-option shape.
 */
import type { SessionMode } from '../../domain';
import {
  CONTEXT7_SERVER_NAME,
  CONTEXT7_URL,
  context7ApiKey,
  qualifyContext7ToolNames,
} from '../../engine/context7-tools';

export interface Context7BridgeOptions {
  /** `{ mcpServers: { context7: { type, url, headers } } }` — spread verbatim into the SDK `Options`. */
  extraClaudeOptions: { mcpServers: Record<string, unknown> };
  /** Qualified `mcp__context7__*` names to auto-approve via `allowedTools`. */
  context7ToolNames: string[];
}

/**
 * Build the Context7 bridge options for a turn, or `undefined` when Context7 is unconfigured or this
 * turn's mode shouldn't get one. Keep this gate identical to `CONTEXT7_TOOLS` in `engine-core.ts` so the
 * `docs` subagent is never told about a tool whose server isn't registered.
 */
export function buildContext7BridgeOptions(mode: SessionMode): Context7BridgeOptions | undefined {
  if (mode !== 'execute') return undefined;
  const apiKey = context7ApiKey();
  if (!apiKey) return undefined;
  return {
    extraClaudeOptions: {
      mcpServers: {
        [CONTEXT7_SERVER_NAME]: {
          type: 'http',
          url: CONTEXT7_URL,
          headers: { CONTEXT7_API_KEY: apiKey },
        },
      },
    },
    context7ToolNames: qualifyContext7ToolNames(),
  };
}
