
export const WORKSPACE_PROFILE_BRIDGE_NAME = 'workspace-profile';

export const WORKSPACE_PROFILE_TOOL_NAMES = [
  'request_secret',
  'request_file',
  'withdraw_file_request',
  'withdraw_secret_request',
  'derive_secret',
  'write_workspace_config',
  'write_setup_script',
  'read_setup_script',
  'write_preview_instructions',
  'read_preview_instructions',
  'list_skills',
  'propose_skill',
  'propose_skill_install',
  'request_skill_edit_access',
  'propose_skill_removal',
  'list_mcp_servers',
  'propose_mcp_servers',
  'propose_mcp_removal',
  'list_convention_profiles',
  'propose_convention_profile',
  'propose_convention_profile_change',
] as const;

const WORKSPACE_PROFILE_TOOL_SET: ReadonlySet<string> = new Set(WORKSPACE_PROFILE_TOOL_NAMES);

export function qualifyWorkspaceProfileToolNames(toolNames: string[]): string[] {
  return toolNames.map((name) => `mcp__${WORKSPACE_PROFILE_BRIDGE_NAME}__${name}`);
}

export function partitionWorkspaceProfileTools(all: string[]): {
  host: string[];
  profile: string[];
} {
  const host: string[] = [];
  const profile: string[] = [];
  for (const name of all) (WORKSPACE_PROFILE_TOOL_SET.has(name) ? profile : host).push(name);
  return { host, profile };
}
