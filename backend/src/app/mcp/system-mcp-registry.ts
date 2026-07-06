import {
  COCOINDEX_SERVER_NAME,
  COCOINDEX_TOOL_NAMES,
  GRAPHIFY_SERVER_NAME,
  GRAPHIFY_TOOL_NAMES,
} from '../engine/code-index-tools';
import { CONTEXT7_SERVER_NAME, CONTEXT7_TOOL_NAMES } from '../engine/context7-tools';
import { LSP_SERVER_NAME, LSP_TOOL_NAMES } from '../engine/lsp-tools';

/** A built-in MCP server, shown READ-ONLY in the console so operators know what the agent already has. */
export interface SystemMcpServer {
  name: string;
  description: string;
  transport: 'http' | 'sse' | 'stdio';
  /** The tool names the server exposes (addressed as `mcp__<name>__<tool>`). */
  tools: string[];
  /** Whether this built-in is actually live right now, for this org + deployment. */
  active: boolean;
  /** When inactive, what to configure to turn it on (shown in the console). */
  inactiveReason?: string;
}

/** The live, host-knowable signals the system tier's availability depends on. */
export interface SystemMcpSignals {
  /** Context7 docs MCP — gated on `CONTEXT7_API_KEY` on the deployment. */
  context7Configured: boolean;
  /** cocoindex semantic search — gated on the org having an OpenAI (embeddings) key. */
  openaiKeyConfigured: boolean;
}

/**
 * The system-tier MCP servers with their REAL, per-request availability. Names + tool lists are the exact
 * constants the sandbox registers on execute turns (`engine/*-tools.ts`) — this is not a hand-kept mirror,
 * it reuses those constants directly. `active` is derived from live {@link SystemMcpSignals} so the console
 * reflects what the agent actually has, not an aspirational list.
 *
 * All of these attach on execute/build turns only (plan/review turns get none) — `SystemMcpResolver` gathers
 * the signals; this stays a PURE function so the active-state logic is unit-testable without DI. The host
 * tool bridge (`atlas-host-bridge`) is intentionally omitted — it's orchestration plumbing, not a
 * user-meaningful tool server.
 */
export function buildSystemMcpServers(signals: SystemMcpSignals): SystemMcpServer[] {
  return [
    {
      name: LSP_SERVER_NAME,
      description:
        'TypeScript language server — precise symbol rename, references, definitions, hover and ' +
        'diagnostics against the turn’s worktree. Active on every build turn.',
      transport: 'stdio',
      tools: [...LSP_TOOL_NAMES],
      active: true,
    },
    {
      name: GRAPHIFY_SERVER_NAME,
      description:
        'Graphify — a local AST knowledge graph for structural questions: a symbol’s definition and ' +
        'degree, its call graph / imports, and how two symbols connect. Pure graph traversal, no key.',
      transport: 'stdio',
      tools: [...GRAPHIFY_TOOL_NAMES],
      active: true,
    },
    {
      name: COCOINDEX_SERVER_NAME,
      description:
        'cocoindex (ccc) — AST-chunked semantic code search (“where is the concept X?”). Uses OpenAI ' +
        'embeddings, so it needs the org’s OpenAI key.',
      transport: 'stdio',
      tools: [...COCOINDEX_TOOL_NAMES],
      active: signals.openaiKeyConfigured,
      inactiveReason: signals.openaiKeyConfigured
        ? undefined
        : 'Add the org’s OpenAI API key under Credentials to enable semantic search.',
    },
    {
      name: CONTEXT7_SERVER_NAME,
      description:
        'Context7 — curated, version-pinned library documentation for the docs subagent. Complements ' +
        'web search for “how do I use API X in the version we have”.',
      transport: 'http',
      tools: [...CONTEXT7_TOOL_NAMES],
      active: signals.context7Configured,
      inactiveReason: signals.context7Configured
        ? undefined
        : 'Set CONTEXT7_API_KEY on the deployment to enable.',
    },
  ];
}
