/**
 * Vendor-agnostic engine leaf types — the Atlas-side shapes that describe an engine turn's inputs,
 * events, usage, and results WITHOUT reaching into any vendor SDK or the NestJS backend. Moved here
 * from the backend's `engine.types.ts` so both the backend and the engine adapters share ONE
 * definition; the backend re-exports them for its existing import sites. Zero backend / NestJS / SDK
 * imports — this package stays standalone.
 */

/** The engine backing the session. */
export type SessionEngine = 'claude' | 'codex';

/**
 * How an engine turn runs — read-only vs. writes. Package-native mirror of the backend's `SessionMode`
 * literal space (`'plan'|'execute'|'review'|'investigate'`): structurally compatible but independently
 * named, so the engine port never imports a backend type. Only `'execute'` may write.
 */
export type EngineMode = 'plan' | 'execute' | 'review' | 'investigate';

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
   * NON-secret discriminator for Claude: `'personal'` credentials are an OAuth login delivered as the
   * `.credentials.json` file and are refreshable; `'setup-token'` credentials are a static env var. Absent
   * for Codex (whose `secret` is always an `auth.json` blob). Safe to serialize — carried over the wire on
   * `TurnSpec.auth.kind` so the in-container engine can tell the two apart.
   */
  kind?: 'setup-token' | 'personal';
  /**
   * HOST-SIDE provenance for the auth-refresh write-back: where to persist a refreshed `auth.json` back
   * to. Set ONLY when `secret` came from an org credential (never the env fallback — a process env var
   * can't be persisted). It is STRIPPED before the turn spec enters the container (the container never
   * needs it), so it never rides Redis into the sandbox. Absent → no write-back (env/local-dev runs).
   * `credentialId` lets the write-back target the exact `claude_credentials` row it came from.
   */
  refreshBack?: { orgId: string; engine: SessionEngine; credentialId?: string };
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

/** One JIT additionalContext injection's meta shape, joined to its tool call by id — reused by host +
 *  web fixtures. */
export interface JitInjection {
  rule: JitInjectionRule;
  text: string;
}

/** The set of JIT PostToolUse additionalContext rules that can tag a tool call (decision d2). */
export type JitInjectionRule = 'svc-nudge' | 'github-fetch-guard' | 'install-awareness';

/** A normalized progress event, emitted by both engines regardless of native event shape. */
export type EngineEvent =
  | { kind: 'text'; text: string; parentToolUseId?: string }
  /**
   * A parent→sub-agent injected input (e.g. via the SendMessage tool) — distinct from `text`, which is
   * the agent's own narration. Only ever emitted when `parentToolUseId` is SET (sub-agent only); the
   * main-thread operator-steer path persists at call time and never relies on this.
   */
  | { kind: 'user_text'; text: string; parentToolUseId?: string }
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
  /** One JIT additionalContext injection, joined to its tool call by `id` (== tool_use_id). Emitted at
   *  hook-fire time, independent of tool_result ordering (decision d6). */
  | {
      kind: 'jit_injection';
      id: string;
      rule: JitInjectionRule;
      text: string;
      parentToolUseId?: string;
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
      /** Dispatch-time credential the turn runs on — stamped HOST-side, never set by the in-container engine. */
      credentialId?: string;
    }
  /**
   * Lifecycle of an SDK `run_in_background` Bash task, surfaced to the operator. The engine holds the turn's
   * query() session open while any such task is in flight (see the `bg_task` handling in engine-core), so the
   * task's completion and the model's auto-continuation arrive in the SAME turn. `status:'started'` is emitted
   * on `system/task_started`; the settlement statuses (`completed`/`failed`/`stopped`) mirror
   * `system/task_notification`; `capped` is emitted when a bare bg Bash task exceeds the hold cap — an ADVISORY
   * signal only (the task keeps running and is NOT killed; the agent is nudged toward atlas-svc and the model's
   * next natural result ends the turn). Subagents run uncapped, so they never emit `capped`. Live-only — not
   * part of the durable transcript.
   */
  | {
      kind: 'bg_task';
      taskId?: string;
      status: 'started' | 'completed' | 'failed' | 'stopped' | 'capped';
      detail?: string;
      taskType?: string;
      /**
       * The spawning `Task` tool_use id (the SDK's `tool_use_id`), set for a backgrounded Task SUBAGENT so
       * the web can correlate this lifecycle event to that subagent's card (== the child blocks'
       * `parentToolUseId`). A backgrounded Task returns its `tool_result` immediately (a launch ack, not the
       * real result), so the card can't use the anchor's own `done` to know the subagent finished — it marks
       * the anchor settled on the SETTLEMENT status here instead. Absent for a bare Bash bg task / the
       * `capped` synthetic (no originating tool call to attribute).
       */
      parentToolUseId?: string;
    }
  /**
   * Diagnostic breadcrumb for a streaming turn's control channel — emitted on each success `result`
   * (carrying that result's `terminal_reason`/`stop_reason`) and once at teardown (carrying the per-turn
   * `streamClosedCount`). Instrumentation only: the turn harness folds the latest values into the durable
   * `turn_meta` block so a control-channel wobble ("Stream closed" host-tool results) is diagnosable after
   * the live Redis stream is gone.
   */
  | {
      kind: 'turn_debug';
      terminalReason?: string;
      stopReason?: string | null;
      streamClosedCount?: number;
    }
  /**
   * The SDK is RETRYING a failed API request natively (overloaded/5xx/gateway/rate-limit) with its own
   * backoff — surfaced (not host-retried) to drive the live "Reconnecting…" indicator mid-turn. `reason`
   * is the SDK's `error` discriminator (e.g. 'overloaded'|'server_error'|'rate_limit'). Live-only.
   */
  | {
      kind: 'api_retry';
      attempt: number;
      maxRetries: number;
      retryDelayMs: number;
      errorStatus: number | null;
      reason: string;
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
   * The reasoning effort the run used, when one was passed. Stamped engine-agnostically (Codex and
   * Claude both). Display-only: threads through to the composer footer as the "· xHigh" suffix.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * For a Codex turn: whether it ran through the `codex app-server` JSON-RPC {@link CodexAppServerAdapter}
   * (`true`) or the legacy `@openai/codex-sdk` exec-JSONL path (`false`). Undefined for a Claude turn —
   * the distinction is Codex-only. Display/provenance only, driven by `CODEX_APPSERVER_ENABLED`.
   */
  appserver?: boolean;
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
 * Codex reasoning effort — mirrors `@openai/codex-sdk`'s `ModelReasoningEffort` (v0.137.0). Kept as a
 * local union so this stays SDK-import-free (the SDK is loaded dynamically in-container).
 */
export type CodexReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

/** Engine-agnostic reasoning effort. Superset of Codex's (adds 'max') and Claude's (adds 'minimal')
 *  value spaces; mapped to each engine's own type at the SDK boundary. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A detected subscription limit hit — the resume metadata the host parks the lane on. */
export type SessionLimitHit = {
  /** ISO-8601 instant the limit window resets, when known (best-effort). */
  resetAt?: string;
  /** The SDK's window bucket (e.g. `five_hour`, `seven_day_opus`), when the structured frame carried one. */
  rateLimitType?: string;
  /** 0-100 window utilization at the time of the hit, when reported. */
  utilization?: number;
  /** Which detection path produced this hit. Absent ⇒ treat as 'structured' (back-compat for old fixtures). */
  source?: 'structured' | 'text';
};

/** The result of one engine run — the report, the resume handle, and optional plan/usage. */
export interface EngineRunResult {
  result: string;
  sessionId?: string;
  /** The captured plan text on a Claude 'plan' turn (the substance is the plan, not the summary). */
  planText?: string;
  usage?: EngineUsage;
  /**
   * The post-run refreshed engine credential when the turn ROTATED its tokens (Codex rewrites its `auth.json`
   * overlay in place; Claude's SDK rewrites `.credentials.json` for a personal login) AND
   * `RunEngineArgs.persistAuthRefresh` was set. Relayed back over the final frame so the host can persist it
   * to the org credential store, keeping the stored subscription credential live instead of a rotting
   * snapshot. Contains a SECRET — never log it. Absent on the common (no-refresh) path.
   */
  refreshedAuthSecret?: string;
  /**
   * Set when the turn ended because the org hit a Claude subscription session/usage limit (structured
   * `rate_limit_event` status:'rejected', or the printed-line fallback). The turn was ended CLEANLY (no
   * held-open resume) — the caller parks the lane + schedules an auto-resume at `resetAt`.
   */
  sessionLimit?: SessionLimitHit;
  /** Count of "Stream closed" host-tool results seen in this turn (control-channel failures). Absent/0 on a healthy turn; a positive value flags a control-channel wobble even if the circuit-breaker didn't trip. */
  streamClosedCount?: number;
  /**
   * False ⇒ another finisher already claimed (deleted) this turn's active_turns row, so the caller MUST
   * discard (persist nothing). Undefined ⇒ treat as claimed (back-compat for non-redis / test paths).
   */
  claimed?: boolean;
  /**
   * The engine turn id minted in `RedisEngineRunner.run`/known to `reattach`. Surfaced so the brain harness
   * can stamp a stable per-block identity key `${turnId}:${ordinal}` for idempotent (re)persist. Undefined on
   * non-redis / test paths.
   */
  turnId?: string;
  /** The claude_credentials.id this turn authed on (host-resolved at the runner seam; from the reattach
   *  registry ctx on a re-attach). Absent for Codex / no-credential turns. */
  credentialId?: string;
}

/**
 * The structured parts that key an engine home — the nested `<org>/<repo>/<job>/<type>/[<subId>]` layout
 * that namespaces each engine's isolated `CLAUDE_CONFIG_DIR` / `CODEX_HOME` so two concurrent surfaces (or
 * two jobs) never share engine state. The backend resolver functions (`atlasEngineHomeDir` et al.) turn a
 * key into a real filesystem path; this package only owns the shape.
 */
export type EngineHomeType = 'brain' | 'build' | 'plan-review' | 'autofix' | 'review';

/** The structured parts that key an engine home — see {@link EngineHomeType} for the layout. */
export interface EngineHomeKey {
  orgId: string;
  repoId: string;
  jobId: string;
  type: EngineHomeType;
  /** Extra path segment for a parallel sub-session sharing this (org,repo,job,type) — e.g. an autofix
   *  review-lens/fix id. Absent for the one primary session per type. */
  subId?: string;
}

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
    /** Which engine's credential failed — so the operator halt copy names the RIGHT integration (Claude vs Codex). */
    readonly engine?: SessionEngine,
    /**
     * A DETERMINISTIC-fatal auth failure (no account / expired refresh) that must NOT be host-retried —
     * it surfaces immediately instead of going through the bounded host auto-retry backstop.
     */
    readonly fatal?: boolean,
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
    readonly credentialId?: string,
    readonly source: 'structured' | 'text' = 'structured',
  ) {
    super(message);
    this.name = 'EngineSessionLimitError';
  }
}

/** Whether an EngineAuthError is a TRANSIENT hiccup the host should auto-retry (a "not logged in"/401 that
 *  may self-heal on a token rotation) rather than a deterministic-fatal one (no account / expired refresh),
 *  which surfaces immediately. Fatal = the `fatal` flag OR a NO_ENGINE_CREDENTIAL marker. */
export function isTransientAuthError(err: EngineAuthError): boolean {
  if (err.fatal) return false;
  if (err.message.includes(NO_ENGINE_CREDENTIAL_MARKER)) return false;
  return true;
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

/** Host-side auto-retry budget (d1-B): re-run a transient auth/transport error this many times. */
export const MAX_HOST_RETRIES = 10;
/** Fixed backoff between host-side auto-retries (d1-B). NOT the SDK's native API backoff (that stays the
 *  SDK's own exponential schedule via CLAUDE_CODE_MAX_RETRIES). */
export const HOST_RETRY_BACKOFF_MS = 10_000;

/** Host↔container transport / infra blip signatures a bounded host retry papers over. Deliberately does
 *  NOT match `overloaded`/`529`/5xx API errors — those are the SDK's OWN configured retry
 *  (CLAUDE_CODE_MAX_RETRIES); re-running them host-side would double-retry. Moved here from the build lane's
 *  former TRANSIENT_ERROR_RE (content unchanged) so both host lanes share ONE allowlist. */
export const HOST_TRANSPORT_TRANSIENT_RE =
  /econnreset|econnrefused|etimedout|epipe|socket hang up|connection reset|connection refused|network error|no such container|container .*(not running|is not running|gone)|exec failed|failed to (start|create) (the )?container|redis|stream .*(closed|reset)|xread|503|502|temporarily unavailable|index\.lock|another git process seems to be running/;

/** API failures that already spent the SDK's own retry loop. Keep them out of the host retry allowlist. */
export const SDK_RETRY_EXHAUSTED_API_RE =
  /\bapi error\b|\boverloaded(?:_error)?\b|\brate[ _-]?limit(?:ed|_error)?\b|\bserver[ _-]?error\b|\b(?:claude|anthropic)\b.*\b(?:api|502|503|504|529|bad gateway)\b|\b(?:api|502|503|504|529|bad gateway)\b.*\b(?:claude|anthropic)\b/;

/**
 * Whether the HOST should auto-retry this error on the SAME session (d2 bucket 2): a transient
 * EngineAuthError, OR a host-transport/infra blip matching {@link HOST_TRANSPORT_TRANSIENT_RE}. Returns
 * FALSE (surface as today) for: a deterministic-fatal/NO_ENGINE_CREDENTIAL auth error, a session limit, a
 * detached turn, an unresumable session, a phase-timeout, and ANY unrecognized error (d3 — never silently
 * retry a genuine bug). NOTE: overloaded/5xx are the SDK's own retry, NOT matched here.
 * Classification-consistency check (post-#231): a Claude session limit thrown mid-turn is now latched into
 * a clean `result.sessionLimit` by engine-core's outer catch BEFORE it would ever reach this predicate as a
 * thrown `err` — the `isSessionLimitError(err)` guard above is a defensive backstop for the OTHER lanes that
 * still throw `EngineSessionLimitError` directly (e.g. the build-lane `turn-runner.service.ts`), not dead code.
 */
export function isRetryableTransientError(err: unknown): boolean {
  if (err instanceof EngineAuthError) return isTransientAuthError(err);
  if (isSessionLimitError(err) || isEngineDetachedError(err)) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes(UNRESUMABLE_SESSION_MARKER.toLowerCase())) return false;
  if (msg.includes('phase_timeout_ms')) return false;
  // An escaped Claude-API 5xx (overloaded/bad-gateway) surfaces as a thrown Error whose stderr tail carries
  // the CLI's `API Error: 5xx` text — Layer A that ALREADY exhausted the SDK's own CLAUDE_CODE_MAX_RETRIES
  // backoff. Its literal '502'/'503' would otherwise match HOST_TRANSPORT_TRANSIENT_RE and trigger ANOTHER
  // full host retry cycle (the double-retry the design forbids). Exclude these upstream-API messages so a
  // spent Layer-A error surfaces promptly instead of silently re-running host-side.
  if (SDK_RETRY_EXHAUSTED_API_RE.test(msg)) return false;
  return HOST_TRANSPORT_TRANSIENT_RE.test(msg);
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

/** Sentinel prefix a no-credential auth halt carries so the operator copy can be specific. */
export const NO_ENGINE_CREDENTIAL_MARKER = 'NO_ENGINE_CREDENTIAL';

/** Map a raw EngineAuthError message to clean, actionable operator copy — never leak SDK/CLI text. The
 *  `engine` names the failing integration so the copy points at the RIGHT account (Claude vs Codex);
 *  when unknown, the message itself is inspected and Claude is the safe default. */
export function cleanAuthHaltReason(rawMessage: string, engine?: SessionEngine): string {
  const label = (engine ?? (/\bcodex\b/i.test(rawMessage) ? 'codex' : 'claude')) === 'codex' ? 'Codex' : 'Claude';
  if (rawMessage.includes(NO_ENGINE_CREDENTIAL_MARKER)) {
    return `No ${label} account is connected for this org — connect one in Settings, then resume.`;
  }
  return `Your ${label} login needs to be reconnected — reconnect the account in Settings, then resume.`;
}
