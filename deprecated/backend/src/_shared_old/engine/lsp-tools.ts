export const LSP_SERVER_NAME = 'atlas-lsp-ts';

export const LSP_TOOL_NAMES = ['rename_symbol', 'references', 'definition', 'hover', 'diagnostics'];

export const LSP_NAV_TOOL_NAMES = LSP_TOOL_NAMES.filter((name) => name !== 'rename_symbol');

export function qualifyLspToolNames(toolNames: string[]): string[] {
  return toolNames.map((name) => `mcp__${LSP_SERVER_NAME}__${name}`);
}
