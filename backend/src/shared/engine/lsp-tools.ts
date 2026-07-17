/**
 * Shared LSP tool-name constants — the single source of truth for both:
 *   - `sandbox/image/lsp-bridge-options.ts` (registers `atlas-lsp-ts` as an external MCP server, only on
 *     execute-mode turns)
 *   - `engine-core.ts` (adds the qualified names to the writer/read-only SUBAGENTS' `tools:` arrays —
 *     subagents don't inherit the parent turn's `allowedTools`, so each needs them explicitly)
 *
 * Lives here (in `engine/`, not `sandbox/image/`) so `engine-core.ts` never has to import from
 * `sandbox/image` — that dependency only runs the other way (the in-container entrypoint imports
 * `EngineCore`, not vice versa).
 */

/** The external MCP server name the LSP tools are registered under (mcp-language-server, per-turn). */
export const LSP_SERVER_NAME = 'atlas-lsp-ts';

/**
 * The full LSP tool surface (mutating + read-only). Deliberately excludes mcp-language-server's
 * `edit_file` — a generic line-range text editor with no LSP semantics, redundant with (and potentially
 * confusing next to) the SDK's native `Edit` tool.
 */
export const LSP_TOOL_NAMES = ['rename_symbol', 'references', 'definition', 'hover', 'diagnostics'];

/** Read-only subset — everything except `rename_symbol`, for subagents that must not mutate files. */
export const LSP_NAV_TOOL_NAMES = LSP_TOOL_NAMES.filter((name) => name !== 'rename_symbol');

/** How the model addresses each LSP tool: `mcp__atlas-lsp-ts__<tool>`. */
export function qualifyLspToolNames(toolNames: string[]): string[] {
  return toolNames.map((name) => `mcp__${LSP_SERVER_NAME}__${name}`);
}
