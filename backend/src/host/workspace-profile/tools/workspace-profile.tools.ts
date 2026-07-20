/**
 * The agent-facing `workspace-profile` MCP tool SURFACE — the tools the agent calls to evolve its own
 * workspace (edit instructions, request secrets/files, manage mounts). One tool server mutating all three
 * profile halves (instructions + mounts + secrets), which is why they co-locate in this module.
 *
 * DECLARATION ONLY this pass: the names reserve the surface (mirroring the sibling `ATLAS_HOST_BRIDGE_TOOLS`
 * const-tuple in `@workspace/shared`, and reconciling the `WORKSPACE_PROFILE_TOOL_NAMES` reservation noted
 * in `shared/src/types/host-tools.ts`). Schemas + dispatch to the services land with the engine/bridge.
 */

export const WORKSPACE_PROFILE_SERVER_NAME = 'workspace-profile';

export const WORKSPACE_PROFILE_TOOL_NAMES = [
  // instructions
  'write_setup_script',
  'read_setup_script',
  'write_preview_instructions',
  'read_preview_instructions',
  // mounts
  'write_workspace_config',
  // secret files
  'request_secret',
  'request_file',
] as const;

export type WorkspaceProfileTool = (typeof WORKSPACE_PROFILE_TOOL_NAMES)[number];
