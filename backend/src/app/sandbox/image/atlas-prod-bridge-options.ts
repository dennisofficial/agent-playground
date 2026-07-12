/**
 * The dedicated `atlas-prod` MCP bridge — a THIRD in-process server that carries the relocated
 * prod-diagnostics read tools (query/schema/job-overview/session-raw/context-read/worktree tree+file)
 * plus the structurally-gated `propose_prod_write` tool, so the brain sees them as ONE coherent
 * section (`mcp__atlas-prod__*`) rather than loose tools scattered across the general
 * `atlas-host-bridge`. `propose_prod_write` only PROPOSES a write — an operator approval card gates
 * execution, which runs on a separate DML-only role; nothing here executes unapproved.
 *
 * The transport is unchanged: this bridge XADDs the SAME `tool_request` frame (a bare tool name +
 * args) over the same Redis streams as every other bridge, and the host dispatches by bare name
 * (`engine/tool-bridge-host.ts`), so bare names stay globally unique across ALL bridges. Grouping is
 * purely how the tools are PRESENTED to the model.
 *
 * `ATLAS_PROD_TOOL_NAMES` is the single source of truth for which bridge a tool lands on — the
 * entrypoint partitions the general host tool list by membership here (after the workspace-profile
 * partition), so the two partitions can never drift.
 */

/** The in-process MCP server name the atlas-prod tools are registered under. */
export const ATLAS_PROD_BRIDGE_NAME = 'atlas-prod';

/** The bare tool names that belong on the `atlas-prod` bridge: the 7 relocated prod-diagnostics
 *  reads plus the gated write proposal tool. Only ever registered for the Atlas repo. */
export const ATLAS_PROD_TOOL_NAMES = [
  'atlas_query',
  'atlas_schema',
  'atlas_job_overview',
  'atlas_session_raw',
  'atlas_context_read',
  'atlas_worktree_tree',
  'atlas_worktree_file',
  'propose_prod_write',
] as const;

const ATLAS_PROD_TOOL_SET: ReadonlySet<string> = new Set(ATLAS_PROD_TOOL_NAMES);

/** How the model addresses each atlas-prod tool: `mcp__atlas-prod__<tool>`. */
export function qualifyAtlasProdToolNames(toolNames: string[]): string[] {
  return toolNames.map((name) => `mcp__${ATLAS_PROD_BRIDGE_NAME}__${name}`);
}

/**
 * Split a flat host-bridge tool-name list into the tools that stay (`rest`) and the ones that move
 * to the `atlas-prod` bridge (`atlasProd`), preserving order.
 */
export function partitionAtlasProdTools(all: string[]): {
  rest: string[];
  atlasProd: string[];
} {
  const rest: string[] = [];
  const atlasProd: string[] = [];
  for (const name of all) (ATLAS_PROD_TOOL_SET.has(name) ? atlasProd : rest).push(name);
  return { rest, atlasProd };
}
