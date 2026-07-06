/**
 * Code-index bridges → Claude SDK option assembly. Mirrors `lsp-bridge-options.ts`: the SHAPE of the
 * options handed to the SDK lives here, unit-testable without spawning the bundled entrypoint.
 *
 * Two EXTERNAL stdio MCP servers, both baked into the sandbox image (Phase 0 Dockerfile) and both
 * reading indexes that a background job maintains under {@link CONTAINER_CODE_INDEX} in the durable
 * per-job index root (see `driver/worktree-provisioner.service.ts`):
 *   - `cocoindex` — `ccc mcp`, AST-chunked SEMANTIC search ("where is X?"). Cloud (OpenAI) embeddings,
 *     so it needs the per-org key in env — registered ONLY when that key was threaded onto the turn.
 *   - `graphify` — `graphify-mcp`, a local AST knowledge GRAPH ("how does X connect?"). Query-time is
 *     pure graph traversal (no model, no key), so it registers whenever the turn is execute-mode.
 *
 * Registered ONLY for execute-mode turns — same gate/rationale as the LSP + Context7 bridges (covers the
 * brain/chat turn and the build turns; plan/review turns can't act on the results anyway).
 *
 * Tool-name constants live in `engine/code-index-tools.ts` (shared with `engine-core.ts`'s subagent tool
 * lists) — not here, to keep this file's only job the SDK-option shape.
 */
import type { SessionMode } from '../../domain';
import {
  CCC_PROJECT_EXCLUDE_PATTERNS,
  CCC_PROJECT_INCLUDE_PATTERNS,
  COCOINDEX_SERVER_NAME,
  COCOINDEX_TOOL_NAMES,
  GRAPHIFY_IGNORE_PATTERNS,
  GRAPHIFY_SERVER_NAME,
  GRAPHIFY_TOOL_NAMES,
  cocoindexExcludedPatternsEnv,
  qualifyCocoindexToolNames,
  qualifyGraphifyToolNames,
} from '../../engine/code-index-tools';
import {
  CONTAINER_COCOINDEX_DIR,
  CONTAINER_GRAPHIFY_DIR,
  CONTAINER_HOME,
  CONTAINER_WORKTREE,
} from '../container-paths';

/**
 * A dash-safe shell line that adds `marker` to the worktree's git `info/exclude` (idempotent) so a
 * derived-index artifact we drop in the worktree never shows as untracked. Runs entirely inside a
 * `(cd {@link CONTAINER_WORKTREE} && …)` subshell so it works for BOTH a linked worktree (where
 * `git rev-parse --git-path info/exclude` returns an ABSOLUTE common-dir path) and a normal repo (where it
 * returns a path RELATIVE to the worktree) — the cwd makes the relative form resolve, and `mkdir -p` on its
 * dirname covers a not-yet-created `info/`. Never disturbs the caller's cwd; never errors.
 */
function gitExcludeLine(marker: string): string {
  return (
    `( cd ${CONTAINER_WORKTREE} 2>/dev/null && __excl="$(git rev-parse --git-path info/exclude 2>/dev/null)"` +
    ` && [ -n "$__excl" ] && mkdir -p "$(dirname "$__excl")" 2>/dev/null` +
    ` && { grep -qxF '${marker}' "$__excl" 2>/dev/null || printf '%s\\n' '${marker}' >>"$__excl"; } ) || true`
  );
}

/**
 * The `<worktree>/.cocoindex_code/settings.yml` body as `printf '%s\n'` args (each YAML line
 * shell-single-quoted; the globs use DOUBLE quotes inside so no single quote ever appears). safe_dump-shaped
 * (`exclude_patterns:` then `include_patterns:`, block sequences) — the only fields ccc's `load_project_settings`
 * reads. See {@link CCC_PROJECT_INCLUDE_PATTERNS} for why we author this ourselves instead of `ccc init`'s defaults.
 */
function cccProjectSettingsPrintfArgs(): string {
  const lines = [
    'exclude_patterns:',
    ...CCC_PROJECT_EXCLUDE_PATTERNS.map((p) => `- "${p}"`),
    'include_patterns:',
    ...CCC_PROJECT_INCLUDE_PATTERNS.map((p) => `- "${p}"`),
  ];
  return lines.map((l) => `'${l}'`).join(' ');
}

/**
 * Idempotent shell that makes the `ccc` CLI usable in the sandbox before `ccc mcp` / `ccc index` run.
 *
 * ccc's CLI discovers the project by walking up from cwd for a `.cocoindex_code/settings.yml` marker
 * (`COCOINDEX_CODE_ROOT_PATH` is NOT enough — the CLI honors only cwd discovery, which callers drive via
 * `COCOINDEX_CODE_HOST_CWD`) and REQUIRES `~/.cocoindex_code/global_settings.yml` to exist. So we (1) seed
 * the baked global settings into HOME (no-op once present); (2) WRITE our own project `settings.yml` —
 * NOT `ccc init`, whose defaults force-include every `.json`/`.yaml` and index a monorepo's every data
 * file (200 MB+ index, slow cold embed); ours carries {@link CCC_PROJECT_INCLUDE_PATTERNS}/
 * {@link CCC_PROJECT_EXCLUDE_PATTERNS} so json/lock/etc. are dropped, and writing it directly also avoids
 * `ccc init` touching `.gitignore`; (3) git-`info/exclude` the marker dir so the DB-redirected
 * `.cocoindex_code/` never shows as untracked. Always overwrites settings.yml so a redeploy's patterns win.
 *
 * Callers MUST run it with `HOME`={@link CONTAINER_HOME} and `COCOINDEX_CODE_HOST_CWD`=
 * {@link CONTAINER_WORKTREE} in env. Emits nothing meaningful on stdout, but callers should still redirect
 * it (the MCP wrapper `exec`s `ccc mcp` after, and any stray byte would corrupt the JSON-RPC stream).
 */
export function cccBootstrapScript(): string {
  return [
    `mkdir -p "$HOME/.cocoindex_code" 2>/dev/null || true`,
    `[ -f "$HOME/.cocoindex_code/global_settings.yml" ] || cp /etc/atlas/cocoindex-global_settings.yml "$HOME/.cocoindex_code/global_settings.yml" 2>/dev/null || true`,
    `mkdir -p "${CONTAINER_WORKTREE}/.cocoindex_code" 2>/dev/null || true`,
    `printf '%s\\n' ${cccProjectSettingsPrintfArgs()} > "${CONTAINER_WORKTREE}/.cocoindex_code/settings.yml" 2>/dev/null || true`,
    gitExcludeLine('.cocoindex_code/'),
  ].join('\n');
}

/**
 * The `.graphifyignore` file body (gitignore syntax) + a shell line to git-exclude it — used by
 * `SandboxManager.kickCodeIndexRefresh` to seed the worktree before the initial `graphify update`. See
 * {@link GRAPHIFY_IGNORE_PATTERNS} for why these patterns (the #1666 busy-loop fix). Written only when
 * absent (a repo's own `.graphifyignore` wins). Kept here so the git-exclude helper is shared with ccc.
 */
export function graphifyIgnoreSeedScript(): string {
  const printfArgs = GRAPHIFY_IGNORE_PATTERNS.map((p) => `'${p}'`).join(' ');
  return [
    `[ -f "${CONTAINER_WORKTREE}/.graphifyignore" ] || printf '%s\\n' ${printfArgs} > "${CONTAINER_WORKTREE}/.graphifyignore" 2>/dev/null || true`,
    gitExcludeLine('.graphifyignore'),
  ].join('\n');
}

export interface CodeIndexBridgeOptions {
  /** `{ mcpServers: { cocoindex?: {...}, graphify: {...} } }` — spread verbatim into the SDK `Options`. */
  extraClaudeOptions: { mcpServers: Record<string, unknown> };
  /** Qualified `mcp__cocoindex__*` + `mcp__graphify__*` names to auto-approve via `allowedTools`. */
  codeIndexToolNames: string[];
}

/**
 * Build the code-index bridge options for a turn, or `undefined` if this turn's mode shouldn't get one.
 *
 * `workspaceDir` is the turn's `cwd` (= {@link CONTAINER_WORKTREE}); ccc treats it as the project root,
 * while the SQLite index itself is redirected OUT of the worktree into the durable per-job index root via
 * `COCOINDEX_CODE_DB_PATH_MAPPING` + `COCOINDEX_CODE_RUNTIME_DIR`.
 *
 * `embeddingKey` is the per-org OpenAI key (resolved host-side, threaded onto the turn spec). When it's
 * absent the cocoindex server is omitted (cloud embeddings can't run keyless) but graphify still loads —
 * the structural graph needs no key. In practice the key is required at org onboarding, so this is a
 * defensive degrade, not a normal path.
 */
export function buildCodeIndexBridgeOptions(
  mode: SessionMode,
  workspaceDir: string,
  embeddingKey: string | undefined,
): CodeIndexBridgeOptions | undefined {
  if (mode !== 'execute') return undefined;

  const mcpServers: Record<string, unknown> = {};
  const toolNames: string[] = [];

  // graphify: query-time is pure local graph traversal — no key, always available on execute turns. The
  // `graphify watch` daemon (sandbox-init.sh) writes graph.json directly into GRAPHIFY_OUT (= this dir).
  mcpServers[GRAPHIFY_SERVER_NAME] = {
    command: 'graphify-mcp',
    args: ['--graph', `${CONTAINER_GRAPHIFY_DIR}/graph.json`, '--transport', 'stdio'],
  };
  toolNames.push(...qualifyGraphifyToolNames(GRAPHIFY_TOOL_NAMES));

  // cocoindex: cloud (OpenAI) embeddings ⇒ only register when the per-org key is present.
  if (embeddingKey) {
    mcpServers[COCOINDEX_SERVER_NAME] = {
      // Wrap `ccc mcp` in the bootstrap: ccc's CLI must find an initialized project (a `.cocoindex_code/
      // settings.yml` marker) via cwd discovery — so we seed global settings + WRITE our curated
      // settings.yml + git-exclude the marker first, then `exec` the server. The bootstrap's stdout is
      // discarded so it can't corrupt the JSON-RPC stream.
      command: 'sh',
      args: ['-c', `( ${cccBootstrapScript()} ) >/dev/null 2>&1; exec ccc mcp`],
      env: {
        // HOME/HOST_CWD drive ccc's discovery: it chdirs to HOST_CWD (the callback) and reads global
        // settings from HOME. ROOT_PATH is kept for the server factory. The heavy SQLite index is
        // redirected out of /workspace into the durable per-job index root — the mapping SOURCE must be the
        // project root itself (resolve_db_dir is called with the project root and checks `== source`), NOT
        // the `.cocoindex_code` subdir (a no-op that left the 200 MB+ DB in the worktree).
        HOME: CONTAINER_HOME,
        COCOINDEX_CODE_HOST_CWD: workspaceDir,
        COCOINDEX_CODE_ROOT_PATH: workspaceDir,
        COCOINDEX_CODE_RUNTIME_DIR: CONTAINER_COCOINDEX_DIR,
        COCOINDEX_CODE_DB_PATH_MAPPING: `${workspaceDir}=${CONTAINER_COCOINDEX_DIR}`,
        COCOINDEX_CODE_EXCLUDED_PATTERNS: cocoindexExcludedPatternsEnv(),
        OPENAI_API_KEY: embeddingKey,
      },
    };
    toolNames.push(...qualifyCocoindexToolNames(COCOINDEX_TOOL_NAMES));
  }

  return { extraClaudeOptions: { mcpServers }, codeIndexToolNames: toolNames };
}
