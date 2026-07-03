/**
 * Shared Context7 tool-name constants + enablement gate — the single source of truth for both:
 *   - `sandbox/image/context7-bridge-options.ts` (registers `context7` as a remote MCP server on
 *     execute-mode turns, so the in-sandbox engine can pull version-pinned library docs)
 *   - `engine-core.ts` (adds the qualified names to the `docs` subagent's `tools:` array — subagents
 *     don't inherit the parent turn's `allowedTools`, so `docs` needs them explicitly)
 *
 * Context7 (https://context7.com) is Upstash's curated, version-pinned library-docs MCP. It COMPLEMENTS
 * WebSearch/WebFetch: better for "how do I use API X in the version we have" (structured, cited snippets),
 * NOT a currency oracle — "is our version stale?" is still a WebSearch/registry question (see
 * VERIFY_CURRENCY in prompt-kit/fragments.ts). Wired ONLY into the `docs` subagent, which is the persona
 * whose whole job is external library documentation.
 *
 * OFF BY DEFAULT: everything here is gated on `CONTEXT7_API_KEY` being present in the container env, so an
 * unconfigured deployment behaves exactly as before (no phantom tools, no extra network dependency at
 * sandbox boot). Flip it on by injecting the key into the sandbox env, then live-verify the URL + tool
 * names below against the running Context7 server before relying on it.
 *
 * Lives in `engine/` (not `sandbox/image/`) so `engine-core.ts` never imports from `sandbox/image` — that
 * dependency only runs the other way (the in-container entrypoint imports `EngineCore`, not vice versa).
 */

/** The remote MCP server name the Context7 tools are registered under. */
export const CONTEXT7_SERVER_NAME = 'context7';

/** Context7's HTTP MCP endpoint (Upstash-hosted). Verify against the live server before relying on it. */
export const CONTEXT7_URL = 'https://mcp.context7.com/mcp';

/**
 * Context7's tool surface: resolve a package name to a Context7 library id, then query its docs. These are
 * the tool names the hosted server actually exposes — verified live against `https://mcp.context7.com/mcp`
 * (Context7 v3.2.2): `resolve-library-id` + `query-docs`. NOTE: the second tool is `query-docs`, NOT the
 * `get-library-docs` name some older `@upstash/context7-mcp` docs use — re-verify if you self-host a
 * different Context7 version.
 */
export const CONTEXT7_TOOL_NAMES = ['resolve-library-id', 'query-docs'];

/** How the model addresses each Context7 tool: `mcp__context7__<tool>`. */
export function qualifyContext7ToolNames(toolNames: string[] = CONTEXT7_TOOL_NAMES): string[] {
  return toolNames.map((name) => `mcp__${CONTEXT7_SERVER_NAME}__${name}`);
}

/** The Context7 API key from the container env, or `undefined` when Context7 is not configured. */
export function context7ApiKey(): string | undefined {
  const key = process.env.CONTEXT7_API_KEY;
  return key && key.length > 0 ? key : undefined;
}

/** Is Context7 wired in for this deployment? Gates both the server registration and the `docs` tool list. */
export function context7Enabled(): boolean {
  return context7ApiKey() !== undefined;
}
