/**
 * Atlas v2's MINIMAL engine seam — a clean-room rewrite of v1's `worker-engine.port.ts` stripped to
 * exactly what W1 needs: run one Claude/Codex turn in plan or execute mode, threading credentials and
 * an isolated agent home. No roles, no effort knob, no AskUserQuestion relay, no skills/MCP — those
 * v1 concepts are dropped (engines run vanilla). Zero v1 imports.
 */
import type { SessionEngine, SessionMode } from '../domain';
import type { EngineHomeKey } from './engine-home';
import type { SessionLimitHit } from './session-limit';

export type { SessionLimitHit } from './session-limit';

/**
 * How an engine (SDK harness) turn authenticates — ALWAYS a subscription secret. The api_key mode was
 * removed: running the harness on a metered API key is ruinously expensive, so there is no key path
 * and no fallback — a missing secret throws (see `EngineCore.resolveAuth`). For Claude, `secret` is a
 * `CLAUDE_CODE_OAUTH_TOKEN`; for Codex it's an `auth.json` blob the overlay home is seeded with.
 * (The non-agentic LangChain chains keep using `ANTHROPIC_API_KEY` — that path is unrelated.)
 */
export type EngineAuth = {
  secret: string;
  /**
   * HOST-SIDE provenance for the auth-refresh write-back: where to persist a refreshed `auth.json` back
   * to. Set ONLY when `secret` came from an org credential (never the env fallback — a process env var
   * can't be persisted). It is STRIPPED before the turn spec enters the container (the container never
   * needs it), so it never rides Redis into the sandbox. Absent → no write-back (env/local-dev runs).
   */
  refreshBack?: { orgId: string; engine: SessionEngine };
};

/**
 * One hunk of an Edit/MultiEdit's structured patch (the SDK `tool_use_result.structuredPatch` shape):
 * REAL 1-based file offsets + sign-prefixed lines (`' '` context / `'+'` add / `'-'` del). Carried on
 * `tool_result` so the web diff gutter shows true file line numbers instead of restarting at 1.
 */
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A normalized progress event, emitted by both engines regardless of native event shape. */
export type EngineEvent =
  | { kind: 'text'; text: string; parentToolUseId?: string }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'result'; text: string }
  /**
   * Emitted ONCE as soon as the engine session/thread id is known (turn start) — BEFORE any work. Lets
   * the caller persist the resume handle immediately, so a mid-turn halt (process crash, container/host
   * restart, kill) recovers by CONTINUING this same session instead of spawning a fresh one.
   */
  | { kind: 'session'; sessionId: string }
  /**
   * Emitted when a mid-turn steer (an operator message on `turn:{T}:input`) has been PUSHED into the live
   * SDK session — the durable ACK that the message was actually taken, not just written to the stream. `id`
   * echoes the steer's stimulus id so the host can stamp that message `delivered_at`. Rides the events
   * stream like any other frame, so it survives a host detach + boot re-attach (replayed with the log).
   */
  | { kind: 'input_ack'; id: string }
  // ── Rich streaming (emitted only when `RunEngineArgs.richStream` is set — the thread BRAIN turn). The
  //    `*_delta` kinds are LIVE-only (token-by-token); the full-block kinds (`text`/`thinking`/`tool_use`/
  //    `tool_result`) are AUTHORITATIVE — the caller persists those as the durable transcript. ──
  //
  // `parentToolUseId` (authoritative blocks only): the SDK message's `parent_tool_use_id`. UNSET for the
  // main agent (the brain); SET to the spawning `Task` tool_use id for blocks produced by a SUBAGENT. The
  // caller uses it to peel subagent activity out of the main transcript into its own sub-page.
  /** A live assistant-text token chunk (not persisted; reconciled by the final `text` block).
   *  `parentToolUseId` is SET when the chunk belongs to a SUBAGENT, so live rendering nests it the same
   *  way the authoritative `text` block does. */
  | { kind: 'text_delta'; text: string; parentToolUseId?: string }
  /** A complete thinking block (authoritative — persisted). */
  | { kind: 'thinking'; text: string; parentToolUseId?: string }
  /** A live thinking token chunk (not persisted). `parentToolUseId` SET for subagent chunks. */
  | { kind: 'thinking_delta'; text: string; parentToolUseId?: string }
  /** A tool call with its input (authoritative). Pairs with `tool_result` by `id`. */
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      input?: unknown;
      parentToolUseId?: string;
    }
  /** A tool result (authoritative). `id` correlates to the `tool_use`. */
  | {
      kind: 'tool_result';
      id: string;
      result?: unknown;
      isError?: boolean;
      parentToolUseId?: string;
      /** Edit/MultiEdit only: the SDK's structured patch (real file offsets) for an accurate diff gutter. */
      structuredPatch?: StructuredPatchHunk[];
    }
  /**
   * LIVE context-window occupancy — emitted mid-turn each time an agent produces an assistant message (i.e.
   * every model round-trip), so a context ring updates DURING a long turn instead of only at `finish`.
   * `parentToolUseId` UNSET = the MAIN agent (drives the composer's own ring); SET = a subagent's own
   * occupancy, keyed by its spawning Task id (drives that subagent card's ring). Live-only: NOT persisted as
   * a durable block (the turn-end `turn_meta` stays authoritative); `contextLimit` is resolved engine-side so
   * the client renders the ring without its own model→window map. Claude-only — the Codex SDK surfaces no
   * per-call token counts before its turn end.
   */
  | {
      kind: 'usage';
      parentToolUseId?: string;
      contextTokens: number;
      contextModel?: string;
      contextLimit: number;
    }
  /** A subscription rate-limit frame harvested from the SDK's `rate_limit_event` stream (claude.ai plans only).
   *  Carries the raw window info so the host can update the per-org usage snapshot AND (when status==='rejected')
   *  park the lane. Live-only; never persisted as a transcript block. */
  | {
      kind: 'rate_limit';
      status: 'allowed' | 'allowed_warning' | 'rejected';
      resetsAt?: number;        // epoch ms, verbatim from the SDK
      rateLimitType?: string;
      utilization?: number;
    }
  /**
   * Lifecycle of an SDK `run_in_background` Bash task, surfaced to the operator. The engine holds the turn's
   * query() session open while any such task is in flight (see the `bg_task` handling in engine-core), so the
   * task's completion and the model's auto-continuation arrive in the SAME turn. `status:'started'` is emitted
   * on `system/task_started`; the settlement statuses (`completed`/`failed`/`stopped`) mirror
   * `system/task_notification`; `capped` is emitted when the hold hit BG_TASK_MAX_HOLD_MS and the turn was
   * force-finalized (the task was still running and gets killed). Live-only — not part of the durable transcript.
   */
  | {
      kind: 'bg_task';
      taskId?: string;
      status: 'started' | 'completed' | 'failed' | 'stopped' | 'capped';
      detail?: string;
      taskType?: string;
    };

/**
 * One model's slice of a turn's usage — the SDK's per-model breakdown (Claude only; absent for Codex).
 * All counts/cost are SDK-computed. Keyed by model id inside {@link EngineUsage.modelUsage}.
 */
export interface ModelUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** SDK-computed cost for THIS model's share of the turn. */
  costUsd: number;
  webSearchRequests?: number;
}

/** Vendor-neutral token-usage counts (all optional — engines populate what their SDK reports). */
export interface EngineUsage {
  /**
   * Grand-total input INCLUDING cache, SUMMED across every model round-trip in the turn (fresh +
   * cacheRead + cacheWrite). This is the BILLING number — correct for cost ("N in · M cache · $X"),
   * but WRONG as context occupancy: a multi-round-trip turn re-reads the same context from cache each
   * round, so this balloons far past the window. For occupancy use {@link contextTokens}.
   */
  inputTokens?: number;
  /** Grand-total output INCLUDING reasoning. */
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Exact cost when the SDK provides it (Claude); absent for Codex (priced server-side). */
  costUsd?: number;
  /** The real model id the run used (for billing — sourced from the cumulative usage, may be a helper). */
  model?: string;
  /**
   * The CONTEXT-WINDOW OCCUPANCY proxy: the input-token size of a SINGLE model round-trip (fresh +
   * cacheRead + cacheWrite for that one call), NOT the cumulative {@link inputTokens} sum. This is how
   * full the context window actually is — render the occupancy ring against this. Tracked from the
   * MAIN agent's last round-trip only (subagents run in their own context on cheaper models). Absent
   * when the engine doesn't surface per-call usage (e.g. Codex).
   */
  contextTokens?: number;
  /**
   * The model id of the round-trip {@link contextTokens} came from — the MAIN agent's real model, so
   * the occupancy ring resolves the right window even when {@link model} reflects a helper. Absent
   * when no per-call model was seen.
   */
  contextModel?: string;
  /**
   * Per-model usage breakdown for the WHOLE turn (orchestrator + any subagents), keyed by model id —
   * the SDK's `result.modelUsage` map carried verbatim (Claude only; absent for Codex). The
   * authoritative source for per-model token/cost analytics; the flat fields above collapse it to one.
   */
  modelUsage?: Record<string, ModelUsageBreakdown>;
  /**
   * Which engine ran this turn — stamped from the run's `args.engine` so the web can label a turn that
   * carries no {@link model} (e.g. a Codex run, whose SDK doesn't surface a model id) as "Codex".
   * Display-only provenance; not part of any billing number.
   */
  engine?: SessionEngine;
  /**
   * The reasoning effort the run used, when one was passed (Codex-only input — see
   * {@link RunEngineArgs.modelReasoningEffort}; undefined for Claude, which has no effort knob).
   * Display-only: threads through to the composer footer as the "· xHigh" suffix.
   */
  reasoningEffort?: CodexReasoningEffort;
}

/**
 * Per-model context-window size (max input tokens), keyed by a substring of the real model id the turn
 * reported in {@link EngineUsage.model}. The web renders a context-occupancy ring against this, so it
 * threads whatever model the brain runs — never hardcoded on the client.
 *
 * Current official windows (Anthropic docs): Opus 4.x and Sonnet 4.x are 1M, Haiku is 200k. The
 * authoritative long-term source is the Models API `max_input_tokens`; this static map is the v1 proxy
 * and is the single place to edit if a window changes. Order matters — first matching substring wins.
 */
const MODEL_CONTEXT_LIMITS: ReadonlyArray<readonly [match: string, limit: number]> = [
  ['opus', 1_000_000],
  ['sonnet', 1_000_000],
  ['haiku', 200_000],
];

/** Fallback window when the model id is unknown/absent — the conservative 200k floor. */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

/**
 * The Codex INPUT context window. Codex runs subscription-only with NO pinned model (the account default is
 * used and the SDK never reports which id), so its window can't be resolved from a model id. Per OpenAI's
 * Codex product limits (GPT-5.x family, 2026): the Codex surface caps the window at 400K TOTAL, split into
 * 272K input + 128K reserved output (the raw API model is 1M — deliberately capped in Codex). The ring's
 * occupancy is per-turn INPUT tokens, so the denominator is the 272K input window, NOT the 400K total (the
 * Codex CLI itself keeps ~5% headroom → reports ~258K effective; we use the clean input window). Adjust
 * here if the account's default model / Codex caps change.
 */
export const CODEX_CONTEXT_LIMIT = 272_000;

/**
 * Resolve a model's context-window size (max input tokens) from its reported id. When the id is
 * unknown/absent, `engine` disambiguates the fallback: a Codex turn (no model id, ever) gets the Codex
 * window; everything else the conservative default floor.
 */
export function resolveContextLimit(model?: string, engine?: SessionEngine): number {
  const id = (model ?? '').toLowerCase();
  for (const [match, limit] of MODEL_CONTEXT_LIMITS) {
    if (id.includes(match)) return limit;
  }
  if (engine === 'codex') return CODEX_CONTEXT_LIMIT;
  return DEFAULT_CONTEXT_LIMIT;
}

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
 * Authenticated-git for a turn: the remote url + org PAT the sandbox agent uses to fetch/push, plus the
 * resolved commit {@link SandboxGitIdentity} to attribute its commits to. See {@link ExecutionTarget.gitAuth}.
 */
export interface GitAuth {
  gitUrl: string;
  token?: string;
  identity?: SandboxGitIdentity;
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
  'and in-memory state is gone — but files you committed to the worktree are intact. Run `atlas-svc ps` to',
  'see which supervised services are now `stopped`, and restart the ones you need with `atlas-svc run`.',
  'Before relying on any server, verify it is actually up (curl/health-check). Do not assume anything you',
  'started in a previous turn is still alive.',
].join(' ');

/**
 * Injected IN-TURN as a steer message when a `run_in_background` Bash task keeps the turn held past
 * BG_TASK_MAX_HOLD_MS. The engine ends the SDK session right after (killing the still-running task), so this
 * reaches the agent in the exact context where it backgrounded the task — steering it to `atlas-svc` for any
 * genuinely long-running process. In the spirit of {@link SANDBOX_RESET_NOTICE}: a one-time signal, not part
 * of the byte-stable system prompt.
 */
export const BG_TASK_CAP_NOTICE = [
  '[background task capped] A Bash task you started with run_in_background was still running when this turn',
  'hit its maximum hold time, so it was ended and is NO LONGER RUNNING. run_in_background is only for SHORT,',
  'finite work (a build, a migration, a test suite) that finishes on its own. Long-running processes — dev',
  'servers, file/test watchers, headless browsers, docker compose services — belong under atlas-svc: start',
  'them with `atlas-svc run …` (supervised, survives across turns) and check them with `atlas-svc ps`. Do',
  'not rely on the capped task having completed; re-run its work under atlas-svc if you still need it.',
].join(' ');

/**
 * Codex reasoning effort — mirrors `@openai/codex-sdk`'s `ModelReasoningEffort` (v0.137.0). Kept as a
 * local union so `engine.types.ts` stays SDK-import-free (the SDK is loaded dynamically in-container).
 */
export type CodexReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

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
  task: string;
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
  systemPrompt: string;
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
   * NON-SECRET gate telling the in-container Codex engine to READ its refreshed `auth.json` overlay back
   * after the turn (and relay it on {@link EngineRunResult.refreshedAuthSecret}). Serialized into the turn
   * spec (unlike the secret-bearing `auth.refreshBack`, which is host-only). The runner sets it to
   * `!!auth.refreshBack`, so ONLY org-sourced runs read back — env-fallback runs (which inject an ambient
   * `CODEX_OAUTH_TOKEN` the container can't distinguish) never emit a secret into the final frame.
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
   * Codex-only: the reasoning effort for this run (maps to the SDK's `ThreadOptions.modelReasoningEffort`).
   * Unset → the account/CLI default. The plan-review turn pins `'xhigh'` so the reviewer reasons hard.
   * (A ChatGPT-account token REJECTS an explicit `model`, but ACCEPTS this knob — verified by spike.)
   */
  modelReasoningEffort?: CodexReasoningEffort;
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
  rotationNudge?: { softTokens: number; reminderDeltaTokens: number; softText: string; reminderText: string };
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
  | 'onEvent' | 'signal' | 'steerInput' | 'onTurnRegistered' | 'target' | 'toolBridge' | 'turnMeta';
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
  'userMcpServers', 'repoConventions', 'skills', 'grantedSkills', 'model', 'modelReasoningEffort', 'richStream', 'steerable', 'rotationNudge',
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
  /** Secret only — the host-only `refreshBack` provenance is stripped so org ids never ride Redis in. */
  auth?: { secret: string };
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

/** The result of one engine run — the report, the resume handle, and optional plan/usage. */
export interface EngineRunResult {
  result: string;
  sessionId?: string;
  /** The captured plan text on a Claude 'plan' turn (the substance is the plan, not the summary). */
  planText?: string;
  usage?: EngineUsage;
  /**
   * The post-run Codex `auth.json` overlay when the turn REFRESHED its tokens (Codex rewrites the file in
   * place) AND `RunEngineArgs.persistAuthRefresh` was set. Relayed back over the final frame so the host
   * can persist it to the org credential store, keeping the stored subscription credential live instead of
   * a rotting snapshot. Contains a SECRET — never log it. Absent on the common (no-refresh) path.
   */
  refreshedAuthSecret?: string;
  /**
   * Set when the turn ended because the org hit a Claude subscription session/usage limit (structured
   * `rate_limit_event` status:'rejected', or the printed-line fallback). The turn was ended CLEANLY (no
   * held-open resume) — the caller parks the lane + schedules an auto-resume at `resetAt`.
   */
  sessionLimit?: SessionLimitHit;
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
}

/** DI token for {@link EngineRunnerPort}. */
export const ENGINE_RUNNER = Symbol('ENGINE_RUNNER');

/**
 * A CREDENTIAL/auth failure during a turn (a 401 / expired token / "not logged in"), distinguished
 * from a normal turn error so the driver can PAUSE (and later resume the SAME engine session on a ping)
 * instead of failing the job from scratch. Carries the engine `sessionId` when one was established
 * before the failure — the resume handle that lets a re-ping continue where the agent left off (its
 * partial work is already on disk in the worktree + remembered in the session transcript).
 */
export class EngineAuthError extends Error {
  /** Discriminator that survives a structuredClone / cross-process reconstruction. */
  readonly isAuthError = true;
  constructor(
    message: string,
    /** The engine session to resume on a re-ping (undefined if the 401 hit before a session started). */
    readonly sessionId?: string,
  ) {
    super(message);
    this.name = 'EngineAuthError';
  }
}

/**
 * The turn ended because the org hit a Claude subscription SESSION/USAGE limit (not a crash, not a 401).
 * The build lane throws this so its halt-classification chokepoint parks the lane on a durable resume clock
 * instead of failing the job. Carries the resume metadata + the engine `sessionId` to continue the SAME
 * session on resume (mirrors {@link EngineAuthError}).
 */
export class EngineSessionLimitError extends Error {
  readonly isSessionLimit = true;
  constructor(
    message: string,
    readonly resetAt?: string,
    readonly rateLimitType?: string,
    readonly sessionId?: string,
  ) {
    super(message);
    this.name = 'EngineSessionLimitError';
  }
}

export function isSessionLimitError(err: unknown): boolean {
  return (
    err instanceof EngineSessionLimitError ||
    (err as { isSessionLimit?: boolean })?.isSessionLimit === true
  );
}

/**
 * The host LOST ITS TRANSPORT to a still-running turn — the Redis tail failed mid-turn (typically the
 * process's own shutdown closing the client during a watch respawn), NOT the engine concluding. The
 * detached engine keeps running and keeps writing its durable streams, so the correct reaction everywhere
 * is to WALK AWAY: leave the `active_turns` row and the streams for the next boot's re-attach, persist
 * nothing (the re-attach replays the log from the start — a partial persist here would double it), and
 * post no operator-facing failure (the turn didn't fail). See ADR 0001.
 */
export class EngineDetachedError extends Error {
  /** Discriminator that survives error re-wrapping across module seams. */
  readonly isDetachedError = true;
  constructor(message: string) {
    super(message);
    this.name = 'EngineDetachedError';
  }
}

/** Whether this error is the host losing its tail mid-turn (see {@link EngineDetachedError}). */
export function isEngineDetachedError(err: unknown): boolean {
  return err instanceof EngineDetachedError || (err as { isDetachedError?: boolean })?.isDetachedError === true;
}

/**
 * A marker embedded in the thrown error when a stored engine session can't be resumed — its transcript
 * is missing from the config dir (e.g. the agent-home dir name changed, or the home was cleared). Unlike
 * a normal turn error, RETRYING is futile: the session state is gone for good and the thread must be
 * recreated. The marker is plain text so it survives the in-container → host error-frame boundary; the
 * host matches it via {@link isUnresumableSessionMessage} to show a specific, actionable message.
 */
export const UNRESUMABLE_SESSION_MARKER = 'ENGINE_SESSION_UNRESUMABLE';

/** Whether this engine error is an unresumable-session failure (see {@link UNRESUMABLE_SESSION_MARKER}). */
export function isUnresumableSessionMessage(message: string): boolean {
  return message.includes(UNRESUMABLE_SESSION_MARKER);
}

/** Heuristic: does this engine error message look like a credential/401 failure (vs a normal error)? */
export function isAuthErrorMessage(message: string): boolean {
  return /\b401\b|not logged in|please run \/login|invalid[ _-]?api[ _-]?key|invalid x-api-key|authentication[ _]?error|\bunauthorized\b|oauth[^.]*\b(expired|invalid|revoked)\b|token[^.]*\b(expired|revoked)\b|permission_error/i.test(
    message,
  );
}
