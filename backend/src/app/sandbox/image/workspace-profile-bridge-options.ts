/**
 * The dedicated `workspace-profile` MCP bridge — a SECOND in-process server that carries the
 * Workspace Profile dimension tools (secret files, mounts, setup script, MCP servers, skills, house
 * style) so the brain sees them as ONE coherent section (`mcp__workspace-profile__*`) rather than
 * loose tools scattered across the general `atlas-host-bridge`.
 *
 * The transport is unchanged: both bridges XADD the SAME `tool_request` frame (a bare tool name +
 * args) and the host dispatches by bare name (`engine/tool-bridge-host.ts`), so bare names stay
 * globally unique across BOTH bridges. Grouping is purely how the tools are PRESENTED to the model.
 *
 * `WORKSPACE_PROFILE_TOOL_NAMES` is the single source of truth for which bridge a tool lands on —
 * the entrypoint partitions `spec.toolBridgeTools` by membership here, and `AgentSessionManager`
 * cross-checks it against the actually-registered tools so the two never drift (see its spec).
 */

/** The in-process MCP server name the Workspace Profile tools are registered under. */
export const WORKSPACE_PROFILE_BRIDGE_NAME = 'workspace-profile';

/**
 * The bare tool names that belong on the `workspace-profile` bridge (every dimension's upkeep tool).
 * `reset_sandbox` is deliberately NOT here — it is generic sandbox control, not a profile dimension,
 * and stays on `atlas-host-bridge`. Convention tools are onboarding-only but still live on this
 * bridge when present (the partition is by name, and absent names simply don't match).
 */
export const WORKSPACE_PROFILE_TOOL_NAMES = [
  // Secret files
  'request_secret',
  'request_file',
  'withdraw_file_request',
  'derive_secret',
  // Mounts / cache
  'write_workspace_config',
  // Setup script
  'write_setup_script',
  // Skills
  'list_skills',
  'propose_skill',
  'propose_skill_install',
  'request_skill_edit_access',
  'propose_skill_removal',
  // MCP servers
  'list_mcp_servers',
  'propose_mcp_servers',
  'propose_mcp_removal',
  // House style
  'list_convention_profiles',
  'propose_convention_profile',
  'propose_convention_profile_change',
] as const;

const WORKSPACE_PROFILE_TOOL_SET: ReadonlySet<string> = new Set(WORKSPACE_PROFILE_TOOL_NAMES);

/** How the model addresses each Workspace Profile tool: `mcp__workspace-profile__<tool>`. */
export function qualifyWorkspaceProfileToolNames(toolNames: string[]): string[] {
  return toolNames.map((name) => `mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__${name}`);
}

/**
 * Split a flat host-bridge tool-name list into the tools that stay on `atlas-host-bridge` (`host`)
 * and the ones that move to the `workspace-profile` bridge (`profile`), preserving order.
 */
export function partitionWorkspaceProfileTools(all: string[]): {
  host: string[];
  profile: string[];
} {
  const host: string[] = [];
  const profile: string[] = [];
  for (const name of all) (WORKSPACE_PROFILE_TOOL_SET.has(name) ? profile : host).push(name);
  return { host, profile };
}
