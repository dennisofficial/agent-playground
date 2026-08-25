export const ATLAS_PROD_BRIDGE_NAME = 'atlas-prod';

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

export function qualifyAtlasProdToolNames(toolNames: string[]): string[] {
  return toolNames.map((name) => `mcp__${ATLAS_PROD_BRIDGE_NAME}__${name}`);
}

export function partitionAtlasProdTools(all: string[]): {
  rest: string[];
  atlasProd: string[];
} {
  const rest: string[] = [];
  const atlasProd: string[] = [];
  for (const name of all) (ATLAS_PROD_TOOL_SET.has(name) ? atlasProd : rest).push(name);
  return { rest, atlasProd };
}
