/**
 * Shared code-index tool-name constants — the single source of truth for both:
 *   - `sandbox/image/code-index-bridge-options.ts` (registers `cocoindex` + `graphify` as external stdio
 *     MCP servers, only on execute-mode turns)
 *   - `engine-core.ts` (adds the qualified names to the writer/read-only SUBAGENTS' `tools:` arrays —
 *     subagents don't inherit the parent turn's `allowedTools`, so each needs them explicitly)
 *
 * Two complementary indexes, mounted per-repo and maintained in the background (see
 * `driver/worktree-provisioner.service.ts`):
 *   - `cocoindex` (ccc) — AST-chunked SEMANTIC search: "where is the concept X?". One `search` tool.
 *   - `graphify` — a local AST knowledge GRAPH: "how does X connect / what depends on it?". We expose the
 *     precise structural verbs only (`get_node`/`get_neighbors`/`shortest_path`); graphify's own semantic
 *     `query_graph` is a noisier BFS dump that `cocoindex.search` beats, and the PR tools are irrelevant
 *     to a build turn. A spike on a 1,371-file monorepo confirmed this split (see
 *     `~/.claude/plans/code-index-spike-results.md`).
 *
 * Lives here (in `engine/`, not `sandbox/image/`) so `engine-core.ts` never has to import from
 * `sandbox/image` — mirrors `lsp-tools.ts` / `context7-tools.ts`.
 */

/** The external MCP server name ccc's semantic-search tool is registered under (per-turn, stdio). */
export const COCOINDEX_SERVER_NAME = 'cocoindex';

/** ccc's tool surface: one natural-language semantic search over the AST-chunked index. */
export const COCOINDEX_TOOL_NAMES = ['search'];

/** The external MCP server name Graphify's graph tools are registered under (per-turn, stdio). */
export const GRAPHIFY_SERVER_NAME = 'graphify';

/**
 * Graphify's structural tool surface. Deliberately the PRECISE verbs only — `get_node` (a symbol's
 * definition + degree), `get_neighbors` (its call graph / imports), `shortest_path` (how two symbols
 * connect). Excludes `query_graph` (a broad BFS traversal that returns a noisy neighborhood — use
 * `cocoindex.search` to LOCATE instead) and the PR-triage tools (`list_prs`/`get_pr_impact`/`triage_prs`).
 */
export const GRAPHIFY_TOOL_NAMES = ['get_node', 'get_neighbors', 'shortest_path'];

/**
 * Extra glob patterns ccc must EXCLUDE from indexing, on top of its built-in defaults (the env var
 * EXTENDS `ProjectSettings.exclude_patterns`, it doesn't replace them). Lockfiles + build output were
 * ~34% of the index chunks in the spike and caused the only two retrieval misses (a cron query matched
 * `pnpm-lock.yaml`), so dropping them both shrinks the DB and improves relevance. Serialized as a JSON
 * array — that's the shape `COCOINDEX_CODE_EXCLUDED_PATTERNS` is parsed as. Shared with the background
 * refresh in `driver/worktree-provisioner.service.ts` so the MCP server and the indexer agree.
 */
export const COCOINDEX_EXCLUDED_PATTERNS: string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/*.lock',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/*.min.js',
];

/** The `COCOINDEX_CODE_EXCLUDED_PATTERNS` env value (JSON array string). */
export function cocoindexExcludedPatternsEnv(): string {
  return JSON.stringify(COCOINDEX_EXCLUDED_PATTERNS);
}

/**
 * The ccc PROJECT `settings.yml` include/exclude patterns we author at bootstrap (globset syntax). These —
 * NOT `COCOINDEX_CODE_EXCLUDED_PATTERNS` — are what actually govern indexing: that env var is honored ONLY
 * by ccc's server-auto-create path, NEVER by the `ccc init`/`ccc index`/`ccc mcp` CLI, which read
 * `<worktree>/.cocoindex_code/settings.yml`. ccc's DEFAULT settings force-include every `.json`/`.yaml`
 * file, so a real monorepo indexes every data file → a 200 MB+ index + a slow cold cloud embed (the "really
 * long" warm-up seen live). So we WRITE settings.yml ourselves instead of taking ccc init's defaults.
 *
 * `include` = ccc's code + docs extensions MINUS the structured-DATA formats (json/xml/yaml/yml/toml) that
 * carry no useful "where is X" signal and caused the bloat. `exclude` = deps/build output/lockfiles/minified
 * (+ the same data formats again as belt-and-suspenders — ccc's globset matcher applies exclude OVER include).
 * Kept in sync with the spike's finding (lockfiles + json were ~34% of chunks and the only retrieval misses).
 */
export const CCC_PROJECT_INCLUDE_PATTERNS: string[] = [
  '**/*.py', '**/*.pyi', '**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx', '**/*.mjs', '**/*.cjs',
  '**/*.rs', '**/*.go', '**/*.java', '**/*.c', '**/*.h', '**/*.cpp', '**/*.hpp', '**/*.cc',
  '**/*.cxx', '**/*.hxx', '**/*.hh', '**/*.cs', '**/*.sql', '**/*.sh', '**/*.bash', '**/*.zsh',
  '**/*.md', '**/*.mdx', '**/*.txt', '**/*.rst', '**/*.php', '**/*.lua', '**/*.rb', '**/*.swift',
  '**/*.kt', '**/*.kts', '**/*.scala', '**/*.r', '**/*.html', '**/*.htm', '**/*.svelte', '**/*.vue',
  '**/*.css', '**/*.scss', '**/*.sol', '**/*.pas', '**/*.dpr', '**/*.f', '**/*.f90', '**/*.f95', '**/*.f03',
];

/** ccc project `settings.yml` exclude patterns — see {@link CCC_PROJECT_INCLUDE_PATTERNS}. */
export const CCC_PROJECT_EXCLUDE_PATTERNS: string[] = [
  '**/.*', '**/__pycache__', '**/node_modules', '**/target', '**/dist', '**/build',
  '**/.next', '**/.turbo', '**/coverage', '**/vendor/*', '**/.cocoindex_code',
  '**/*.min.js', '**/*.lock', '**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock',
  '**/*.json', '**/*.yaml', '**/*.yml', '**/*.xml', '**/*.toml',
];

/**
 * `.graphifyignore` patterns (GITIGNORE syntax — distinct from ccc's JSON glob array) written into the
 * worktree so `graphify update`/`graphify watch` skip files that carry no structural graph. Mirrors the ccc
 * exclusions (deps/build output/lockfiles) and additionally drops the DATA/DOC formats graphify parses to
 * ZERO nodes — `.json`/`.yaml`/`.yml` (in graphify's own CODE_EXTENSIONS) and `.md` (a DOC_EXTENSION):
 * those files are never cached, so every watch cycle re-detects them as "changed" and re-extracts the whole
 * corpus — a CPU busy-loop (graphify issue #1666). Excluding them is both a relevance win and the loop fix.
 */
export const GRAPHIFY_IGNORE_PATTERNS: string[] = [
  'node_modules/',
  'dist/',
  'build/',
  '.next/',
  '.turbo/',
  'coverage/',
  '*.lock',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  '*.min.js',
  '*.json',
  '*.yaml',
  '*.yml',
  '*.md',
];

/** How the model addresses each ccc tool: `mcp__cocoindex__<tool>`. */
export function qualifyCocoindexToolNames(toolNames: string[] = COCOINDEX_TOOL_NAMES): string[] {
  return toolNames.map((name) => `mcp__${COCOINDEX_SERVER_NAME}__${name}`);
}

/** How the model addresses each Graphify tool: `mcp__graphify__<tool>`. */
export function qualifyGraphifyToolNames(toolNames: string[] = GRAPHIFY_TOOL_NAMES): string[] {
  return toolNames.map((name) => `mcp__${GRAPHIFY_SERVER_NAME}__${name}`);
}
