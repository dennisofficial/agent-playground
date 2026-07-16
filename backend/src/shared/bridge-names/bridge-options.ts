/**
 * Tool-bridge → Claude SDK option assembly (R1). Extracted from `engine-entrypoint.ts` so the SHAPE
 * of the options handed to the SDK is unit-testable WITHOUT spawning the bundled entrypoint (which
 * runs `main()` on import).
 *
 * The host exposes tools over the bridge; inside the sandbox they're presented to the model as one
 * in-process MCP server (`atlas-host-bridge`). Two things must be exactly right or the model sees no
 * orchestration tools:
 *   1. The server must be passed under the SDK's `mcpServers` option — i.e. `{ mcpServers: { ... } }`
 *      — NOT the raw server map (which would spread as a stray top-level `Options` key and never
 *      register). This was the bug.
 *   2. The model addresses each tool as `mcp__<server>__<tool>`; those qualified names go into
 *      `allowedTools` so they're auto-approved (host-controlled — never a permission prompt).
 */

// The server name is single-sourced in `@workspace/shared` (the backend↔web contract); re-export it
// here so the many in-backend importers of `BRIDGE_SERVER_NAME` keep their existing import path.
import { BRIDGE_SERVER_NAME } from '@workspace/shared';
export { BRIDGE_SERVER_NAME };

/** How the model addresses each host tool over the bridge: `mcp__<server>__<tool>`. */
export function qualifyBridgeToolNames(toolNames: string[]): string[] {
  return toolNames.map((name) => `mcp__${BRIDGE_SERVER_NAME}__${name}`);
}

export interface BridgeClaudeOptions {
  /** Spread verbatim into the SDK `Options` — sets `options.mcpServers` (correct shape). */
  extraClaudeOptions: { mcpServers: Record<string, unknown> };
  /** Qualified `mcp__atlas-host-bridge__*` names to auto-approve via `allowedTools`. */
  bridgeToolNames: string[];
}

/**
 * Wrap the already-constructed in-process MCP `server` (built by the entrypoint with the real SDK +
 * the stdio proxy handlers) into the option shape EngineCore expects. Keeping this assembly here —
 * separate from the stdio-coupled server construction — is what makes the regression-prone shape
 * testable.
 */
export function buildBridgeClaudeOptions(
  server: unknown,
  toolNames: string[],
): BridgeClaudeOptions {
  return {
    extraClaudeOptions: { mcpServers: { [BRIDGE_SERVER_NAME]: server } },
    bridgeToolNames: qualifyBridgeToolNames(toolNames),
  };
}
