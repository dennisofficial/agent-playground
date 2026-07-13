import type { CanUseTool, Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Codex, FileChangeItem, ThreadOptions } from '@openai/codex-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative as relativePath, resolve as resolvePath } from 'node:path';
import { structuredPatch as diffStructuredPatch } from 'diff';
import { detectSessionLimitText, limitFromRateEvent, parseResetAt, type SessionLimitHit } from './session-limit';
import { atlasEngineHomeDir, engineHomeKeyString, type EngineHomeKey } from './engine-home';
import { type CodexExtraMcpServers, type CodexMcpBridge, ensureCodexAuthHome } from './codex-auth-home';
import { getEngineAuthAdapter } from './engine-auth-adapter';

/** In-container path of the bundled Codex MCP tool-bridge server (baked by the Dockerfile, bind-mounted
 *  live — see `sandbox/image/mcp-bridge-server.ts`). codex spawns it via the config.toml `command`. */
const CONTAINER_MCP_BRIDGE_PATH = '/usr/local/lib/atlas/mcp-bridge-server.mjs';
// Import from the DIRECT (Nest-free) assembly path, not the prompt-kit barrel — this module bundles into the
// in-container engine, and the barrel re-exports the NestJS PromptService/PromptKitModule.
import { renderAgentPrompt } from '../prompt-kit/system/assemble';
import { Agent } from '../prompt-kit/system/agent';
import { fromExternal, type AgentMessage } from '../prompt-kit/message';
import { LSP_NAV_TOOL_NAMES, LSP_TOOL_NAMES, qualifyLspToolNames } from './lsp-tools';
import {
  bgTaskCapRule,
  BG_TASK_HOLD_CAP_MS,
  legRotationRule,
  svcNudgeRule,
  svcNudgeShouldFire,
  detectLongRunningCommand,
  SVC_NUDGE_TEXT,
} from '../prompt-kit/jit';
import {
  EngineAuthError,
  isAuthErrorMessage,
  NO_ENGINE_CREDENTIAL_MARKER,
  UNRESUMABLE_SESSION_MARKER,
  type CodexReasoningEffort,
  type EngineAuth,
  type EngineRunResult,
  type EngineUsage,
  type ModelUsageBreakdown,
  type ReasoningEffort,
  type RunEngineArgs,
  type StructuredPatchHunk,
  resolveContextLimit,
} from './engine.types';

/**
 * Pull a well-formed `structuredPatch` (real file offsets) off an Edit/MultiEdit `tool_use_result`.
 * Returns undefined for any other tool, or when the shape doesn't match — so the caller simply omits it.
 */
function extractStructuredPatch(toolUseResult: unknown): StructuredPatchHunk[] | undefined {
  if (!toolUseResult || typeof toolUseResult !== 'object') return undefined;
  const raw = (toolUseResult as { structuredPatch?: unknown }).structuredPatch;
  if (!Array.isArray(raw)) return undefined;
  const hunks: StructuredPatchHunk[] = [];
  for (const h of raw) {
    if (!h || typeof h !== 'object') continue;
    const r = h as Record<string, unknown>;
    if (!Array.isArray(r.lines)) continue;
    const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);
    hunks.push({
      oldStart: num(r.oldStart, 1),
      oldLines: num(r.oldLines, 0),
      newStart: num(r.newStart, 1),
      newLines: num(r.newLines, 0),
      lines: (r.lines as unknown[]).map(String),
    });
  }
  return hunks.length ? hunks : undefined;
}

function containsStreamClosed(content: unknown): boolean {
  if (typeof content === 'string') return content.toLowerCase().includes('stream closed');
  if (Array.isArray(content)) return content.some((item) => containsStreamClosed(item));
  if (!content || typeof content !== 'object') return false;
  const block = content as { text?: unknown; content?: unknown };
  return containsStreamClosed(block.text) || containsStreamClosed(block.content);
}

/**
 * Codex's `file_change` item reports only `{ path, kind }` — never the before/after content the SDK
 * would need to hand us a diff (unlike Claude's Edit tool, which carries `old_string`/`new_string` and a
 * `structuredPatch` on its own tool result). Reconstruct one here: the last committed blob (`git show
 * HEAD:path`) stands in for "before" and the current on-disk file for "after". This is a `HEAD`-relative
 * diff, not a per-edit one — fine as long as the worktree isn't committed mid-turn (it isn't).
 */
function computeCodexStructuredPatch(cwd: string, path: string, kind: FileChangeItem['changes'][number]['kind']): StructuredPatchHunk[] | undefined {
  let oldContent = '';
  if (kind !== 'add') {
    try {
      oldContent = execFileSync('git', ['show', `HEAD:${path}`], { cwd, encoding: 'utf8' });
    } catch {
      oldContent = '';
    }
  }
  let newContent = '';
  if (kind !== 'delete') {
    try {
      const abs = resolvePath(cwd, path);
      newContent = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    } catch {
      newContent = '';
    }
  }
  if (!oldContent && !newContent) return undefined;
  const patch = diffStructuredPatch(path, path, oldContent, newContent, undefined, undefined, { context: 3 });
  return patch.hunks.length ? patch.hunks : undefined;
}

/** A user message the SDK's streaming input accepts (mid-turn steering uses `priority:'now'`). */
function steerUserMessage(content: AgentMessage, priority?: 'now' | 'next' | 'later'): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  } as SDKUserMessage;
}

/**
 * `detectLongRunningCommand`/`renderSvcNudge`/`svcNudgeShouldFire`/`SVC_NUDGE_TEXT` moved to the `svc-nudge`
 * JIT rule (`prompt-kit/jit`, imported above) — the catalog owns the content now. Re-exported here so this
 * module's own callers/specs keep working unchanged.
 */
export { detectLongRunningCommand, svcNudgeShouldFire, SVC_NUDGE_TEXT };

/**
 * A hand-driven async-iterable the engine feeds the SDK in STREAMING-INPUT mode: `push` a message to
 * deliver it to the live turn, `end` to close input so the query completes. Mirrors the spike harness.
 */
function makeManualInput(): {
  stream: AsyncIterable<SDKUserMessage>;
  push: (m: SDKUserMessage) => void;
  end: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let resolveNext: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  let done = false;
  return {
    push(m) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: m, done: false });
      } else queue.push(m);
    },
    end() {
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as never, done: true });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (queue.length) return Promise.resolve({ value: queue.shift() as SDKUserMessage, done: false });
            if (done) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((res) => {
              resolveNext = res;
            });
          },
        };
      },
    },
  };
}

/**
 * After the model emits a `result` in streaming-input mode, wait this long for an in-flight steer to
 * arrive (Redis publish→subscribe latency) before closing the input and ending the turn. A no-steer turn
 * pays this as a small completion tail.
 */
const STEER_IDLE_GRACE_MS = 350;

/**
 * A streaming success `result` is TERMINAL — the model genuinely ended its turn — only when it carries
 * `terminal_reason:'completed'` (or, defensively for CLI drift, no `terminal_reason` and a natural
 * `stop_reason:'end_turn'`). The CLI also emits success results MID-turn when it PAUSES the loop for a
 * rate-limit / retry / budget interrupt (`terminal_reason` `'blocking_limit'`/`'rapid_refill_breaker'`/
 * `'background_requested'`/`'tool_deferred'`, or absent without an end_turn) — it will resume and may
 * still invoke host tools, so input must stay OPEN. Closing stdin under a still-active turn makes every
 * subsequent host-tool call throw a bare "Stream closed" (prod incident b30616d2). Verified against
 * sdk 0.3.201: a genuinely-completed turn — even one that calls a host tool mid-turn — emits exactly one
 * result with terminal_reason 'completed' + stop_reason 'end_turn', so gating here still ends normal turns.
 */
function isTurnGenuinelyDone(m: { terminal_reason?: string; stop_reason?: string | null }): boolean {
  if (m.terminal_reason === 'completed') return true;
  if (m.terminal_reason == null && m.stop_reason === 'end_turn') return true;
  return false;
}

// Claude's Options.effort has no 'minimal'; map it to the nearest ('low'). Others pass through.
export function toClaudeEffort(e?: ReasoningEffort): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!e) return undefined;
  return e === 'minimal' ? 'low' : e;
}
// Codex's effort has no 'max'; clamp to its ceiling ('xhigh'). Others pass through.
export function toCodexEffort(e?: ReasoningEffort): CodexReasoningEffort | undefined {
  if (!e) return undefined;
  return e === 'max' ? 'xhigh' : e;
}

/**
 * The Atlas v2 ENGINE CORE — the vendor logic for running ONE Claude/Codex turn, with **zero Nest and
 * zero @core dependencies**. It is the single implementation shared by two callers:
 *   - the in-process Nest `EngineRunner` (host-local execution), and
 *   - the in-container engine entrypoint (`image/engine-entrypoint.ts`), bundled into the sandbox
 *     image and invoked via `docker exec` — so a turn behaves IDENTICALLY on the host and in a sandbox.
 *
 * It does exactly four things: plan/review (read-only) vs execute (writes confined to the worktree);
 * thread the run's subscription secret (always subscription — no api_key path); pin an ISOLATED agent home (CLAUDE_CONFIG_DIR/CODEX_HOME,
 * never the personal one); return { result, sessionId?, planText?, usage? }. Env-derived knobs arrive as
 * an {@link EngineCoreConfig} (read from `EnvService` on the host, from `process.env` in the container).
 */

/** Env-derived configuration (the values the host reads from EnvService, the container from process.env). */
export interface EngineCoreConfig {
  /** Root for the isolated agent home (from AGENT_HOME_ROOT). */
  homeRoot?: string;
  /**
   * Root of the org-scoped skills store this run resolves a non-`managed` `RunEngineArgs.skills[].dirPath`
   * against (from `SKILLS_ROOT` — in-sandbox, always `CONTAINER_SKILLS_STORE`, set by
   * `redis-engine-runner.ts`'s exec env). Undefined (e.g. a bare unit test with no cfg) → the
   * skills-compose step skips every non-managed skill (still symlinks any `managed` one).
   */
  skillsRoot?: string;
  /**
   * Root of Atlas's own MANAGED (system-tier) STATIC skills a `managed: true` `RunEngineArgs.skills[].dirPath`
   * resolves against (from `SKILLS_MANAGED_ROOT` — in-sandbox, always `CONTAINER_SKILLS_MANAGED`, set by
   * `redis-engine-runner.ts`'s exec env). Undefined → the skills-compose step skips every managed skill.
   */
  managedSkillsRoot?: string;
  /**
   * Root of Atlas's own MANAGED (system-tier) GIT-SOURCED skills a `managedGit: true`
   * `RunEngineArgs.skills[].dirPath` resolves against (from `SKILLS_MANAGED_GIT_ROOT` — in-sandbox, always
   * `CONTAINER_SKILLS_MANAGED_GIT`, set by `redis-engine-runner.ts`'s exec env). Undefined → the
   * skills-compose step skips every git-managed skill.
   */
  managedGitSkillsRoot?: string;
}

/**
 * The agentic-engine model ids — CODE CONSTANTS, never env-configured (env vars are for per-environment
 * config; the model choice doesn't change across local/dev/staging/prod). A per-turn `args.model` still
 * overrides (e.g. the thread brain pins its own). The Claude id is the `'opus'` alias (auto-threads latest
 * Opus, like the brain); the Codex id is the Codex SDK's coding model.
 */
const DEFAULT_WORKER_MODEL = 'opus';
// NOTE: Codex runs subscription-only here — a ChatGPT-account OAuth token (see `resolveAuth`; there is no
// API-key path). A ChatGPT account REJECTS any explicit model with a 400 ("The '<model>' model is not
// supported when using Codex with a ChatGPT account"), including `gpt-5-codex` and `gpt-5`. So we do NOT
// pin a Codex model — we leave it unset and let the Codex SDK use the account's own default model.


/**
 * Whether a resumable Claude session transcript exists under this config dir. The SDK stores it at
 * `<configDir>/projects/<cwd-slug>/<sessionId>.jsonl`; we scan the project dirs rather than recompute
 * the slug. Passing `resume` for a session whose transcript ISN'T here makes the SDK end the turn with a
 * generic `error_during_execution` — so we check first and raise a specific error instead.
 */
export function claudeSessionExists(configDir: string, sessionId: string): boolean {
  const projects = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return false; // no projects dir yet → nothing to resume
  }
  return dirs.some((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
}

// Claude built-in tool sets. `tools` RESTRICTS the available set (unlike `allowedTools`, which only
// auto-approves).
// Web access: WebSearch runs server-side (no container egress needed); WebFetch runs client-side in
// the sandbox (the per-sandbox bridge network has NAT egress). Enabled on every turn so the engine can
// pull current docs / latest versions. This is a personal, trusted deployment — see `agents/web` notes.
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
// `Task` spawns a subagent — see SUBAGENTS below (read-only, Sonnet-pinned) for token-cheap exploration.
// The task tools (TaskCreate/TaskUpdate/TaskList/TaskGet — the SDK 0.3.x successors to the legacy
// TodoWrite) let the orchestrator maintain a LIVE task list as its visible decomposition; the navigator
// derives the per-thread checklist from these calls (see web `thread-todos.ts`). `tools` is an allowlist, so
// they must be named even though task-mode is default-on. They have no FS/git side effects.
const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
// Subagent-management tools (SDK 0.3.x). Once a subagent is spawned with a `name` it stays ADDRESSABLE, so
// the orchestrator's only recovery from a stall/failure is no longer a fresh `Task` that starts from zero:
//   • SendMessage({to}) — nudge/continue an existing agent WITH ITS ACCUMULATED CONTEXT INTACT (the whole
//     point: a stalled or transiently-failed subagent — e.g. an API 500 — is recovered by nudging, not by
//     throwing away everything it learned and respawning);
//   • TaskOutput({task_id}) — peek a running background agent without blocking;
//   • TaskStop({task_id}) — cleanly abandon a truly-wedged one before falling back to a respawn.
// `tools` is a RESTRICTING allowlist, so these must be named for the model to call them at all; auto-approved
// below so nudging/peeking/stopping never stalls on a permission prompt (like `Task` itself). Deliberately
// NOT given to REVIEW_TOOLS (a review turn shouldn't fan out) nor to the subagents' own `tools:` arrays
// (subagents don't recurse).
const SUBAGENT_MGMT_TOOLS = ['SendMessage', 'TaskOutput', 'TaskStop'];
// 'Skill' loads a discovered skill's body — read-only in itself (the SDK's `skills: 'all'` option auto-
// approves it into `allowedTools`, but `tools` below RESTRICTS the available set independent of that, so it
// must still be named here or the SDK's own enablement gets stripped).
const WORKER_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'Task', 'Skill', ...SUBAGENT_MGMT_TOOLS, ...TASK_TOOLS, ...WEB_TOOLS];
// A plan turn adds ExitPlanMode — native plan mode's turn-ender and the one place the FULL plan text
// reaches canUseTool headlessly (the CLI auto-writes the plan file, then calls ExitPlanMode with the
// plan in its input).
const PLAN_TOOLS = [...WORKER_TOOLS, 'ExitPlanMode'];
// A read-only review turn gets the read tools (+ web for verifying against current docs) + Skill. No Task —
// a review turn shouldn't fan out.
const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Skill', ...WEB_TOOLS];
// Auto-approve safe reads, web, and subagent spawning; writes/bash fall through to canUseTool where the
// boundary is re-applied.
const AUTO_APPROVE = [
  'Read', 'Glob', 'Grep', 'Task', ...SUBAGENT_MGMT_TOOLS, ...TASK_TOOLS, ...WEB_TOOLS,
];

// LSP navigation/rename (`atlas-lsp-ts`, registered per-turn — see sandbox/image/lsp-bridge-options.ts).
// Subagent `tools:` arrays are explicit, not inherited from the parent turn's `allowedTools`, so each
// subagent that should get these needs them listed here. Read-only investigators get navigation only
// (no `rename_symbol`); writers get the full set since they're the ones actually renaming things.
const LSP_NAV_TOOLS = qualifyLspToolNames(LSP_NAV_TOOL_NAMES);
const LSP_WRITE_TOOLS = qualifyLspToolNames(LSP_TOOL_NAMES);

// Subagent types the engine can spawn via `Task`. With `settingSources: []` there are NO on-disk agent
// definitions, so this map is the ONLY set of spawnable subagents — every subagent is Sonnet-pinned by
// construction (cheaper than the Opus brain). All are advisory: they investigate and report, and NONE
// can Write/Edit (only the calling turn changes files). `test` is the one exception to "read-only": it
// gets Bash so it can RUN the repo's verification, but it still cannot edit/commit. This keeps delegated
// work token-cheap and side-effect-free, while letting a worker push noisy test output off its context.
const SUBAGENTS: NonNullable<Options['agents']> = {
  explore: {
    description:
      'Read-only CODE explorer. Delegate investigation here — locating files, tracing how a ' +
      'feature works, mapping conventions — to keep the main context clean and save tokens. Returns a ' +
      'concise findings summary, not raw file dumps. Also handles the repo\'s OWN docs (CLAUDE.md, ' +
      'README, ARCHITECTURE.md, docs/). State the search breadth you want: "quick" (one targeted ' +
      'lookup), "medium" (moderate exploration), or "very thorough" (sweep multiple locations and ' +
      'naming conventions). For EXTERNAL library/framework/API documentation, use `docs` instead.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS, ...LSP_NAV_TOOLS],
    model: 'claude-sonnet-5',
    prompt: renderAgentPrompt(Agent.EXPLORE),
  },
  docs: {
    description:
      'External library/framework/API documentation researcher — answers "how do I use X" / "what\'s the ' +
      'current API for Y" from the LIBRARY\'S OWN docs on the web, not from this repo\'s source. Returns a ' +
      'synthesized, cited, version-aware answer. Use `explore` for how THIS codebase (and its own docs) ' +
      'work; use `docs` for third-party packages, frameworks, and external APIs.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS],
    model: 'claude-sonnet-5',
    prompt: renderAgentPrompt(Agent.DOCS),
  },
  review: {
    description:
      'Read-only code reviewer. Hand it a diff (or changed files) plus the intent, and it returns ' +
      'concrete findings — correctness bugs, behavior silently removed, convention/altitude drift, ' +
      'missing edge cases — grounded in the surrounding code. A cheap second pair of eyes before a step ' +
      'is called done. It reports; it does NOT fix.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS, ...LSP_NAV_TOOLS],
    model: 'claude-sonnet-5',
    prompt: renderAgentPrompt(Agent.REVIEW_AGENT),
  },
  debug: {
    description:
      'Read-only root-cause tracer. Give it a failure (error, stack trace, failing test, wrong ' +
      'behavior) and it traces the cause through the code and names the exact fix site and smallest fix ' +
      '— it does not run commands or change anything. Use `test` to actually run the verification.',
    tools: ['Read', 'Glob', 'Grep', ...WEB_TOOLS, ...LSP_NAV_TOOLS],
    model: 'claude-sonnet-5',
    prompt: renderAgentPrompt(Agent.DEBUG),
  },
  test: {
    description:
      "Runs the repository's verification (typecheck/build/lint/tests) in the worktree and returns a " +
      'DIAGNOSIS, not raw logs — pass/fail per command, and for failures the specific errors and likely ' +
      'cause. Keeps thousands of lines of test output out of your context. It can run commands (Bash) ' +
      'but does NOT edit files or change git state.',
    tools: ['Read', 'Glob', 'Grep', 'Bash', ...WEB_TOOLS],
    model: 'claude-sonnet-5',
    prompt: renderAgentPrompt(Agent.TEST),
  },
};

// WRITER subagents — the ONLY subagents that can change files. Added to the spawnable set ONLY on
// EXECUTE turns (see `run`), so an advisory plan/brain/review turn can NEVER fan out a file-mutating
// subagent. Confinement: their Write/Edit go through the SAME global `canUseTool` worktree boundary as
// the orchestrator's own writes; Bash is bounded by the per-thread Docker sandbox (the engine runs
// boxed). They have NO `Task` tool — writers cannot recursively fan out (no nesting blowup). The
// orchestrator owns the decomposition and runs writers ONE AT A TIME; file ownership between writers is
// by serialization, not a hard lock (see ORCHESTRATE_EXECUTE_SYSTEM in the driver).
const WRITER_TOOLS = [
  'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', ...WEB_TOOLS, ...LSP_WRITE_TOOLS,
];
const WRITER_SUBAGENTS: NonNullable<Options['agents']> = {
  implement: {
    description:
      'WRITER subagent (Sonnet) — your DEFAULT writer. Delegate a SUBSTANTIAL, long-running ' +
      'implementation slice here (a whole feature area, a multi-file change), NAMING the exact files ' +
      'it may touch. It edits the worktree and returns a tight summary of what it changed. Reach for ' +
      'it whenever the work is big enough that doing it inline would burn your context — that is the ' +
      'point of offloading it. Do NOT use it for small/quick edits (do those yourself). Run ONE writer ' +
      'at a time. For a genuinely hard, judgment-heavy slice where Sonnet-level coding is not enough, ' +
      'escalate to `implement-deep`.',
    tools: WRITER_TOOLS,
    model: 'claude-sonnet-5',
    prompt: renderAgentPrompt(Agent.FAN_OUT),
  },
  'implement-deep': {
    description:
      'ESCALATION WRITER subagent (Opus) — same contract as `implement`, reserved for the genuinely ' +
      'hard, judgment-heavy long-running slices (subtle design, tricky algorithms, dense cross-cutting ' +
      'refactors) where Sonnet-level coding is not enough. Use SPARINGLY — prefer `implement`. Same ' +
      'rules: it edits only the files you name and returns a tight summary; run one writer at a time.',
    tools: WRITER_TOOLS,
    model: 'opus',
    prompt: renderAgentPrompt(Agent.FAN_OUT),
  },
};

// VALIDATE subagent — build-time LIVE end-to-end validation + evidence capture. Added ONLY on EXECUTE
// turns (like the writers), so only the builder can spawn it. It gets `Bash` (to boot services via
// atlas-svc, curl endpoints, drive Playwright, run e2e) and `Write` (to author the `$ATLAS_EVIDENCE_DIR`
// evidence bundle + RESULTS.md — the `/context` mount is a writable root, see redis-engine-runner). It has
// NO `Task` (no recursive fan-out). Its "write only under $ATLAS_EVIDENCE_DIR, don't edit code" contract is
// prompt discipline (the `canUseTool` write boundary is per-turn, not per-subagent) — same model as `test`
// being "read-only by prompt". Distinct from `test`: `test` runs typecheck/build/unit → a diagnosis;
// `validate` boots the thing, exercises it live, and leaves durable proof the operator can see.
const VALIDATE_SUBAGENT: NonNullable<Options['agents']> = {
  validate: {
    description:
      'LIVE validation + evidence capture (Sonnet). Delegate END-TO-END validation here to keep your ' +
      'context clean: it BOOTS the change and exercises it as a real caller would (atlas-svc services, ' +
      'curl, Playwright UI drives, the repo\'s own e2e/smoke), then leaves the PROOF under ' +
      '`$ATLAS_EVIDENCE_DIR` (logs, screenshots, a `RESULTS.md` index) that renders in the operator\'s ' +
      'EVIDENCE panel. Returns a verdict + the observed behavior + the exact evidence paths it wrote — reference those instead of ' +
      'recapturing. Use `test` instead for a fast typecheck/build/unit diagnosis with no artifacts.',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write', ...WEB_TOOLS],
    model: 'claude-sonnet-5',
    prompt: renderAgentPrompt(Agent.VALIDATE),
  },
};

// PROTOTYPE subagent — planning/design-time mockup author. Like `validate` it writes ONLY into
// /context/artifacts (a static HTML preview), so it gets Write + Bash (Bash to run the target repo's
// design-system build and render/screenshot the mockup with on-demand Playwright for a fidelity self-check)
// but NO Edit/LSP (authors one new file, never edits source) and NO Task (no recursive fan-out). Merged on
// EXECUTE turns alongside the writers; the brain runs execute-mode, so it can spawn this at planning time.
const PROTOTYPE_SUBAGENT: NonNullable<Options['agents']> = {
  prototype: {
    description:
      'Design-fidelity PROTOTYPE subagent (Sonnet) — a lightweight in-house claude.ai/design. Delegate a UI ' +
      'MOCKUP here, NAMING the exact `/context/artifacts/<file>.html` for it to write. It DISCOVERS the app\'s ' +
      'real design system (tokens, theme, fonts, components) and reproduces it faithfully — no invented ' +
      'palette — then renders + screenshots the result to self-check before returning a tight summary (the ' +
      'artifact path + the design sources it grounded in). Prefer it over a generic writer for UI previews.',
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Write', ...WEB_TOOLS],
    model: 'claude-sonnet-5',
    prompt: renderAgentPrompt(Agent.PROTOTYPE),
  },
};

// The build-facing subagents whose persona must carry the repo's house-style envelope (the FAN_OUT writers
// + the REVIEW_AGENT) → the `Agent` their prompt is assembled from. The host bakes conventions into the
// MAIN-agent `systemPrompt` only; these subagent personas are built HERE from static prompts, so this map is
// the sole seam where the wire-forwarded `repoConventions` can reach them. Read-only advisory subagents
// (explore/docs/debug/test/validate) are intentionally absent — they aren't in the fragment's `usedBy`.
const CONVENTION_FACING_SUBAGENTS: Record<string, Agent> = {
  implement: Agent.FAN_OUT,
  'implement-deep': Agent.FAN_OUT,
  review: Agent.REVIEW_AGENT,
};

/**
 * Fold the repo's house-style envelope into the build-facing subagent prompts. When the turn carries no
 * attached profile (`repoConventions` absent/null) this returns the map UNCHANGED — byte-identical to today.
 * Otherwise it re-renders each convention-facing subagent's `prompt` WITH the conventions ctx (a subagent
 * not present in this turn's map — e.g. the writers on a non-execute turn — is simply skipped).
 */
export function applyConventionsToAgents(
  agents: NonNullable<Options['agents']>,
  repoConventions: RunEngineArgs['repoConventions'],
): NonNullable<Options['agents']> {
  if (!repoConventions) return agents;
  const ctx = { settings: { repoConventions } };
  const out = { ...agents };
  for (const [name, agent] of Object.entries(CONVENTION_FACING_SUBAGENTS)) {
    if (out[name]) out[name] = { ...out[name], prompt: renderAgentPrompt(agent, ctx) };
  }
  return out;
}

/**
 * Compose this turn's resolved skills into `<claudeConfigDir>/skills/` as write-through symlinks into the
 * central skills store — a `managed` skill from `managedSkillsRoot` (Atlas's own STATIC built-ins,
 * `CONTAINER_SKILLS_MANAGED`), a `managedGit` skill from `managedGitSkillsRoot` (Atlas's GIT-SOURCED
 * built-ins, synced by `ManagedSkillSyncService`, `CONTAINER_SKILLS_MANAGED_GIT`), every other skill from
 * `skillsRoot` (the org-scoped store, `CONTAINER_SKILLS_STORE`) — for the SDK to discover NATIVELY
 * (`settingSources: ['user']` + `skills: 'all'`, below) — no synthetic plugin. Idempotent wipe+rewrite
 * EVERY turn (the config dir is durable across turns, so a skill removed/disabled since last turn must not
 * linger — same discipline the old plugin-render step used). A skill whose source dir isn't actually on
 * disk under its root yet (e.g. its DB row exists but nothing installed/authored the files, OR a
 * `managedGit` entry `ManagedSkillSyncService` hasn't vendored yet) is skipped rather than left as a
 * dangling symlink. `SkillResolver` already resolved precedence (a workspace skill overrides a managed one
 * of the same name) into ONE entry per name, so this step never sees more than one root per entry — it
 * just symlinks whichever root each entry says.
 */
export function composeSkillsDir(
  claudeConfigDir: string,
  skills: RunEngineArgs['skills'],
  skillsRoot: string | undefined,
  managedSkillsRoot: string | undefined,
  managedGitSkillsRoot?: string,
): void {
  const skillsDir = join(claudeConfigDir, 'skills');
  rmSync(skillsDir, { recursive: true, force: true });
  if (!skills || skills.length === 0 || (!skillsRoot && !managedSkillsRoot && !managedGitSkillsRoot)) return;
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of skills) {
    // Defensive: skill names are validated kebab at authoring time, but never let one escape skillsDir.
    const safeName = skill.name.replace(/[^a-z0-9_-]/gi, '-') || 'skill';
    const root = skill.managedGit ? managedGitSkillsRoot : skill.managed ? managedSkillsRoot : skillsRoot;
    if (!root) continue;
    const source = join(root, skill.dirPath);
    if (!existsSync(source)) continue;
    symlinkSync(source, join(skillsDir, safeName), 'dir');
  }
}

/** Is `path` inside `root` (after resolution)? Confines writes to the worktree. */
function isInsideRoot(path: string, root: string): boolean {
  const r = resolvePath(root);
  const p = resolvePath(root, path);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

export class EngineCore {
  // One Codex client per (auth, sandbox) — each funds its own runs from its own home.
  private readonly codexClients = new Map<string, Codex>();

  // The SDK modules are injected (host + container share this class); env-derived knobs arrive as `cfg`.
  constructor(
    private readonly claudeSdk: typeof import('@anthropic-ai/claude-agent-sdk'),
    private readonly codexSdk: typeof import('@openai/codex-sdk'),
    private readonly cfg: EngineCoreConfig,
  ) {}

  private homeRoot(): string | undefined {
    return this.cfg.homeRoot;
  }

  private skillsRoot(): string | undefined {
    return this.cfg.skillsRoot;
  }

  private managedSkillsRoot(): string | undefined {
    return this.cfg.managedSkillsRoot;
  }

  private managedGitSkillsRoot(): string | undefined {
    return this.cfg.managedGitSkillsRoot;
  }

  /**
   * Resolve the run's subscription secret: the host-resolved per-org secret MUST arrive as `args.auth`.
   * There is NO env/config fallback and NO api_key path — a missing secret THROWS so the turn fails
   * loudly instead of silently billing the API or borrowing an ambient credential.
   */
  private resolveAuth(engine: 'claude' | 'codex', explicit: EngineAuth | undefined): EngineAuth {
    if (explicit) return explicit;
    // Classify as an auth halt (marker → clean, resumable credentials halt at the driver) rather than a
    // plain Error that fails the job opaquely: a missing credential is fixable by connecting an account.
    throw new EngineAuthError(
      `${NO_ENGINE_CREDENTIAL_MARKER}: no ${engine} subscription secret — the org has no ${engine} ` +
        'credential set (connect one in Settings).',
      undefined,
      engine,
    );
  }

  async run(args: RunEngineArgs): Promise<EngineRunResult> {
    return this.stampUsageProvenance(
      await (args.engine === 'codex' ? this.runCodex(args) : this.runClaude(args)),
      args,
    );
  }

  /**
   * Stamp display-only provenance the engine paths don't carry themselves onto the returned usage: the
   * `engine` that ran (so a Codex turn with no `model` still labels as "Codex") and the `reasoningEffort`
   * the run was given (engine-agnostic — Codex AND Claude, never surfaced by either SDK's result). Applied
   * at BOTH dispatch wrappers (`run` / `runWithExtras`) so every engine turn — build, Codex review, autofix —
   * is covered without touching `runClaude`/`runCodex` internals or any transcript `metaTag` call site.
   * `??=` so a path that ever populates these itself wins. No-op when the run produced no usage.
   */
  private stampUsageProvenance(res: EngineRunResult, args: RunEngineArgs): EngineRunResult {
    if (res.usage) {
      res.usage.engine ??= args.engine;
      if (args.modelReasoningEffort) res.usage.reasoningEffort ??= args.modelReasoningEffort;
    }
    return res;
  }

  /**
   * Like `run`, but passes extra Claude SDK options (e.g. `mcpServers` for the tool bridge) plus the
   * bridge's MCP tool names. Used by the in-container entrypoint when the tool-bridge is active; the
   * host `EngineRunner` calls the plain `run` path (the bridge is wired host-side there).
   *
   * `extraClaudeOptions` is spread verbatim into the SDK `Options` — pass `{ mcpServers }`, NOT the
   * raw server map, or the server lands as a stray top-level key and never registers.
   * `bridgeToolNames` are the qualified `mcp__<server>__<tool>` names to auto-approve (Claude only).
   * `codexBridgeTools` are the BARE host tool names for a Codex execute turn — routed into `runCodex`,
   * which renders them as an `[mcp_servers.atlasbridge]` config.toml block (the Codex tool bridge).
   */
  async runWithExtras(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
    bridgeToolNames?: string[],
    codexBridgeTools?: string[],
    codexExtraMcpServers?: CodexExtraMcpServers,
  ): Promise<EngineRunResult> {
    return this.stampUsageProvenance(
      await (args.engine === 'codex'
        ? this.runCodex(args, codexBridgeTools, codexExtraMcpServers)
        : this.runClaude(args, extraClaudeOptions, bridgeToolNames)),
      args,
    );
  }

  // ── Claude ────────────────────────────────────────────────────────────────────────────────────

  private async runClaude(
    args: RunEngineArgs,
    extraClaudeOptions?: Record<string, unknown>,
    bridgeToolNames?: string[],
  ): Promise<EngineRunResult> {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, mode, onEvent, signal, richStream, steerInput, rotationNudge } =
      args;

    const abortController = new AbortController();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    // STREAMING-INPUT mode (the steerable brain turn): feed the SDK a live async-iterable that yields the
    // initial task, then drains `steerInput` (operator steers) with `priority:'now'`. The turn ends when the
    // model emits a `result` and no steer arrives within a short grace. Non-steerable turns keep the plain
    // string prompt (single-message mode) — zero behavior change for build/plan/review workers.
    const streaming = !!steerInput;
    const input = streaming ? makeManualInput() : undefined;
    let turnEnded = false;
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    const STREAM_CLOSED_THRESHOLD = Number(process.env.ENGINE_STREAM_CLOSED_THRESHOLD) > 0
      ? Number(process.env.ENGINE_STREAM_CLOSED_THRESHOLD) : 3;   // consecutive control-channel failures ⇒ breaker trips
    let streamClosedRun = 0;      // consecutive "Stream closed" tool_results in the live run (any healthy result resets)
    let streamClosedTotal = 0;    // per-turn total (instrumentation)
    let streamClosedTripped = false;   // latched right before the breaker throw so the catch never swallows it as a cooperative abort
    const cancelEnd = (): void => {
      if (endTimer) {
        clearTimeout(endTimer);
        endTimer = undefined;
      }
    };
    const scheduleEnd = (): void => {
      if (!input) return;
      cancelEnd();
      endTimer = setTimeout(() => input.end(), STEER_IDLE_GRACE_MS);
    };
    // BACKGROUND-TASK HOLD (SDK `run_in_background` Bash + backgrounded Task subagents): a tool-native
    // background task closes the turn's first `result` immediately (terminal_reason=completed), which would
    // let the STEER_IDLE_GRACE close the input while work is still in flight. Instead we hold the query()
    // session open so the task's `task_notification` AND the model's auto-continuation land in THIS turn.
    // A background SUBAGENT runs UNCAPPED — held open with NO timer (it may run for hours; bounded only by
    // the outer PHASE_TIMEOUT / an operator Stop). A bare background Bash shell that exceeds HOLD_CAP_MS gets
    // an ADVISORY nudge (the `bg-task-cap` rule's notice) and the model's NEXT natural result ends the turn —
    // nothing is ever killed, and the stream is NEVER severed by the cap. Closing stdin under a still-active
    // turn makes every subsequent host-tool call throw a bare "Stream closed" (prod incident b30616d2), so the
    // cap never does it. HOLD_CAP_MS is read LIVE from the JIT catalog each run (so a spec can mutate the rule).
    const HOLD_CAP_MS = bgTaskCapRule.trigger.kind === 'hold-timer' ? bgTaskCapRule.trigger.holdMs : BG_TASK_HOLD_CAP_MS;
    const liveBgTasks = new Set<string>();
    const liveSubagentTasks = new Set<string>();   // task_ids whose task_started carried subagent_type (a Task subagent, not a bare bg Bash)
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let capping = false;
    const clearHold = (): void => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = undefined;
      }
    };
    // Cap fired (bare bg Bash only): warn the agent IN-TURN (mirrors injectRotationNudge) and stop the loop
    // from cancelling closes (`capping`) so the model's next natural result ends the turn. Advisory-only —
    // the stream is never severed and no task is killed.
    const onCap = (): void => {
      if (!input || turnEnded || capping) return;
      if (liveSubagentTasks.size > 0) return;   // safety: never cap while a subagent is live
      capping = true;                           // the model's NEXT natural result ends the turn (no forced kill)
      onEvent?.({ kind: 'bg_task', status: 'capped', detail: `background Bash task exceeded ${HOLD_CAP_MS}ms (advisory; stream NOT closed)` });
      cancelEnd();
      if (bgTaskCapRule.enabled) input.push(steerUserMessage(bgTaskCapRule.render({}), 'now'));
      // NO capKillTimer / NO input.end() — the cap is purely advisory; stdin is never severed.
    };
    const armHoldTimer = (): void => {
      clearHold();
      holdTimer = setTimeout(onCap, HOLD_CAP_MS);
    };
    const resetHoldTimer = (): void => {
      if (liveBgTasks.size > 0 && liveSubagentTasks.size === 0) armHoldTimer();
      else clearHold();
    };
    const steerIter = streaming ? steerInput![Symbol.asyncIterator]() : undefined;
    // A priority:'now' steer pushed BEFORE the model commits its first assistant message makes the SDK
    // abort the whole turn (result_type=user, terminal_reason=aborted_streaming, subtype=error_during_
    // execution) — the startup-race red box. So a steer that arrives while the turn is still spinning up is
    // HELD in `steerBuffer` and flushed the instant the first `assistant` message lands (`streamingStarted`),
    // at which point a mid-turn steer injects cleanly (subtype=success, steer honored). Verified by spike.
    let streamingStarted = false;
    const steerBuffer: Array<{ id?: string; text: string }> = [];
    let flushSteerBuffer = (): void => {}; // real impl set below when streaming; no-op for worker turns
    // ENGINE-LOCAL Leg-rotation nudge (see RunEngineArgs.rotationNudge): latch SOFT then a REMINDER on each
    // further +delta as this turn's own main-agent occupancy fills, injecting the nudge straight into the live
    // input. Race-free by design — it fires mid-stream (input open), never over the host→Redis path that raced
    // the post-result close. `firedNudgeLevel` is the highest delta-band injected (-1 before soft; 0 = soft).
    let firedNudgeLevel = -1;
    let injectRotationNudge = (_text: AgentMessage): void => {}; // real impl set below when streaming
    // ENGINE-LOCAL atlas-svc nudge throttle (see the PostToolUse hook below): the context-token occupancy at
    // which we last nudged Atlas to wrap a long-running command in `atlas-svc`. null = never nudged (first
    // matching command always fires); then at most once per `svcNudgeDeltaTokens` of context growth. Per-turn
    // scope like `firedNudgeLevel` — a relapse in a fresh turn re-arms the first-hit fire.
    let lastSvcNudgeTokens: number | null = null;
    if (input) {
      input.push(steerUserMessage(task));
      // Drain operator steers into the live turn until the turn ends. Each steer carries its stimulus `id`;
      // we push it into the session with priority:'now', then emit an `input_ack` echoing the id — the
      // durable proof the message was TAKEN (the host stamps delivered_at only on this ack, never on the
      // stream write). A redelivered id (a lost ack re-driven by the delivery pump) is a NO-OP push
      // (exactly-once injection) but STILL re-emits its ack so delivery converges. A steer held pre-stream
      // is NOT acked until it is actually injected (on flush), so a turn that dies before first content
      // leaves the message pending (delivered_at null) for the sweep — no acked-but-dropped message.
      const injectedSteerIds = new Set<string>();
      const bufferedIds = new Set<string>();
      const injectSteer = (id: string | undefined, text: AgentMessage): void => {
        cancelEnd(); // a steer is in flight to the model — don't close input under it
        input.push(steerUserMessage(text, 'now'));
        if (typeof id === 'string') {
          injectedSteerIds.add(id);
          onEvent?.({ kind: 'input_ack', id });
        }
      };
      flushSteerBuffer = (): void => {
        while (steerBuffer.length) {
          const s = steerBuffer.shift()!;
          injectSteer(s.id, fromExternal(s.text));
        }
      };
      // The rotation nudge rides the SAME injection as an operator steer (priority:'now', cancels any pending
      // close) — but carries no stimulus id, so it emits no `input_ack` (nothing durable to converge on).
      injectRotationNudge = (text: AgentMessage): void => {
        cancelEnd();
        input.push(steerUserMessage(text, 'now'));
      };
      void (async () => {
        try {
          while (!turnEnded && steerIter) {
            const { value, done } = await steerIter.next();
            if (done || turnEnded) break;
            const text = value?.text;
            if (typeof text !== 'string' || text.length === 0) continue;
            const id = value?.id;
            if (typeof id === 'string' && injectedSteerIds.has(id)) {
              // Re-delivered after a lost ack — re-emit the ack so delivery converges; never re-push.
              onEvent?.({ kind: 'input_ack', id });
              continue;
            }
            if (typeof id === 'string' && bufferedIds.has(id)) continue; // already held (not yet taken → no ack)
            if (!streamingStarted) {
              steerBuffer.push({ id, text }); // HOLD until first assistant message (see note above)
              if (typeof id === 'string') bufferedIds.add(id);
              continue;
            }
            injectSteer(id, fromExternal(text));
          }
        } catch {
          /* steer source closed — the turn's own lifecycle ends it */
        }
      })();
    }

    const auth = this.resolveAuth('claude', args.auth);
    const model = args.model ?? DEFAULT_WORKER_MODEL;

    // Pin the SDK subprocess to Atlas's ISOLATED config/state home — never ~/.claude.
    const claudeConfigDir = atlasEngineHomeDir(this.homeRoot(), 'claude', sandboxKey);

    // A stored sessionId whose transcript isn't in THIS config dir can't be resumed — the SDK would end
    // the turn with an opaque `error_during_execution`. Detect it up front and fail with a SPECIFIC,
    // actionable error (retrying is futile; the thread must be recreated). See UNRESUMABLE_SESSION_MARKER.
    if (sessionId && !claudeSessionExists(claudeConfigDir, sessionId)) {
      throw new Error(
        `${UNRESUMABLE_SESSION_MARKER}: engine session ${sessionId} not found under ${claudeConfigDir} — cannot resume`,
      );
    }

    const planMode = mode === 'plan';
    const readOnly = mode !== 'execute';

    let capturedPlan = '';
    const subprocessEnv: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      // Let the SDK ride out retryable API errors (overloaded/5xx/gateway/rate-limit) natively with its own
      // exponential backoff instead of failing the turn on the first occurrence; its `api_retry` frames are
      // surfaced below to drive the live "Reconnecting…" indicator. Env-overridable for tuning/tests.
      CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES ?? '10',
    };
    getEngineAuthAdapter('claude').materialize({
      homeRoot: this.homeRoot(),
      key: sandboxKey,
      secret: auth.secret,
      kind: auth.kind,
      env: subprocessEnv,
    });

    // Capture the CLI subprocess's stderr (the real API/transport error text) into a bounded ring
    // buffer so a non-success result can surface it — the SDK otherwise flattens it into `subtype`.
    const stderrTail: string[] = [];
    const captureStderr = (data: string) => {
      stderrTail.push(data);
      if (stderrTail.length > 40) stderrTail.shift(); // keep the last ~40 chunks
    };

    // This repo's skills (resolved host-side, dir paths + names only — no bodies) composed into
    // `<claudeConfigDir>/skills/` as write-through symlinks into the central skills store, for the SDK to
    // discover NATIVELY (settingSources 'user' + skills 'all' below). Re-composed every turn (wipes a
    // removed/disabled skill); a no-op wipe when the turn carries none.
    composeSkillsDir(
      claudeConfigDir,
      args.skills,
      this.skillsRoot(),
      this.managedSkillsRoot(),
      this.managedGitSkillsRoot(),
    );

    // atlas-svc nudge (PostToolUse hook, added to `options` below): enabled + throttle window sourced from the
    // `svc-nudge` JIT rule. Reads the live `contextTokens` (declared after `options`; the hook only fires
    // during the query loop, after it is initialized) and the per-turn `lastSvcNudgeTokens`.
    const svcNudgeEnabled = svcNudgeRule.enabled;
    const svcNudgeDeltaTokens = svcNudgeRule.throttle!.deltaTokens;

    const claudeEffort = toClaudeEffort(args.modelReasoningEffort);

    const options: Options = {
      cwd,
      systemPrompt,
      // 'user' loads ONLY <CLAUDE_CONFIG_DIR>/settings.json (missing → no-op) and NEVER CLAUDE.md (the SDK
      // requires 'project' for that) — so nothing from the untrusted worktree's own `.claude/` leaks in. The
      // ONLY thing Atlas itself ever places under CLAUDE_CONFIG_DIR is the `skills/` dir composed above; no
      // settings.json/CLAUDE.md/agents/commands are ever written there (verified clean at P0/P1 spike time).
      settingSources: ['user'],
      // Turns skills on for the whole resolved set — the single place the SDK needs (auto-enables the Skill
      // tool; no plugins key, no manual 'Skill' in allowedTools). See WORKER_TOOLS/REVIEW_TOOLS below for
      // why 'Skill' is still added to the `tools` ALLOWLIST (that list restricts, independent of this).
      skills: 'all',
      tools: planMode ? PLAN_TOOLS : readOnly ? REVIEW_TOOLS : WORKER_TOOLS,
      // Programmatic subagent definitions — the only spawnable Task subagents. `settingSources: ['user']`
      // never reads a project-scope `.claude/agents/` (excluded from the allowed sources), and Atlas's own
      // CLAUDE_CONFIG_DIR never has a user-scope `agents/` dir either, so these always win by simple absence.
      // Advisory subagents (read-only, Sonnet) are always available; the WRITER subagents
      // (implement/implement-deep), the build-time VALIDATE subagent, and the design-fidelity PROTOTYPE
      // subagent are added ONLY on EXECUTE turns, so a plan/brain/review turn can never fan out a
      // file-mutating or evidence-writing subagent. See
      // SUBAGENTS / WRITER_SUBAGENTS / VALIDATE_SUBAGENT / PROTOTYPE_SUBAGENT.
      agents: applyConventionsToAgents(
        mode === 'execute'
          ? { ...SUBAGENTS, ...WRITER_SUBAGENTS, ...VALIDATE_SUBAGENT, ...PROTOTYPE_SUBAGENT }
          : SUBAGENTS,
        args.repoConventions,
      ),
      // Host-side tools reach the in-sandbox session as an MCP server (the tool bridge). Surface
      // their qualified names (`mcp__<server>__<tool>`) in allowedTools so they're auto-approved —
      // they're host-controlled, never a human prompt. Empty for non-bridge turns (workers).
      allowedTools: [...AUTO_APPROVE, ...(bridgeToolNames ?? [])],
      canUseTool: makeCanUseTool(
        readOnly,
        [cwd, ...(args.writableRoots ?? [])],
        (plan) => {
          capturedPlan = plan;
        },
        {
          composedSkillsDir: join(claudeConfigDir, 'skills'),
          skillsStoreRoot: this.skillsRoot(),
          skills: args.skills,
          granted: new Set(args.grantedSkills ?? []),
        },
      ),
      permissionMode: planMode ? 'plan' : 'default',
      // Suppress the SDK's default "Co-Authored-By: Claude" attribution.
      settings: { attribution: { commit: '', pr: '' } },
      abortController,
      env: subprocessEnv,
      // The SDK routes the Claude Code subprocess's stderr here (the real API/transport error the
      // `error_during_execution` subtype otherwise hides). Unconditional: worker turns fail too.
      stderr: captureStderr,
      ...(sessionId ? { resume: sessionId } : {}),
      ...(model ? { model } : {}),
      ...(claudeEffort ? { effort: claudeEffort } : {}),
      // Enable the 1M-token context window explicitly. Opus 4.x and Sonnet 5 negotiate it automatically, but
      // we pass the beta as belt-and-suspenders so a builder session that fills past 200k does NOT truncate —
      // Leg rotation's HARD threshold (200k) depends on there being headroom ABOVE it to author the handoff
      // (see the context-rot plan). The SDK forwards `anthropic-beta: context-1m-2025-08-07`.
      betas: ['context-1m-2025-08-07'],
      // atlas-svc nudge: when Atlas runs a Bash command that smells long-running (dev server / `docker
      // compose up` / watcher / bare-backgrounded), append a reminder to that command's result pointing it at
      // the `atlas-svc` supervisor. Uses PostToolUse `additionalContext` (a free-form string yielded to the
      // model after the tool result — verified against the shipped CLI; `updatedToolOutput` is shape-validated
      // against Bash's output and would error). Throttled by context-token growth so back-to-back commands
      // don't spam. Fires post-execution and only ATTACHES context — never alters the command or its output.
      ...(svcNudgeEnabled
        ? {
            hooks: {
              PostToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [
                    async (input) => {
                      const inp = input as { tool_name?: string; tool_input?: { command?: unknown } };
                      if (inp.tool_name !== 'Bash') return {};
                      const cmd = typeof inp.tool_input?.command === 'string' ? inp.tool_input.command : '';
                      if (svcNudgeRule.trigger.kind !== 'tool-match' || !svcNudgeRule.trigger.match(cmd)) return {};
                      const now = contextTokens ?? 0;
                      // First matching command always fires; then at most once per delta of context growth.
                      if (!svcNudgeShouldFire(lastSvcNudgeTokens, now, svcNudgeDeltaTokens)) return {};
                      lastSvcNudgeTokens = now;
                      return {
                        hookSpecificOutput: {
                          hookEventName: 'PostToolUse' as const,
                          additionalContext: svcNudgeRule.render({ command: cmd }),
                        },
                      };
                    },
                  ],
                },
              ],
            },
          }
        : {}),
      // Rich streaming (the thread brain): partial-message stream → token-level deltas, and extended
      // thinking → thinking blocks. Adaptive lets Claude decide thinking depth per turn.
      // forwardSubagentText: forward a subagent's FULL text+thinking (not just its tool calls) tagged with
      // `parent_tool_use_id`, so the brain turn can render each subagent run as its own nested transcript.
      ...(richStream
        ? {
            includePartialMessages: true,
            // `display: 'summarized'` is load-bearing: without it the adaptive default is `omitted`, which
            // streams thinking blocks with EMPTY text — the `&& block.thinking` guards below then drop them,
            // so nothing is ever emitted or persisted. Summarized surfaces the reasoning for debugging.
            thinking: { type: 'adaptive' as const, display: 'summarized' as const },
            forwardSubagentText: true,
          }
        : {}),
      // R1 tool-bridge: optional extra options (e.g. mcpServers) from the in-container entrypoint.
      ...(extraClaudeOptions ?? {}),
    } as Options;

    let result = '';
    let resolvedSession = sessionId;
    let usage: EngineUsage | undefined;
    // Live context-window occupancy (distinct from the cumulative billing total): each `assistant`
    // message is ONE model round-trip whose own `usage` reports the input size of THAT call (fresh +
    // cache read + cache creation) — the real context size at that moment. We keep the MAIN agent's
    // LAST round-trip (turn-end occupancy) + its model. Subagent messages (parent_tool_use_id set) run
    // in their OWN context on cheaper models, so they're excluded.
    let contextTokens: number | undefined;
    let contextModel: string | undefined;
    // Set the instant we detect a Claude subscription session/usage-limit wall (structured
    // `rate_limit_event` status:'rejected', or the printed-line fallback). Its presence flips the turn from
    // "hold input open + resume" to "end CLEANLY" so we never auto-resume straight back into the wall.
    let sessionLimit: SessionLimitHit | undefined;
    try {
      for await (const message of this.claudeSdk.query({
        prompt: streaming ? input!.stream : task,
        options,
      })) {
        // Model is actively producing (or a steer is being processed) → don't close input under it. Once
        // `capping` latches, a late task_progress/task_updated frame must NOT undo the forced close.
        if (streaming && !capping && message.type !== 'result') cancelEnd();
        if (message.type === 'system' && message.subtype === 'init') {
          resolvedSession = message.session_id;
          // Surface the resume handle the instant the session exists, so a mid-turn halt is recoverable.
          if (resolvedSession) onEvent?.({ kind: 'session', sessionId: resolvedSession });
        } else if (message.type === 'system' && message.subtype === 'task_started') {
          // An SDK run_in_background Bash task began — track it so the turn holds its input open until the
          // task settles (its `task_notification`) instead of closing on the immediate first `result`. A Task
          // SUBAGENT's task_started carries `subagent_type` (task_type "local_agent"); a bare bg Bash does not
          // (task_type "local_bash") — a live subagent runs uncapped, so track it separately.
          if (message.task_id) {
            liveBgTasks.add(message.task_id);
            if ((message as { subagent_type?: string }).subagent_type) liveSubagentTasks.add(message.task_id);
          }
          onEvent?.({
            kind: 'bg_task',
            taskId: message.task_id,
            status: 'started',
            detail: message.description,
            taskType: message.task_type,
            // The spawning Task tool_use id, present for a backgrounded Task subagent — lets the web tie this
            // to the subagent's card (its child blocks' `parentToolUseId`).
            ...(message.tool_use_id
              ? { parentToolUseId: message.tool_use_id }
              : {}),
          });
        } else if (message.type === 'system' && message.subtype === 'task_notification') {
          // The task settled (completed/failed/stopped). Drop it from the live set; a settlement +
          // auto-continuation is imminent, so restart the hold window (or clear it if none remain).
          if (message.task_id) {
            liveBgTasks.delete(message.task_id);
            liveSubagentTasks.delete(message.task_id);
          }
          onEvent?.({
            kind: 'bg_task',
            taskId: message.task_id,
            status: message.status,
            detail: message.summary,
            // Settlement of a backgrounded Task subagent — carry the spawning Task id so the web marks that
            // subagent's card settled (its anchor `tool_result` was only the immediate launch ack).
            ...(message.tool_use_id
              ? { parentToolUseId: message.tool_use_id }
              : {}),
          });
          resetHoldTimer();
        } else if (message.type === 'system' && message.subtype === 'api_retry') {
          // The SDK hit a retryable API error (overloaded/5xx/gateway/rate-limit) and is retrying NATIVELY
          // with its own backoff — surface it (we do NOT host-retry these) so the live indicator can show the
          // SDK's own countdown. Mid-turn: no turn end, the turn continues once a retry succeeds.
          onEvent?.({
            kind: 'api_retry',
            attempt: message.attempt,
            maxRetries: message.max_retries,
            retryDelayMs: message.retry_delay_ms,
            errorStatus: message.error_status ?? null,
            reason: String(message.error),
          });
        } else if (message.type === 'rate_limit_event') {
          // Harvest the subscription window state ALWAYS (the host updates its per-org usage snapshot from
          // every frame, not just the wall). A `rejected` frame is the HARD limit — latch it so the result
          // frame below ends the turn cleanly instead of holding input open to resume into the wall.
          const info = message.rate_limit_info;
          onEvent?.({
            kind: 'rate_limit',
            status: info.status,
            ...(info.resetsAt != null ? { resetsAt: info.resetsAt } : {}),
            ...(info.rateLimitType ? { rateLimitType: info.rateLimitType } : {}),
            ...(info.utilization != null ? { utilization: info.utilization } : {}),
          });
          const hit = limitFromRateEvent(info);
          if (hit) sessionLimit = hit;
        } else if (richStream && message.type === 'stream_event') {
          // LIVE token-by-token deltas (partial-message stream). Authoritative full blocks still arrive
          // on the `assistant` message below — these are for live rendering only, not persistence. Carry
          // the subagent parent id (same as the authoritative blocks) so live nested rendering matches.
          const sev = message as {
            parent_tool_use_id?: string | null;
            event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
          };
          const parent = sev.parent_tool_use_id ?? undefined;
          const sub = parent ? { parentToolUseId: parent } : {};
          const ev = sev.event;
          if (ev?.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta' && ev.delta.text)
              onEvent?.({ kind: 'text_delta', text: ev.delta.text, ...sub });
            else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking)
              onEvent?.({ kind: 'thinking_delta', text: ev.delta.thinking, ...sub });
          }
        } else if (message.type === 'assistant') {
          // First committed assistant message ⇒ the turn is genuinely streaming: a held steer can now inject
          // with priority:'now' without aborting the turn. Flush the pre-stream hold buffer (no-op after the
          // first message / for turns that never held anything). Must be an `assistant` message, NOT a
          // stream_event content delta — flushing on a partial delta still aborts (verified by spike).
          if (!streamingStarted) {
            streamingStarted = true;
            flushSteerBuffer();
          }
          // `parent_tool_use_id` is UNSET for the brain's own blocks, SET to the spawning Task id for a
          // subagent's blocks (forwardSubagentText forwards subagent text/thinking the same way).
          const parent = message.parent_tool_use_id ?? undefined;
          const sub = parent ? { parentToolUseId: parent } : {};
          // Context occupancy: only the MAIN agent's round-trips (parent unset). This message's OWN
          // usage is the single-call input size (NOT the cumulative turn total) — keep the latest as
          // the turn-end occupancy, with the call's model so the ring resolves the right window.
          if (!parent) {
            const amsg = (message as { message?: { model?: string; usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            } } }).message;
            const cu = amsg?.usage;
            if (cu) {
              contextTokens =
                (cu.input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0);
              if (amsg?.model) contextModel = amsg.model;
              // Emit the occupancy LIVE so the composer ring fills mid-turn (a turn can run for minutes). Fires
              // once per main-agent round-trip; the turn-end `turn_meta` remains the durable authority.
              onEvent?.({
                kind: 'usage',
                contextTokens,
                ...(contextModel ? { contextModel } : {}),
                contextLimit: resolveContextLimit(contextModel),
              });
              // ENGINE-LOCAL Leg-rotation nudge: this main-agent round-trip's occupancy is the freshest signal,
              // and we're mid-stream (input open, streamingStarted true) — the SAFE moment to steer, so the nudge
              // lands like a manual steer instead of racing the post-`result` close. Level-latch (parity with the
              // driver's LegRotationWatch): the FIRST crossing injects the SOFT nudge; each further +delta band
              // injects the REMINDER. Fires the highest band crossed, each band at most once. No hard stop.
              // Enablement + thresholds + payload text come per-turn from `rotationNudge` (RunEngineArgs, seeded
              // by the driver from `ROTATION_SOFT_NUDGE`/`ROTATION_REMINDER_NUDGE`). The `leg-rotation` JIT rule
              // is the catalog SOURCE of those thresholds (see `resolveRotationThresholds`) and mirrors the same
              // payload text — kept as the injectable per-turn field so a caller can distinguish the phases.
              if (rotationNudge && legRotationRule.enabled && contextTokens >= rotationNudge.softTokens) {
                const level = Math.floor(
                  (contextTokens - rotationNudge.softTokens) / rotationNudge.reminderDeltaTokens,
                );
                if (level > firedNudgeLevel) {
                  const isFirst = firedNudgeLevel < 0;
                  firedNudgeLevel = level;
                  injectRotationNudge(isFirst ? rotationNudge.softText : rotationNudge.reminderText);
                }
              }
            }
          } else {
            // SUBAGENT round-trip (parent set): emit ITS OWN occupancy tagged with the spawning Task id, so
            // the subagent card renders its own context ring + real model. Kept strictly separate from the
            // main-agent `contextTokens`/`contextModel` above — a subagent must NEVER overwrite the
            // orchestrator's ring or the turn's `usage.contextModel`. Live-only, like the main-agent emit.
            const samsg = (message as { message?: { model?: string; usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            } } }).message;
            const scu = samsg?.usage;
            if (scu) {
              const subTokens =
                (scu.input_tokens ?? 0) + (scu.cache_read_input_tokens ?? 0) + (scu.cache_creation_input_tokens ?? 0);
              const subModel = samsg?.model;
              onEvent?.({
                kind: 'usage',
                parentToolUseId: parent,
                contextTokens: subTokens,
                ...(subModel ? { contextModel: subModel } : {}),
                contextLimit: resolveContextLimit(subModel),
              });
            }
          }
          for (const block of message.message.content as Array<{
            type: string;
            id?: string;
            text?: string;
            name?: string;
            input?: unknown;
            thinking?: string;
          }>) {
            if (block.type === 'text' && block.text) {
              // Suppress the printed limit line at the source (kills the bare/doubled limit line). If the
              // structured frame hasn't already latched the hit, latch it here from the text.
              const isLimitLine = detectSessionLimitText(block.text);
              if (isLimitLine) {
                if (!sessionLimit) sessionLimit = { resetAt: parseResetAt(block.text) };
              } else {
                onEvent?.({ kind: 'text', text: block.text, ...sub });
              }
            } else if (block.type === 'thinking' && block.thinking) {
              if (richStream) onEvent?.({ kind: 'thinking', text: block.thinking, ...sub });
            } else if (block.type === 'tool_use' && block.name) {
              // Rich turns get the full tool call (id + input) so the UI can render it; coarse turns keep
              // the legacy name-only `tool` event.
              if (richStream)
                onEvent?.({ kind: 'tool_use', id: block.id ?? '', name: block.name, input: block.input, ...sub });
              else onEvent?.({ kind: 'tool', name: block.name });
            }
          }
        } else if (richStream && message.type === 'user') {
          // Tool results are fed back to the model as a `user` message — surface them so the UI can pair
          // each result with its `tool_use` by id. A subagent's tool results carry the same parent id.
          const userMsg = message as {
            parent_tool_use_id?: string | null;
            message?: { content?: unknown };
            tool_use_result?: unknown;
          };
          const parent = userMsg.parent_tool_use_id ?? undefined;
          const sub = parent ? { parentToolUseId: parent } : {};
          // Edit/MultiEdit results carry a `structuredPatch` (real file line offsets) on the message's
          // `tool_use_result` — forward it so the web diff gutter shows true line numbers, not 1-based.
          const patch = extractStructuredPatch(userMsg.tool_use_result);
          const content = userMsg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content as Array<{
              type: string;
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
            }>) {
              if (block.type === 'tool_result') {
                const isStreamClosed = block.is_error === true && containsStreamClosed(block.content);
                streamClosedRun = isStreamClosed ? streamClosedRun + 1 : 0;   // any healthy result resets the run
                if (isStreamClosed) streamClosedTotal++;
                onEvent?.({
                  kind: 'tool_result',
                  id: block.tool_use_id ?? '',
                  result: block.content,
                  isError: block.is_error,
                  ...(patch ? { structuredPatch: patch } : {}),
                  ...sub,
                });
                if (streamClosedRun >= STREAM_CLOSED_THRESHOLD) {
                  streamClosedTripped = true;
                  abortController.abort();   // stop the orphaned CLI child
                  throw new Error('engine stream closed: control channel severed mid-turn (circuit-breaker)');
                }
              }
            }
          }
        } else if (message.type === 'result') {
          resolvedSession = message.session_id;
          if (message.subtype === 'success') {
            result = message.result;
            onEvent?.({ kind: 'turn_debug', terminalReason: (message as { terminal_reason?: string }).terminal_reason, stopReason: (message as { stop_reason?: string | null }).stop_reason });
            // A background-task hold produces ≥2 results per turn (the immediate first result + the
            // auto-continuation after the task settles). SUM the billing tokens across results; the
            // contextTokens/contextModel/model/modelUsage below all reflect the LATEST result (turn-end
            // occupancy). The `result` string keeps the last result too — the final answer.
            const u = extractClaudeUsage(message as Record<string, unknown>, model);
            usage = usage ? addClaudeUsage(usage, u) : u;
            // Attach the per-call context occupancy (+ its model) onto the billing usage. The cumulative
            // `inputTokens` stays the billing number; `contextTokens` is the real window occupancy. Runs for
            // EVERY result so the FINAL result's occupancy wins.
            if (usage && contextTokens !== undefined) {
              usage.contextTokens = contextTokens;
              if (contextModel) usage.contextModel = contextModel;
            }
            // Streaming-input mode: decide whether this success result ends the turn.
            if (streaming) {
              if (capping) {
                // The advisory cap fired — the model's next natural result ends the turn via the NORMAL
                // grace, unless a background subagent is now live and must remain uncapped.
                if (liveSubagentTasks.size > 0) cancelEnd();
                else scheduleEnd();
              } else if (
                !isTurnGenuinelyDone(message as { terminal_reason?: string; stop_reason?: string | null })
              ) {
                // A paused/interrupted success result (rate-limit / retry / budget) is NOT the end of the
                // turn — keep input OPEN so the CLI can resume and may still call host tools (closing stdin
                // under an in-flight call orphans it → "Stream closed"). See #65. EXCEPT when we've hit a
                // subscription session limit: resuming would drive straight back into the wall, so end the
                // turn CLEANLY (the caller parks the lane + auto-resumes at resetAt) instead of holding open.
                if (sessionLimit) scheduleEnd();
                else cancelEnd();
              } else if (liveBgTasks.size === 0) {
                scheduleEnd();                 // genuinely done, nothing in flight — close after the steer grace
              } else if (liveSubagentTasks.size > 0) {
                cancelEnd();                   // a live SUBAGENT — hold input open with NO timer (may run for hours; bounded only by PHASE_TIMEOUT / Stop)
              } else {
                armHoldTimer();                // only bare bg Bash left → the advisory cap
              }
            }
          } else {
            // Surface the SDKResultError detail the SDK otherwise flattens into `subtype`.
            // Keep the leading `Claude engine ended: <subtype>` intact — isAuthErrorMessage
            // (below) and downstream matching key off it; only APPEND detail.
            const r = message as unknown as {
              subtype: string;
              errors?: string[];
              stop_reason?: string | null;
              terminal_reason?: unknown;
              num_turns?: number;
            };
            const parts = [
              `Claude engine ended: ${r.subtype}`,
              r.stop_reason ? `stop_reason=${r.stop_reason}` : '',
              r.terminal_reason ? `terminal_reason=${JSON.stringify(r.terminal_reason)}` : '',
              r.errors?.length ? `errors=${r.errors.join(' | ')}` : '',
              stderrTail.length ? `stderr(tail)=${stderrTail.join('').slice(-2000)}` : '',
            ].filter(Boolean);
            const errorMessage = parts.join('; ');
            // A non-success end that is really a subscription session-limit wall must NOT throw the generic
            // engine error — it is a clean park, not a failure. Latch it (from the text if the structured
            // frame didn't already) and break so the normal return path carries `sessionLimit` back.
            if (sessionLimit || detectSessionLimitText(errorMessage)) {
              sessionLimit ??= { resetAt: parseResetAt(errorMessage) };
              break;
            }
            throw new Error(errorMessage);
          }
        }
      }
    } catch (err) {
      // A 401 / expired token / "not logged in" → a RESUMABLE auth error carrying the live session,
      // so the driver pauses (not fails) and a re-ping continues this same session. Else re-throw.
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg)) throw new EngineAuthError(msg, resolvedSession, 'claude');
      if (streamClosedTripped) throw err;   // circuit-breaker: never treat as a cooperative abort
      // Cooperative STOP of a STEERABLE turn (operator Stop): the SDK iterator was cancelled. Treat as a
      // graceful end — fall through to the normal post-loop return with the partial result + live session,
      // so the turn finalizes cleanly (partial transcript persisted, session resumable) rather than
      // erroring. Non-streaming worker turns keep throwing on abort (the driver's timeout race depends on it).
      if (!(streaming && abortController.signal.aborted)) throw err;
    } finally {
      // Stop feeding/consuming input so the detached steer consumer + entrypoint generator unwind.
      turnEnded = true;
      cancelEnd();
      clearHold();
      input?.end();
      void steerIter?.return?.(undefined);
    }

    // On a plan turn the substance is the captured plan, not the closing summary.
    const planText = (planMode && capturedPlan) || undefined;
    const summary = planText || result || '(no summary)';
    onEvent?.({ kind: 'result', text: summary });
    if (streamClosedTotal > 0) onEvent?.({ kind: 'turn_debug', streamClosedCount: streamClosedTotal });

    // Auth-refresh write-back: a personal credential's `.credentials.json` is rewritten in place when the
    // SDK self-refreshes it. Read it back and relay it so the host can persist the fresh blob. Gated on
    // `persistAuthRefresh` — the host only sets it for ORG-sourced auth, so an env-fallback run never
    // leaks its ambient token here.
    const refreshedAuthSecret = args.persistAuthRefresh
      ? getEngineAuthAdapter('claude').readBackRefresh({
          homeRoot: this.homeRoot(),
          key: sandboxKey,
          writtenSecret: auth.secret,
        })
      : undefined;

    return {
      result: summary,
      sessionId: resolvedSession,
      ...(planText ? { planText } : {}),
      ...(usage ? { usage } : {}),
      ...(sessionLimit ? { sessionLimit } : {}),
      ...(streamClosedTotal > 0 ? { streamClosedCount: streamClosedTotal } : {}),
      ...(refreshedAuthSecret ? { refreshedAuthSecret } : {}),
    };
  }

  // ── Codex ─────────────────────────────────────────────────────────────────────────────────────

  private getCodex(
    sandboxKey: EngineHomeKey,
    auth: EngineAuth,
    bridge?: CodexMcpBridge,
    extraMcpServers?: CodexExtraMcpServers,
  ): Codex {
    const root = this.homeRoot();
    // Subscription-only: an overlay home owning its own auth.json (refreshed each turn) + — for an execute
    // turn — a config.toml with the host tool bridge (`[mcp_servers.atlasbridge]`) plus any user-defined
    // stdio MCP servers. The cache key keeps separate sandboxes apart. NO apiKey is ever passed.
    const codexHome = ensureCodexAuthHome(root, sandboxKey, auth.secret, bridge, extraMcpServers);
    const cacheKey = `sub:${engineHomeKeyString(sandboxKey)}`;
    let client = this.codexClients.get(cacheKey);
    if (!client) {
      // The SDK's `env` REPLACES inheritance — pass process.env through and override CODEX_HOME.
      const env = { ...process.env, CODEX_HOME: codexHome } as Record<string, string>;
      client = new this.codexSdk.Codex({ env });
      this.codexClients.set(cacheKey, client);
    }
    return client;
  }

  private codexThreadOptions(
    cwd: string,
    model: string | undefined,
    reasoningEffort?: CodexReasoningEffort,
  ): ThreadOptions {
    return {
      workingDirectory: cwd,
      // ALWAYS `danger-full-access` (NOT the default `workspace-write`, and NOT `read-only` even for the
      // plan-review turn). This is a disposable per-job sandbox, and every Codex turn needs the network:
      // execute turns bind a port for the live smoke + reach Postgres + `git push`, and read-only reviews
      // need to fetch live docs / verify library versions. `workspace-write` and `read-only` both FENCE the
      // network by default (→ `listen EPERM` / DB `EPERM` / DNS failures). The "don't edit files" contract
      // for review turns is carried by the PROMPT, not the sandbox — Codex has no `canUseTool` write guard
      // (unlike the Claude path), so the plan-review persona (`META_PLAN_REVIEW`) states it explicitly. This
      // matches the Claude builders, which already have full network + boot services + push.
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      webSearchMode: 'live',
      ...(model ? { model } : {}),
      // Codex ALWAYS runs at xhigh: default here so every Codex turn (current + any future thread-kind)
      // reasons hard regardless of callsite. Subscription accounts REJECT an explicit `model` but ACCEPT
      // this knob (verified by spike). A caller may still pass a lower explicit value if ever needed.
      modelReasoningEffort: reasoningEffort ?? 'xhigh',
    };
  }

  private async runCodex(
    args: RunEngineArgs,
    bridgeTools?: string[],
    extraMcpServers?: CodexExtraMcpServers,
  ): Promise<EngineRunResult> {
    const { task, cwd, systemPrompt, sandboxKey, sessionId, onEvent, signal, richStream } = args;
    const auth = this.resolveAuth('codex', args.auth);
    // Pass through ONLY an explicit caller override (none today); otherwise leave unset so
    // `codexThreadOptions` omits `model` and the subscription account's default is used (see note above).
    const model = args.model;

    // Host tool bridge (execute turns only): render an `[mcp_servers.atlasbridge]` block into config.toml
    // pointing codex at the in-sandbox MCP server, which does the Redis round-trip to the host. The server
    // reads the turn's Redis streams from TURN_ID/REDIS_URL (set in the container by RedisEngineRunner).
    const turnId = process.env.TURN_ID;
    const bridge: CodexMcpBridge | undefined =
      bridgeTools && bridgeTools.length > 0 && turnId
        ? {
            serverPath: CONTAINER_MCP_BRIDGE_PATH,
            toolNames: bridgeTools,
            env: { TURN_ID: turnId, REDIS_URL: process.env.REDIS_URL ?? 'redis://redis:6379' },
          }
        : undefined;

    const client = this.getCodex(sandboxKey, auth, bridge, extraMcpServers);
    const opts = this.codexThreadOptions(cwd, model, toCodexEffort(args.modelReasoningEffort));
    const thread = sessionId ? client.resumeThread(sessionId, opts) : client.startThread(opts);

    // Codex has no systemPrompt option — seed the persona as a first-turn preamble. Resumes already
    // carry it in thread history.
    const input = sessionId ? task : `${systemPrompt}\n\n---\n\nTask: ${task}`;

    let result = '';
    let resolvedSession = sessionId;
    let accInput = 0;
    let accCached = 0;
    let accOutput = 0;
    let accReasoning = 0;
    let usageSeen = false;

    const { events } = await thread.runStreamed(input, { signal });
    try {
      for await (const event of events) {
      switch (event.type) {
        case 'thread.started':
          // NB: SDK session field — `thread.started` is the Agent SDK's own event and `thread_id` is its
          // session id (NOT our domain Job/Thread), so it is out of scope for the domain rename.
          resolvedSession = event.thread_id;
          // Surface the resume handle immediately (turn start) for mid-turn halt recovery.
          if (resolvedSession) onEvent?.({ kind: 'session', sessionId: resolvedSession });
          break;
        case 'item.completed': {
          const item = event.item;
          // Codex reports each item ONCE, already completed (with full command output / patch status), so
          // under `richStream` we emit the authoritative tool_use→tool_result pair back-to-back (the shared
          // TurnHarness pairs them by id) instead of the coarse `tool` event, which the durable transcript
          // drops. Without `richStream` (every current Codex caller) the coarse behavior is preserved.
          switch (item.type) {
            case 'agent_message':
              onEvent?.({ kind: 'text', text: item.text });
              result = item.text;
              break;
            case 'reasoning':
              onEvent?.(
                richStream
                  ? { kind: 'thinking', text: item.text }
                  : { kind: 'text', text: item.text },
              );
              break;
            case 'command_execution':
              if (richStream) {
                const isError =
                  item.status === 'failed' ||
                  (item.exit_code != null && item.exit_code !== 0);
                onEvent?.({ kind: 'tool_use', id: item.id, name: 'bash', input: { command: item.command } });
                onEvent?.({ kind: 'tool_result', id: item.id, result: item.aggregated_output, isError });
              } else {
                onEvent?.({ kind: 'tool', name: 'bash', detail: item.command });
              }
              break;
            case 'file_change':
              if (richStream) {
                // Codex bundles every file a patch touched into ONE item — split it into one
                // tool_use/tool_result pair per file (mirroring Claude's one-file-per-Edit shape) so each
                // gets its own diff card instead of a single card with no renderable content.
                const multi = item.changes.length > 1;
                for (const [idx, change] of item.changes.entries()) {
                  const id = multi ? `${item.id}:${idx}` : item.id;
                  onEvent?.({
                    kind: 'tool_use',
                    id,
                    name: 'edit',
                    input: { file_path: change.path, kind: change.kind },
                  });
                  onEvent?.({
                    kind: 'tool_result',
                    id,
                    result: item.status,
                    isError: item.status === 'failed',
                    structuredPatch: computeCodexStructuredPatch(cwd, change.path, change.kind),
                  });
                }
              } else {
                onEvent?.({
                  kind: 'tool',
                  name: 'edit',
                  detail: item.changes.map((c) => `${c.kind} ${c.path}`).join(', '),
                });
              }
              break;
            case 'web_search':
              if (richStream) {
                onEvent?.({ kind: 'tool_use', id: item.id, name: 'web_search', input: { query: item.query } });
                onEvent?.({ kind: 'tool_result', id: item.id, result: 'completed' });
              } else {
                onEvent?.({ kind: 'tool', name: 'web_search', detail: item.query });
              }
              break;
            case 'error':
              onEvent?.({ kind: 'text', text: `error: ${item.message}` });
              break;
          }
          break;
        }
        case 'turn.completed': {
          const u = event.usage;
          accInput += u.input_tokens ?? 0;
          accCached += u.cached_input_tokens ?? 0;
          accOutput += u.output_tokens ?? 0;
          accReasoning += u.reasoning_output_tokens ?? 0;
          usageSeen = true;
          break;
        }
        case 'turn.failed':
          throw new Error(event.error.message);
        case 'error':
          throw new Error(event.message);
      }
      }
    } catch (err) {
      // 401 / expired creds mid-Codex-turn → resumable auth error carrying the live thread id.
      const msg = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(msg)) throw new EngineAuthError(msg, resolvedSession, 'codex');
      throw err;
    }

    const summary = result || '(no summary)';
    onEvent?.({ kind: 'result', text: summary });

    const usage: EngineUsage | undefined = usageSeen
      ? {
          inputTokens: accInput,
          outputTokens: accOutput,
          ...(accCached > 0 ? { cacheReadTokens: accCached } : {}),
          ...(accReasoning > 0 ? { reasoningTokens: accReasoning } : {}),
          ...(model ? { model } : {}),
        }
      : undefined;

    // Auth-refresh write-back: Codex re-mints its short-lived tokens from the stored `refresh_token` and
    // rewrites `auth.json` in place. Read the overlay back and relay it so the host can persist the fresh
    // blob (else the stored credential is a rotting snapshot). Gated on `persistAuthRefresh` — the host
    // only sets it for ORG-sourced auth, so an env-fallback run never leaks its ambient token here.
    const refreshedAuthSecret = args.persistAuthRefresh
      ? getEngineAuthAdapter('codex').readBackRefresh({
          homeRoot: this.homeRoot(),
          key: sandboxKey,
          writtenSecret: auth.secret,
        })
      : undefined;

    return {
      result: summary,
      sessionId: resolvedSession ?? thread.id ?? undefined,
      ...(usage ? { usage } : {}),
      ...(refreshedAuthSecret ? { refreshedAuthSecret } : {}),
    };
  }
}

/** Re-applies the safety boundary to Claude's built-in tools (programmatic gate — never blocks on a
 * human). A 'plan' turn runs under the SDK's native plan mode (the CLI itself enforces read-only);
 * ExitPlanMode's input carries the plan, which we capture then DENY (approving would flip the live
 * session into execution). The Write/Edit/bash read-only branches are belt-and-braces.
 *
 * `roots` is the set of directories Write/Edit may target (the worktree `cwd` plus any extra writable
 * mounts like the durable `/context` shared folder). A write is allowed if it lands inside ANY root. */
/** The tool names whose `input.file_path` can mutate a skill — read-only-by-default gate applies to all three. */
const SKILL_MUTATING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * Skills read-only enforcement context: the per-turn composed dir + store mount + resolved skill list
 * `makeCanUseTool` needs to recognize a skill path and name it in the deny message. Optional — a turn with
 * no skills resolved (or a non-Claude/legacy caller) passes none and the skill check is simply skipped.
 */
export interface SkillGuardCtx {
  /** `<CLAUDE_CONFIG_DIR>/skills` — the write-through symlink dir `composeSkillsDir` maintains. */
  composedSkillsDir: string;
  /** The org-scoped skills-store mount root (`CONTAINER_SKILLS_STORE` in-sandbox), if the run has one. */
  skillsStoreRoot?: string;
  /** This turn's resolved skills (name + store-relative dirPath) — used to name a store-mount path. */
  skills: RunEngineArgs['skills'];
  /** Skill names this SESSION already holds an edit grant for (`RunEngineArgs.grantedSkills`). */
  granted: Set<string>;
}

/** Which skill (if any) `filePath` belongs to — the composed symlink dir first (structural: the first path
 *  segment under it IS the skill name), then a match against a resolved skill's store dir (the model
 *  resolved the symlink and is addressing the real path). Undefined → not a skill path at all. */
function skillNameForPath(filePath: string, ctx: SkillGuardCtx): string | undefined {
  if (isInsideRoot(filePath, ctx.composedSkillsDir)) {
    const rel = relativePath(resolvePath(ctx.composedSkillsDir), resolvePath(ctx.composedSkillsDir, filePath));
    const name = rel.split(/[/\\]/)[0];
    if (name) return name;
  }
  if (ctx.skillsStoreRoot) {
    for (const skill of ctx.skills ?? []) {
      if (isInsideRoot(filePath, join(ctx.skillsStoreRoot, skill.dirPath))) return skill.name;
    }
  }
  return undefined;
}

export function makeCanUseTool(
  readOnly: boolean,
  roots: string | string[],
  onPlan: (plan: string) => void,
  skillGuard?: SkillGuardCtx,
): CanUseTool {
  const allowedRoots = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName === 'ExitPlanMode') {
      if (typeof input.plan === 'string') onPlan(input.plan);
      return { behavior: 'deny', message: 'Plan recorded — ending the planning turn.' };
    }
    if (readOnly && (toolName === 'Write' || toolName === 'Edit')) {
      return { behavior: 'deny', message: 'This is a read-only turn — no file writes.' };
    }
    if (skillGuard && SKILL_MUTATING_TOOLS.has(toolName)) {
      const path = typeof input.file_path === 'string' ? input.file_path : '';
      const skillName = path ? skillNameForPath(path, skillGuard) : undefined;
      if (skillName) {
        if (skillGuard.granted.has(skillName)) return { behavior: 'allow', updatedInput: input };
        return {
          behavior: 'deny',
          message:
            `This skill is read-only. Call request_skill_edit_access({ skill: '${skillName}' }) to request ` +
            'edit access for this session, then retry your edit.',
        };
      }
    }
    if (toolName === 'Write' || toolName === 'Edit') {
      const path = typeof input.file_path === 'string' ? input.file_path : '';
      if (path && !allowedRoots.some((root) => isInsideRoot(path, root))) {
        return {
          behavior: 'deny',
          message: `Write outside the allowed roots (${allowedRoots.join(', ')}) is not allowed: ${path}`,
        };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

/**
 * Fold one result's {@link EngineUsage} into a running accumulator. A background-task hold yields ≥2
 * results per turn (the immediate first result + the post-settlement auto-continuation), so the BILLING
 * token fields are SUMMED across results, including the per-model breakdown. Occupancy-and-label fields
 * (`contextTokens`/`contextModel`/`model`) reflect the LATEST result (the turn-end window), so `next`
 * overwrites when it carries them. `next` undefined (a result with no usage) leaves `acc` unchanged.
 */
export function addClaudeUsage(acc: EngineUsage, next: EngineUsage | undefined): EngineUsage {
  if (!next) return acc;
  const inputTokens = (acc.inputTokens ?? 0) + (next.inputTokens ?? 0);
  const outputTokens = (acc.outputTokens ?? 0) + (next.outputTokens ?? 0);
  const cacheReadTokens = (acc.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0);
  const cacheWriteTokens = (acc.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0);
  const reasoningTokens = (acc.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  const bothCostAbsent = acc.costUsd === undefined && next.costUsd === undefined;
  const costUsd = bothCostAbsent ? undefined : (acc.costUsd ?? 0) + (next.costUsd ?? 0);
  const modelUsage = addClaudeModelUsage(acc.modelUsage, next.modelUsage);
  return {
    ...acc,
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    // Occupancy + labels track the LATEST result.
    ...(next.model ? { model: next.model } : {}),
    ...(next.contextTokens !== undefined ? { contextTokens: next.contextTokens } : {}),
    ...(next.contextModel ? { contextModel: next.contextModel } : {}),
    ...(modelUsage ? { modelUsage } : {}),
  };
}

function addClaudeModelUsage(
  acc: Record<string, ModelUsageBreakdown> | undefined,
  next: Record<string, ModelUsageBreakdown> | undefined,
): Record<string, ModelUsageBreakdown> | undefined {
  if (!acc && !next) return undefined;
  const out: Record<string, ModelUsageBreakdown> = {};
  for (const [model, usage] of Object.entries(acc ?? {})) out[model] = { ...usage };
  for (const [model, usage] of Object.entries(next ?? {})) {
    const prior = out[model];
    const webSearchRequests = (prior?.webSearchRequests ?? 0) + (usage.webSearchRequests ?? 0);
    out[model] = {
      inputTokens: (prior?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (prior?.outputTokens ?? 0) + usage.outputTokens,
      cacheReadTokens: (prior?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
      cacheWriteTokens: (prior?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
      costUsd: (prior?.costUsd ?? 0) + usage.costUsd,
      ...(webSearchRequests > 0 ? { webSearchRequests } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Extract token usage from a Claude success result. Convention: inputTokens = total INCLUDING cache. */
export function extractClaudeUsage(
  message: Record<string, unknown>,
  model: string | undefined,
): EngineUsage | undefined {
  const u = message.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  if (!u) return undefined;
  const costUsd = message.total_cost_usd as number | undefined;
  // The SDK's per-model breakdown for the WHOLE turn (orchestrator + subagents), keyed by model id.
  // Formerly collapsed to `Object.keys(...)[0]` (dropping every model but the first); now carried in
  // full onto `usage.modelUsage` as the authoritative source for per-model token/cost analytics.
  const rawModelUsage = message.modelUsage as
    | Record<
        string,
        {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          costUSD?: number;
          webSearchRequests?: number;
        }
      >
    | undefined;
  const modelUsage: Record<string, ModelUsageBreakdown> | undefined = rawModelUsage
    ? Object.fromEntries(
        Object.entries(rawModelUsage).map(([m, mu]) => [
          m,
          {
            inputTokens: mu.inputTokens ?? 0,
            outputTokens: mu.outputTokens ?? 0,
            cacheReadTokens: mu.cacheReadInputTokens ?? 0,
            cacheWriteTokens: mu.cacheCreationInputTokens ?? 0,
            costUsd: mu.costUSD ?? 0,
            ...(mu.webSearchRequests ? { webSearchRequests: mu.webSearchRequests } : {}),
          },
        ]),
      )
    : undefined;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const inputTokens = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
  // The turn's PRIMARY (orchestrator) model. Prefer the model we invoked the SDK with — it's the main
  // agent's model by construction, guaranteed present. NOT `Object.keys(modelUsage)[0]`: modelUsage is the
  // whole-turn billing rollup (orchestrator + subagents + SDK-internal helper calls) and object-key order
  // isn't guaranteed, so a subagent/internal model (e.g. a Haiku housekeeping call) could sort first and
  // mislabel the turn. modelUsage stays the authoritative per-model breakdown below; this is only the label.
  const usedModel = model ?? (modelUsage ? Object.keys(modelUsage)[0] : undefined);
  return {
    inputTokens,
    ...(u.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(usedModel ? { model: usedModel } : {}),
    ...(modelUsage ? { modelUsage } : {}),
  };
}
