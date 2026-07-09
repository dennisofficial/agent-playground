/**
 * The skills bundled with the Claude Code CLI itself — already active on every turn via the SDK's
 * `skills: 'all'` option (no compose step, no store; see `engine-core.ts`'s `settingSources`/`skills`
 * options). DISPLAY-ONLY here, so the console can show operators what's already on alongside the
 * Atlas-managed and org/repo tiers.
 *
 * SOURCING: investigated whether this is cleanly enumerable at runtime before curating it by hand. The CLI
 * ships as a single compiled Bun binary inside the per-platform `@anthropic-ai/claude-agent-sdk-<platform>`
 * package (`node_modules/.../claude-agent-sdk-darwin-arm64/claude`, ~230MB) — there is no filesystem-visible
 * skills dir, and a `strings` scan of the binary found no plaintext skill-name markers (the bundled assets
 * aren't reliably extractable without spawning/instrumenting the binary). NOT clean — so this is a CURATED
 * list (the observed bundled set as of the pinned SDK version) rather than a live discovery. CLI-VERSION-
 * DEPENDENT: bump this when `CLAUDE_SDK_VERSION` (backend/sandbox/Dockerfile) moves and the bundled set
 * visibly differs (e.g. `/skills` in an interactive session).
 */
export const BUNDLED_CLAUDE_CODE_SKILLS: readonly string[] = [
  'code-review',
  'batch',
  'debug',
  'loop',
  'claude-api',
  'run',
  'verify',
  'run-skill-generator',
  'deep-research',
  'dataviz',
  'schedule',
  'security-review',
];
