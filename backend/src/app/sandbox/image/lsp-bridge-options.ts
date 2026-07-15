/**
 * LSP tool-bridge → Claude SDK option assembly. Mirrors `bridge-options.ts`'s separation: the SHAPE of
 * the options handed to the SDK lives here, unit-testable without spawning the bundled entrypoint.
 *
 * Unlike the host bridge (an in-process `createSdkMcpServer` proxying tool calls to the host over
 * Redis), `atlas-lsp-ts` is an EXTERNAL stdio MCP server — the SDK spawns `atlas-lsp-server.mjs` (our
 * own direct LSP-client MCP server, baked into the sandbox image), which drives
 * `typescript-language-server` over LSP against the turn's own worktree, re-rooted per target file. No
 * host round-trip; the language server's warm program lives and dies with the turn.
 *
 * Registered ONLY for execute-mode turns (`mode: 'execute'`) — this covers BOTH the brain/chat turn
 * (`agent-session-manager.service.ts`) and the build orchestrator/writer turns (`thread-driver.service.ts`),
 * which both run with `mode: 'execute'`. Plan/review/investigate turns can't Write/Edit anyway, so
 * spawning a language server there would index a project for nothing.
 *
 * Tool-name constants live in `engine/lsp-tools.ts` (shared with `engine-core.ts`'s subagent tool
 * lists) — not here, to keep this file's only job the SDK-option shape.
 */
import type { SessionMode } from '../../domain';
import {
  LSP_SERVER_NAME,
  LSP_TOOL_NAMES,
  qualifyLspToolNames,
} from '../../engine/lsp-tools';

export interface LspBridgeOptions {
  /** `{ mcpServers: { 'atlas-lsp-ts': { command, args } } }` — spread verbatim into the SDK `Options`. */
  extraClaudeOptions: { mcpServers: Record<string, unknown> };
  /** Qualified `mcp__atlas-lsp-ts__*` names to auto-approve via `allowedTools`. */
  lspToolNames: string[];
}

/**
 * Build the LSP bridge options for a turn, or `undefined` if this turn's mode shouldn't get one.
 *
 * `workspaceDir` is the turn's `cwd` — mcp-language-server confines tsserver to it. That's the tool's
 * real confinement boundary (rename_symbol can't touch a path outside it), the same way Bash is
 * confined by the sandbox container itself rather than by `canUseTool`'s Write/Edit path check.
 */
export function buildLspBridgeOptions(
  mode: SessionMode,
  workspaceDir: string,
): LspBridgeOptions | undefined {
  if (mode !== 'execute') return undefined;
  return {
    extraClaudeOptions: {
      mcpServers: {
        [LSP_SERVER_NAME]: {
          // Spawn our direct LSP-client MCP server (baked into the image). It speaks MCP to the SDK
          // and LSP to typescript-language-server, and re-roots the language server at the nearest
          // tsconfig.json of each tool call's target file (so a monorepo turn only loads the relevant
          // package). Absolute node + script path avoid PATH/ESM ambiguity (fnm rewrites PATH for agent
          // shells). The `--lsp … -- …` tail is the language-server command (swappable per language).
          // See ADR 0004 + atlas-lsp-server.mjs.
          command: '/usr/local/bin/node',
          args: [
            '/usr/local/lib/atlas/atlas-lsp-server.mjs',
            '--workspace',
            workspaceDir,
            '--lsp',
            'typescript-language-server',
            '--',
            '--stdio',
          ],
        },
      },
    },
    lspToolNames: qualifyLspToolNames(LSP_TOOL_NAMES),
  };
}
