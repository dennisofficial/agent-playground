/**
 * Atlas v2's MINIMAL engine seam — a clean-room rewrite of v1's `worker-engine.port.ts` stripped to
 * exactly what W1 needs: run one Claude/Codex turn in plan or execute mode, threading credentials and
 * an isolated agent home. No roles, no effort knob, no AskUserQuestion relay, no skills/MCP — those
 * v1 concepts are dropped (engines run vanilla). Zero v1 imports.
 */
import type { SessionEngine, SessionMode } from '../domain';
import type { AgentMessage } from '../prompt-kit/message';
import type { EngineHomeKey } from './engine-home';
import type {
  EngineAuth,
  EngineEvent,
  EngineRunResult,
  ReasoningEffort,
} from '@workspace/agent-engine';

// The vendor-agnostic engine leaf types (EngineEvent, EngineUsage, EngineRunResult, EngineAuth,
// ReasoningEffort, the context-limit helpers, the error classes/markers, SessionLimitHit, EngineHomeKey,
// SessionEngine, …) now live in `@workspace/agent-engine`. Re-exported here so the existing
// `from '.../engine.types'` import sites keep resolving unchanged.
export * from '@workspace/agent-engine';

/**
 * The commit identity injected into the sandbox for the agent's own commits — the GitHub account that
 * owns the org's push PAT (resolved via `GET /user`), so commits are attributed to that account. `email`
 * is the account's GitHub noreply address (`<id>+<login>@users.noreply.github.com`); `name` is its
 * display name (or login). Threaded onto {@link GitAuth} and turned into the GIT_AUTHOR/GIT_COMMITTER env.
 */
export interface SandboxGitIdentity {
  name: string;
  email: string;
}

/**
 * Authenticated-git for a turn: the remote url + effective org GitHub token the sandbox agent uses to
 * fetch/push, plus the resolved commit {@link SandboxGitIdentity} to attribute its commits to. See
 * {@link ExecutionTarget.gitAuth}.
 */
export interface GitAuth {
  gitUrl: string;
  token?: string;
  /** Token for the sandbox `gh`/GITHUB_TOKEN path (PR create/comment/review). It resolves from the same effective credential as `token`; absent means GITHUB_TOKEN falls back to `token`. */
  apiToken?: string;
  identity?: SandboxGitIdentity;
  /**
   * The org's GitHub auth mode. `'app'` → the in-sandbox git reads its token from a host-refreshed file via
   * a credential helper (mid-turn refresh); `'pat'` (default when absent) → today's static `http.extraheader`.
   * Set by the per-turn gitAuth resolvers (ThreadDriver / AgentSessionManager).
   */
  mode?: 'pat' | 'app';
}

/**
 * WHERE a turn executes. Absent (the default) → run in-process on the host (the `local` runner). When
 * present, the `docker` runner `docker exec`s the engine entrypoint inside `containerId` as `user`.
 * Passed explicitly through the port so the runner never has to derive a container from a string.
 */
export interface ExecutionTarget {
  /** The sandbox container to exec the turn inside. */
  containerId: string;
  /** Run the exec as this user (uid or uid:gid) — host-uid so worktree files stay host-owned. */
  user?: string;
  /**
   * The HOST worktree root for this turn. The worktree is bind-mounted at a NEUTRAL container path
   * (`/workspace`, not same-path), so the runner rewrites `cwd` from this host root onto that mount. Absent
   * → the runner assumes the turn runs at the worktree root.
   */
  worktreeHost?: string;
  /**
   * Authenticated-git for this turn: the agent inside the sandbox can `fetch`/`push`/merge against the
   * remote. Sourced from the RESOLVED repo (repo url + org PAT via `CredentialResolver`), NOT from the
   * sandbox (a row-sourced `FeatureSandbox` has an empty `gitUrl`/no token). Set only on the two turn
   * types that mutate git — brain operator turns and build/execute turns. The runner turns this into the
   * `GIT_CONFIG_*` extraheader + `GITHUB_TOKEN` in the turn's exec env; the token never lands in argv or
   * `.git/config`. Absent → git remote ops fail closed (`GIT_TERMINAL_PROMPT=0`).
   */
  gitAuth?: GitAuth;
  /**
   * Container path the turn's writers send live-run evidence to: `/context/evidence/<threadDirName>` for a
   * thread leg, or `/context/evidence` root for a brain/direct-build turn. Emitted as `ATLAS_EVIDENCE_DIR`
   * in the exec env (per-turn — never baked at container-create, since the container is reused warm).
   */
  evidenceDir?: string;
}

// ── Tool-bridge frame protocol ────────────────────────────────────────────────────────────────────
//
// R1: a bidirectional frame protocol over the exec channel (docker exec OR local subprocess stdio).
// The in-container side emits tool_request on stdout; the host answers on stdin with tool_response
// or tool_error, correlated by id. This is additive — only active when `toolBridge` is set on
// RunEngineArgs; existing one-shot build turns are unaffected.

/**
 * A tool invocation emitted by the in-container entrypoint on stdout.
 * Correlated to a response by `id` (a UUID the in-container side generates).
 */
export interface ToolRequestFrame {
  t: 'tool_request';
  /** UUID generated by the in-container side — the correlation key. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * The host's successful answer to a {@link ToolRequestFrame} — written to stdin.
 */
export interface ToolResponseFrame {
  t: 'tool_response';
  /** Matches the originating `tool_request.id`. */
  id: string;
  result: unknown;
}

/**
 * The host's error answer to a {@link ToolRequestFrame} — written to stdin.
 */
export interface ToolErrorFrame {
  t: 'tool_error';
  /** Matches the originating `tool_request.id`. */
  id: string;
  message: string;
}

/** Host liveness ping for an in-flight tool call — emitted periodically while impl() is awaited.
 *  Carries no result; the client uses it only to reset that call's heartbeat-gap idle timer. */
export interface ToolProgressFrame {
  t: 'tool_progress';
  /** Matches the originating tool_request.id. */
  id: string;
  ts: number;
}

/** Union of frames the host may write to the exec's stdin (one per line). */
export type HostFrame = ToolResponseFrame | ToolErrorFrame | ToolProgressFrame;

/** A host-side tool implementation. Receives parsed args, returns a serializable result. */
export type ToolImpl = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Options to activate the bidirectional tool bridge for a turn.
 * The in-container entrypoint will host a thin MCP server whose tools proxy back to the host via
 * the frame protocol; the host dispatches each `tool_request` using `tools`.
 */
/**
 * Reserved host-tool name for the install-awareness round-trip. The `__` prefix marks it internal so
 * `buildSpec` filters it out of the model-facing tool list while host dispatch still finds it.
 */
export const INTERNAL_PROFILE_AWARENESS_TOOL = '__profile_awareness';

export interface ToolBridgeOptions {
  /**
   * The thread that owns this exec. Used to enforce per-thread scoping: any `tool_request` that
   * names a resource scoped to a different thread is denied.
   */
  jobId: string;
  /**
   * Host-side tool dispatch table. Keys are tool names; values are the implementations that execute
   * on the host. The dispatch layer enforces `jobId` scoping before calling these.
   */
  tools: Record<string, ToolImpl>;
  /**
   * Host-side error sink: invoked with a formatted line when a bridged tool throws, so the real
   * cause (message + stack) reaches host logs even though only the bounded `.message` rides back to
   * the sandbox. Falls back to `console.error` when unset (standalone paths).
   */
  onToolError?: (line: string) => void;
}

/**
 * Prepended to a RESUMED turn's task when its sandbox container was just re-attached COLD (reaped while
 * idle, or recovered after a crash/host-restart). The resumed engine session remembers state from prior
 * turns that no longer exists in the fresh container — this tells it the truth so it re-establishes its
 * runtime instead of trusting stale beliefs. (Standing "verify before assuming" guidance lives in the
 * personas; this is the one-time per-reset signal, kept OUT of the byte-stable system prompt.)
 */
export const SANDBOX_RESET_NOTICE = [
  '[sandbox reset] Your sandbox was restarted since your last turn. Any background processes you started',
  'earlier (dev servers, test watchers, headless browsers, docker compose services) are NO LONGER RUNNING',
  'and in-memory state is gone — but files you committed to the worktree are intact, and the cold-boot setup',
  'script already re-ARMED the box (deps/build/index). Run `atlas-svc ps` to see which supervised services',
  'are now `stopped`, and restart ONLY the ones THIS turn actually needs (a planning/review turn may need',
  'none) with `atlas-svc run`. Before relying on any server, verify it is actually up (curl/health-check).',
  'Do not assume anything you started in a previous turn is still alive.',
].join(' ');

/**
 * Injected IN-TURN as a steer message when a `run_in_background` Bash task keeps the turn held past the
 * `bg-task-cap` JIT rule's `holdMs`. Relocated to `prompt-kit/jit/bg-task-cap.ts` (the rule catalog owns the
 * payload now); re-exported here so existing importers stay green.
 */
export { BG_TASK_CAP_NOTICE } from '../prompt-kit/jit/bg-task-cap';

/**
 * A user-defined MCP server, fully RESOLVED host-side (secret header/env values already inlined) and
 * ready to serialize onto the turn spec. `McpResolver.resolveForTurn` produces these from the
 * `mcp_servers` rows for the turn's org/repo/surface; the in-container entrypoint turns them into Claude
 * `mcpServers` entries and Codex `[mcp_servers.<name>]` config.toml blocks (see user-mcp-bridge-options.ts).
 *
 * Kept SDK-import-free (like the rest of this file) — the SDKs load dynamically in-container.
 */
export interface ResolvedMcpServer {
  /** Server name — the model addresses tools as `mcp__<name>__<tool>`. */
  name: string;
  /** Remote (`http`/`sse`, uses `url`+`headers`) or `stdio` (uses `command`+`args`+`env`). */
  transport: 'http' | 'sse' | 'stdio';
  /** Remote endpoint URL (http/sse). */
  url?: string;
  /** Remote headers, secrets already inlined (http/sse). */
  headers?: Record<string, string>;
  /** stdio launch command. */
  command?: string;
  /** stdio command args. */
  args?: string[];
  /** stdio env, secrets already inlined. */
  env?: Record<string, string>;
}

/**
 * A resolved SKILL, ready to serialize onto the turn spec. `SkillResolver.resolveForTurn` produces these
 * from the `workspace_skills` rows for the turn's org/repo/surface; the per-turn skills-compose step in
 * `engine-core.ts` symlinks each `dirPath` into `<CLAUDE_CONFIG_DIR>/skills/<name>` (write-through — no
 * copy). No secrets, no file content — a skill is a real directory living on the host/mounted store, so
 * only its NAME and LOCATION cross the wire (unlike `ResolvedMcpServer`, whose secret values ride in
 * inlined verbatim).
 */
export interface ResolvedSkill {
  /** Skill name — the on-disk skill dir under the discovered skills root, and the symlink name under
   *  `<CLAUDE_CONFIG_DIR>/skills/`. */
  name: string;
  /**
   * `description` for display only (e.g. a future "skills" section of the Workspace Profile snapshot) —
   * NOT re-injected into the system prompt; the SDK reads it straight from the skill's own `SKILL.md`
   * frontmatter once symlinked in. See `WorkspaceProfileService.render()`'s dropped skills-names line.
   */
  description: string;
  /**
   * The skill's dir, relative to whichever root `managed` selects (see below) — `<name>` for an org-scoped
   * or managed skill, `repos/<repoId>/<name>` for a repo-scoped one. See `skills/skill-store-paths.ts`
   * `skillRelativeDir` / `skills/system-skill-store-paths.ts` `managedSkillRelativeDir` (whichever produced
   * it).
   */
  dirPath: string;
  /**
   * True for a code-defined Atlas-managed (system-tier) STATIC skill (`SkillResolver`'s merge of a
   * `system-skill-registry.ts` entry with no `git` source) — `dirPath` is then relative to the MANAGED
   * skills root (`CONTAINER_SKILLS_MANAGED` in-sandbox, the repo-committed `backend/skills-managed/`).
   * Absent/false → the ordinary org/repo (`workspace_skills`) tier, relative to `CONTAINER_SKILLS_STORE` —
   * UNLESS {@link managedGit} is set instead. Mutually exclusive with `managedGit`.
   */
  managed?: boolean;
  /**
   * True for a code-defined Atlas-managed (system-tier) GIT-SOURCED skill (a `system-skill-registry.ts`
   * entry WITH a `git` source, synced by `ManagedSkillSyncService`) — `dirPath` is then relative to the
   * git-managed skills root (`CONTAINER_SKILLS_MANAGED_GIT` in-sandbox), a different global, read-only
   * root than {@link managed}'s (repo-committed content vs. synced-from-upstream). Mutually exclusive
   * with `managed`.
   */
  managedGit?: boolean;
  /**
   * The review-lens applicability axes (thread types / file globs), populated by
   * `SkillResolver.resolveForTurn` from the system-tier fields or the workspace row's
   * `review_for_types`/`review_for_globs` columns. Consumed by `resolveReviewSkillsForThread` to pick which
   * skills' bodies get injected into a review turn — meaningless (and unused) for a non-review surface.
   */
  reviewForTypes?: string[];
  /** See {@link reviewForTypes}. */
  reviewForGlobs?: string[];
}

export interface RunEngineArgs {
  /** Which engine backs this run. */
  engine: SessionEngine;
  /** The turn's instructions/prompt. */
  task: AgentMessage;
  /** Working directory the engine is scoped to (the per-feature worktree). */
  cwd: string;
  /**
   * Extra absolute roots (beyond `cwd`) that Write/Edit may target on an execute turn. Already
   * resolved to the engine's filesystem view (container paths in-sandbox) — NOT host paths to rebase.
   * The docker runner sets this to the durable `/context` shared mount so the brain can author the
   * plan/spec there (it lives OUTSIDE the worktree, so the worktree-only boundary would otherwise
   * force a Bash fallback). Empty/omitted → writes are confined to `cwd`.
   */
  writableRoots?: string[];
  /** The system prompt / persona for this turn (Codex seeds it as a first-turn preamble). */
  systemPrompt: AgentMessage;
  /**
   * The structured key that namespaces the engine's isolated CLAUDE_CONFIG_DIR / CODEX_HOME — see
   * {@link EngineHomeKey} for the resulting nested `<org>/<repo>/<job>/<type>/[<subId>]` layout. Two
   * concurrent surfaces (or two jobs) never share engine state.
   */
  sandboxKey: EngineHomeKey;
  /** A prior engine session/thread id to resume, if any. */
  sessionId?: string;
  /**
   * This turn's mode. REQUIRED (no default): a missing mode must never silently grant writes. 'plan'
   * and 'review' are read-only at the engine seam ('plan' adds Claude's native plan ceremony; 'review'
   * is read-only without it). Only 'execute' may write.
   */
  mode: SessionMode;
  /**
   * How this run authenticates. Callers MAY leave this unset: `RedisEngineRunner.run` resolves the per-org
   * subscription secret from `sandboxKey.orgId` + `engine` at the single dispatch seam (so no call site can
   * forget it). An explicitly-supplied `auth` still wins. If the org has no secret it stays undefined and the
   * in-sandbox `EngineCore.resolveAuth` throws — there is no ambient-env fallback.
   */
  auth?: EngineAuth;
  /**
   * NON-SECRET gate telling the in-container engine to READ its refreshed credential back after the turn
   * (and relay it on {@link EngineRunResult.refreshedAuthSecret}) — Codex's `auth.json` overlay or Claude's
   * `.credentials.json` (a personal login the SDK self-refreshes). Serialized into the turn spec (unlike the
   * secret-bearing `auth.refreshBack`, which is host-only). The runner sets it to `!!auth.refreshBack`, so
   * ONLY org-sourced runs read back — env-fallback runs (which inject an ambient token the container can't
   * distinguish) never emit a secret into the final frame.
   */
  persistAuthRefresh?: boolean;
  /**
   * User-defined MCP servers to register for this turn, RESOLVED host-side (secrets inlined) by
   * `McpResolver.resolveForTurn` from the org/repo `mcp_servers` rows whose `surfaces` include this
   * turn's surface. Serialized into the turn spec — the header/env values are secrets that legitimately
   * ride into the sandbox (like `auth.secret`), so keep them OUT of any log line.
   * Empty/omitted → no user MCP servers this turn. See user-mcp-bridge-options.ts.
   */
  userMcpServers?: ResolvedMcpServer[];
  /**
   * The repo's opt-in house-style profile (`repos.convention_profile_slug` → the resolved profile), or
   * null/absent when none is attached. Crosses the wire VERBATIM (plain data) so the in-container engine can
   * fold the same envelope into the prompts it assembles ITSELF for the `FAN_OUT` writer + `REVIEW_AGENT`
   * subagents (the host only assembles the main-agent `systemPrompt`; the subagent personas are built in
   * `engine-core`). The MAIN agent already has it baked into `systemPrompt`; this field is what reaches the
   * subagents. Absent → nothing injected, byte-identical to today.
   */
  repoConventions?: { name: string; body: string } | null;
  /**
   * The repo's saved preview recipe, forwarded verbatim so the in-sandbox engine can fold it into the
   * `validate` subagent prompt (the host assembles the WORKER main prompt itself). Absent ⇒ nothing
   * injected, byte-identical to today.
   */
  previewInstructions?: string | null;
  /**
   * This turn's skills, RESOLVED host-side (`SkillResolver.resolveForTurn`) as `{name, description, dirPath,
   * managed?}` — dirs, not bodies. Merges the code-defined SYSTEM tier (`managed: true`) with the
   * `workspace_skills` rows whose `surfaces` include this turn's surface, base-layer-then-overrides (see
   * `SkillResolver`'s doc). The per-turn skills-compose step in `engine-core.ts` idempotently
   * wipes+rewrites `<CLAUDE_CONFIG_DIR>/skills/` with a write-through symlink per skill (joining `dirPath`
   * against `CONTAINER_SKILLS_STORE`, or `CONTAINER_SKILLS_MANAGED` when `managed`), which the SDK loads
   * NATIVELY (`settingSources: ['user']` + `skills: 'all'`) — no synthetic plugin. Empty/omitted → no
   * skills this turn (the wipe still runs, so a prior turn's skills don't linger).
   */
  skills?: ResolvedSkill[];
  /**
   * Skill NAMES this SESSION has been granted live `Edit`/`Write` access to, via the brain's
   * `request_skill_edit_access` tool + an owner approval (`AgentSessionManager`'s in-memory per-job grant
   * set — see `skillEditGrantsByJob`). Resolved host-side at turn-build time (the grant lives on the host;
   * the in-container `canUseTool` has no DB/host-state access of its own), so it rides the SAME verbatim
   * channel as `skills` itself. Absent/empty → every skill stays read-only for `Edit`/`Write`/`NotebookEdit`
   * (`makeCanUseTool`'s default-deny), which is the common case — most turns never request an edit.
   */
  grantedSkills?: string[];
  /** Override the model for this run. Falls back to the engine's env/default when unset. */
  model?: string;
  /**
   * Reasoning effort for this run. Codex → `ThreadOptions.modelReasoningEffort`; Claude → the Agent SDK
   * `Options.effort`. Unset → the account/CLI default. The plan-review turn pins `'xhigh'` so the
   * reviewer reasons hard. (A ChatGPT-account token REJECTS an explicit `model`, but ACCEPTS this knob —
   * verified by spike.)
   */
  modelReasoningEffort?: ReasoningEffort;
  /** Called for each progress event as the run streams. */
  onEvent?: (e: EngineEvent) => void;
  /**
   * Opt into RICH token-level streaming (the thread brain): enables the SDK's partial-message stream +
   * extended thinking, so `runClaude` emits `text_delta`/`thinking`/`thinking_delta`/`tool_use`/
   * `tool_result` events in addition to the coarse `text`/`tool`/`result`. Omit (build/step turns) for
   * the existing block-level behavior.
   */
  richStream?: boolean;
  /** Aborts the run when signalled — wired to the SDK's native cancellation. */
  signal?: AbortSignal;
  /**
   * Opt into MID-TURN STEERING (the operator-facing brain turn): the in-container entrypoint runs the SDK
   * in STREAMING-INPUT mode and subscribes to `turn:{T}:input`, so an operator message can be injected into
   * the RUNNING turn (`priority:'now'`) and the model reacts before the turn ends — instead of queuing until
   * the next turn. Serialized into the turn spec. Omit (build/plan/review workers) for the single-message path.
   */
  steerable?: boolean;
  /**
   * The live source of mid-turn steering messages, drained into the SDK's streaming input with
   * `priority:'now'`. NOT serialized — the in-container entrypoint builds it from the `turn:{T}:input`
   * Redis channel (gated on `steerable`) and passes it in-process to the engine core. When present the
   * engine runs in streaming-input mode; when absent it uses the single-message prompt. Each item carries
   * the steer's stimulus `id` (when present) so the core can emit a correlated `input_ack` after pushing it.
   */
  steerInput?: AsyncIterable<{ id?: string; text: string }>;
  /**
   * ENGINE-LOCAL Leg-rotation nudges (builder Claude execute turns). When set, the engine watches its OWN
   * main-agent context occupancy and injects `softText` the first time it crosses `softTokens`, then re-injects
   * `reminderText` every further +`reminderDeltaTokens` of growth — each as a `priority:'now'` steer into the
   * LIVE turn, exactly like an operator steer but with ZERO delivery latency. This is deliberately engine-local
   * (not a host→Redis steer) so the nudge can never race the post-`result` input close (`STEER_IDLE_GRACE_MS`):
   * it lands mid-stream while input is open. Plain data → serialized into the turn spec so it works in-container.
   * There is NO hard threshold and NO forced rotation — the nudges only ask; rotation happens when the builder
   * calls `record_leg_handoff`. The driver observes the SAME occupancy to persist visible harness rows + peak.
   */
  rotationNudge?: {
    softTokens: number;
    reminderDeltaTokens: number;
    softText: AgentMessage;
    reminderText: AgentMessage;
  };
  /**
   * Fired ONCE, host-side, the instant this turn is DURABLY registered + kicked (its `active_turns` row is
   * committed and the engine is running detached) — i.e. the moment the turn becomes restart-survivable via
   * boot re-attach. The brain uses this to stamp an operator message `delivered_at` at hand-off (not at
   * completion), so a mid-turn crash leaves it delivered-and-resumable rather than lost or double-run. Only
   * the Redis runner fires it (the only restart-survivable transport). Best-effort; never blocks the turn.
   */
  onTurnRegistered?(turnId: string): void;
  /**
   * WHERE to execute. Omit → host-local (in-process). When set, the `docker` engine-runner execs the
   * turn inside that sandbox container. The `local` runner ignores it. (Not serialized to the
   * in-container entrypoint — it's a host-side routing hint.)
   */
  target?: ExecutionTarget;
  /**
   * Activate the bidirectional tool bridge for this turn. When set, the exec's stdin stays open and
   * the host dispatches `tool_request` frames from the in-container side back to the host tools,
   * returning correlated `tool_response`/`tool_error` frames. Additive — omit for the existing
   * one-shot build turns (backward-compatible).
   */
  toolBridge?: ToolBridgeOptions;
  /**
   * In-container round-trip callback. Built inside the entrypoint (like `onEvent`) when a Claude turn
   * carries a tool bridge: it XADDs a `tool_request` and resolves with the correlated host reply. The
   * install-awareness PostToolUse hook uses it to reach the reserved `__profile_awareness` host tool.
   * Host-only closure — NEVER serialized into the turn spec.
   */
  bridgeCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Optional registry context for a RESTART-SURVIVABLE Redis-transport turn. When set (and
   * `ENGINE_TRANSPORT=redis`), the runner records an `active_turns` row so a fresh backend can
   * re-attach to this turn after a restart. Ignored by the pipe runner. See ADR 0001.
   */
  turnMeta?: TurnMeta;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// HOST ↔ ENGINE WIRE CONTRACT
//
// A turn is set up on the host (`RunEngineArgs`) but the engine runs in the sandbox container, so the turn
// crosses a serialization boundary (`redis-engine-runner` XADDs a `TurnSpec` to `turn:{T}:spec`; the
// in-container `engine-entrypoint` reads + spreads it). `RunEngineArgs` carries things that CANNOT be
// serialized (callbacks, AbortSignal, live iterables, in-memory closures), so the spec is a projection.
//
// The projection used to be a hand-maintained allowlist of `...(cond ? {field} : {})` spreads — which fails
// SILENTLY OPEN: a new optional field is just dropped at the boundary with no compile error (that's how the
// Leg-rotation `rotationNudge` seed silently never reached the builder). The types below make it a CONTRACT:
// every `RunEngineArgs` field must be classified as host-only, transformed, or verbatim, and the verbatim
// manifest is compile-checked for exhaustiveness — so adding a field forces a decision or fails the build.

/** Fields that NEVER cross to the container (host-only handles/closures/callbacks + the host-side registry
 *  context). `turnMeta` drives the host's `active_turns` re-attach row; it is not read in-container. */
type HostOnlyArgKey =
  | 'onEvent' | 'signal' | 'steerInput' | 'onTurnRegistered' | 'target' | 'toolBridge' | 'bridgeCall' | 'turnMeta';
/** Fields TRANSFORMED at the boundary (mapped to container-space by `buildSpec`, not copied verbatim). */
type TransformedArgKey = 'cwd' | 'writableRoots' | 'auth' | 'persistAuthRefresh';
/** Everything else is copied VERBATIM. Derived from `keyof RunEngineArgs` — this is the load-bearing line:
 *  a NEW field lands here automatically, and the exhaustiveness check below then fails until it is either
 *  forwarded (added to {@link SPEC_VERBATIM_KEYS}) or classified (added to HostOnly/Transformed above). */
export type SpecVerbatimKey = Exclude<keyof RunEngineArgs, HostOnlyArgKey | TransformedArgKey>;

/** The verbatim fields copied host→container. `satisfies` rejects a misclassified/typo'd key; the
 *  `_SPEC_VERBATIM_KEYS_EXHAUSTIVE` check below rejects a MISSING one. Together ⇒ exact coverage. */
export const SPEC_VERBATIM_KEYS = [
  'engine', 'task', 'systemPrompt', 'sandboxKey', 'sessionId', 'mode',
  'userMcpServers', 'repoConventions', 'previewInstructions', 'skills', 'grantedSkills', 'model', 'modelReasoningEffort', 'richStream', 'steerable', 'rotationNudge',
] as const satisfies readonly SpecVerbatimKey[];

// COMPILE-TIME CONTRACT: if a verbatim field is missing from SPEC_VERBATIM_KEYS this is a non-`never` tuple
// naming it, and assigning `true` fails the build. Add the named key to SPEC_VERBATIM_KEYS to fix.
const _SPEC_VERBATIM_KEYS_EXHAUSTIVE: [Exclude<SpecVerbatimKey, (typeof SPEC_VERBATIM_KEYS)[number]>] extends [never]
  ? true
  : { ADD_TO_SPEC_VERBATIM_KEYS: Exclude<SpecVerbatimKey, (typeof SPEC_VERBATIM_KEYS)[number]> } = true;
void _SPEC_VERBATIM_KEYS_EXHAUSTIVE;

/**
 * The ON-THE-WIRE turn spec — the SINGLE contract shared by the host producer (`redis-engine-runner.buildSpec`,
 * typed `: TurnSpec`) and the in-container consumer (`engine-entrypoint`, which imports this type). Verbatim
 * fields come straight from `RunEngineArgs`; the rest are the boundary-transformed fields.
 */
export interface TurnSpec extends Pick<RunEngineArgs, SpecVerbatimKey> {
  turnId: string;
  /** Rewritten to the container worktree path (see `toContainerCwd`). */
  cwd: string;
  /** Rewritten to container mount paths. */
  writableRoots: string[];
  /**
   * Secret + the non-secret `kind` discriminator (the container needs it to tell a Claude personal
   * credential from a setup-token) — the host-only `refreshBack` provenance is stripped so org ids never
   * ride Redis in.
   */
  auth?: { secret: string; kind?: 'setup-token' | 'personal' };
  /** Non-secret gate telling the in-container engine to write refreshed auth back (derived from `auth.refreshBack`). */
  persistAuthRefresh?: boolean;
  /** When present, activates the tool bridge — the host tool names to proxy via an MCP server. */
  toolBridgeTools?: string[];
}

/** Copy exactly `keys` from `obj` (typed). Used to forward verbatim wire fields without hand-listing spreads;
 *  `undefined` values are harmless (JSON serialization drops them, and absent ≡ undefined for the engine). */
export function pickKeys<T, K extends readonly (keyof T)[]>(obj: T, keys: K): Pick<T, K[number]> {
  const out = {} as Pick<T, K[number]>;
  for (const k of keys) out[k] = obj[k];
  return out;
}

/** Registry context carried on a Redis-transport turn (rebuilds the harness + brain tool closure on re-attach). */
export interface TurnMeta {
  jobId: string;
  orgId: string;
  /** SSE fan-out channel (repo id). */
  channel: string;
  /** Transcript lane: 'main' (brain) | 'thread:<threadId>' (a build thread) | 'codex-review:<jobId>'. */
  lane: string;
  kind: 'brain' | 'step' | 'review' | 'gate' | 'autofix' | 'compaction' | 'rotation';
  /** Per-kind params needed to rebuild the turn on re-attach (author, prompt, route, timeouts, …). */
  ctx?: Record<string, unknown>;
}

/**
 * The ENGINE_RUNNER port — the seam the driver / auto-fix consume to run a turn.
 * Always bound to `DockerEngineRunner` (exec inside a sandbox container). Docker is the only execution
 * mode; the former in-process `EngineRunner` has been removed.
 */
export interface EngineRunnerPort {
  run(args: RunEngineArgs): Promise<EngineRunResult>;
  /**
   * RE-ATTACH to an in-flight turn after a backend restart — resume tailing its durable Redis streams +
   * serving its tool bridge WITHOUT re-kicking the engine (the detached engine kept running). Only the
   * Redis runner implements it (the pipe runner has no restart-survivable turns); optional on the port.
   */
  reattach?(
    turnId: string,
    containerId: string,
    args: {
      onEvent?: (e: EngineEvent) => void;
      toolBridge?: ToolBridgeOptions;
      signal?: AbortSignal;
      /** Dispatch-time Claude credential id, host-only; used to stamp replayed rate-limit events. */
      credentialId?: string;
    },
  ): Promise<EngineRunResult>;
  /**
   * True while THIS process has a live attach loop tailing `turnId`. Guards the promotion re-attach
   * sweep from double-attaching a turn this same process kicked (a mid-day leader flap re-fires
   * `onPromote` while turns are in flight). Only the Redis runner implements it.
   */
  isAttached?(turnId: string): boolean;
  /**
   * STEER a running (`steerable`) turn: publish an operator message to `turn:{T}:input`, which the
   * in-container entrypoint injects into the live SDK session with `priority:'now'` (mid-turn steering).
   * The `id` (the steer's stimulus id) rides the frame so the engine can emit a correlated `input_ack`
   * once it PUSHES the message into the session — the durable proof it was taken (the caller stamps
   * `delivered_at` only on that ack, never on the write). No-op transport-wise if the turn already ended
   * (the engine has closed its input stream) — no ack ever comes, and the caller re-drives. Only the Redis
   * runner implements it.
   */
  steer?(turnId: string, id: string, text: string): Promise<void>;
  /**
   * STOP a running turn: publish a cooperative abort to `turn:{T}:abort`. The in-container entrypoint
   * aborts the SDK query; the engine writes a graceful `final` (the partial transcript is preserved) and
   * the normal completion path finalizes the registry row, reclaims the streams, and clears `turn_active`.
   * Only the Redis runner implements it.
   */
  stop?(turnId: string): Promise<void>;
  /**
   * Atomically claim the in-process attach slot for a turn (single synchronous check-and-add ⇒ no
   * TOCTOU): true if this caller now owns the slot, false if it was already claimed. Only the Redis
   * runner implements it.
   */
  tryClaimAttach?(turnId: string): boolean;
  /**
   * Release an attach slot claimed by {@link tryClaimAttach} when the caller bails before attaching.
   * Only the Redis runner implements it.
   */
  releaseAttach?(turnId: string): void;
  /**
   * Read+delete this turn's transient finalize outcome — for the error path where no `result` carries
   * `claimed`. Undefined when no outcome was recorded. Only the Redis runner implements it.
   */
  consumeClaim?(turnId: string): boolean | undefined;
}

/** DI token for {@link EngineRunnerPort}. */
export const ENGINE_RUNNER = Symbol('ENGINE_RUNNER');
