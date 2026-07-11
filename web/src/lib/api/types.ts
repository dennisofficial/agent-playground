/**
 * Contracts for the Atlas web surface (`/web/*`). These MIRROR the backend shapes verbatim:
 *  - `WebApprovalCard` / `WebVerdictCard` — the approval-card payload carried on a message's `card`.
 *  - `PipelineState` — `DriverStoreService.getPipelineState` (job + threads + per-thread steps; carries
 *    the thread's PR url/number + feature/base branch — the navigator's ARTIFACTS + header read them).
 *
 * The live message + request shapes are owned by `job-api.ts` (the org → repo → thread client).
 */

import type {
  JobActivity as WireJobActivity,
  JobHalt as WireJobHalt,
  JobStatus as WireJobStatus,
  OrgUsage,
} from "@workspace/shared";

// ── Backend (wire) enums ─────────────────────────────────────────────────────────────────────────
/**
 * The backend job WIRE status — single-sourced in `@workspace/shared` so it can't drift from the
 * backend's `JobStatus`. (The web's own UI-presentation `JobStatus` — below — is a separate type.)
 */
export type { WireJobStatus };
/** The backend job halt reason — single-sourced in `@workspace/shared`. Null when the job is healthy. */
export type { WireJobHalt };
/**
 * Host-side Claude subscription usage snapshot — single-sourced in `@workspace/shared`. Carries the
 * OPTIONAL panel-header fields (`accountLabel` = the selected account's email/label, `plan` = its
 * subscription plan); both are absent when no credential is selected and the panel falls back to a
 * neutral single-account header.
 */
export type WireOrgUsage = OrgUsage;
/**
 * The backend "system is working" axis (`idle | turn | plan_review | build | master_review`) —
 * single-sourced in `@workspace/shared`. Carried on the realtime row; the dot itself reads `needsYou`.
 */
export type { WireJobActivity };

export type WireJobKind =
  | "feature"
  | "bugfix"
  | "onboarding"
  | "event"
  | "review";

/** The lane (Thread) PURE LINEAR STEP — one build lane within a Job. Pause/failure/skip are NOT steps;
 *  they live on the orthogonal {@link ThreadCondition} overlay. Mirrors backend `ThreadStatus`. */
export type ThreadStatus =
  | "pending"
  | "planning"
  | "reviewing"
  | "executing"
  | "auto_fixing"
  | "done";

/**
 * The orthogonal condition overlay on a lane (a lightweight denormalized tag, like job-level `halt.kind`),
 * independent of the linear {@link ThreadStatus} step. Detail (stderr, block reason, verification) stays in
 * the backend `terminal_record`/`halt_outcome`. Mirrors backend `ThreadCondition`.
 */
export type ThreadCondition =
  | "none"
  | "paused" // a mid-build pause (request_operator_input / thread-level approval) — the step is preserved
  | "incomplete" // halted without asserting completion (ADR 0004)
  | "failed" // crashed / errored out
  | "skipped"; // a review child that had nothing to do (unknown lens / no diff) — terminal, not a failure

/** Per-step status (the execute folder's leaves). Mirrors backend `StepStatus` in `domain/thread.ts`. */
export type StepStatus = "pending" | "building" | "reviewing" | "done";

// ── Approval / verdict cards ───────────────────────────────────────────────────────────────────
export const APPROVE_ACTION_ID = "atlas_approval:approve";
export const REQUEST_CHANGES_ACTION_ID = "atlas_approval:request_changes";
export const DENY_ACTION_ID = "atlas_approval:deny";
export const VIEW_PLAN_ACTION_ID = "atlas_approval:view_plan";
/** The SHIP-REVIEW gate's "Ship it" button — the SECOND human gate (after {@link APPROVE_ACTION_ID} at the
 *  plan stage), clicked while the job is `awaiting_ship_review`. POSTs to the SAME `/approve` endpoint with
 *  a `value` of just `{ jobId }` (no decision record — nothing to re-rule, just resume the build). */
export const SHIP_ACTION_ID = "atlas_approval:ship";
/** The ship-review gate's manual "Amend build" retract — sends `awaiting_ship_review → amending`
 *  without discarding completed work (mirrors the Atlas `withdraw_ship` tool). POSTs to the SAME
 *  `/approve` endpoint with the ship card's `{ jobId }` value. Must match the backend string in
 *  `approval-blocks.ts`. */
export const RETRACT_SHIP_ACTION_ID = "atlas_approval:retract_ship";
/** The brain's "Amend build?" PROPOSAL buttons (the `withdraw_ship` tool's card). Unlike the plain
 *  ship-card retract, the gate stays parked until the operator approves: `Approve amend` runs the operator
 *  retract AND wakes the brain; `Dismiss` just clears the card. Must match `approval-blocks.ts`. */
export const AMEND_APPROVE_ACTION_ID = "atlas_approval:amend_approve";
export const AMEND_DISMISS_ACTION_ID = "atlas_approval:amend_dismiss";

export type ApprovalActionId =
  | typeof APPROVE_ACTION_ID
  | typeof REQUEST_CHANGES_ACTION_ID
  | typeof DENY_ACTION_ID
  | typeof SHIP_ACTION_ID
  | typeof RETRACT_SHIP_ACTION_ID
  | typeof AMEND_APPROVE_ACTION_ID
  | typeof AMEND_DISMISS_ACTION_ID;

export interface ApprovalDecision {
  decisionClass: string;
  title: string;
  ruling: string;
  /** PROVENANCE — true when the operator confirmed this call; false/absent = Atlas authored the default. */
  confirmedByOperator?: boolean;
}

export interface WebCardAction {
  actionId: string;
  label: string;
  style: "primary" | "danger" | "default";
  /** Link buttons (e.g. "View full plan") carry a URL; otherwise the click POSTs a verdict. */
  url?: string;
  /** Serialized `ApprovalActionMeta` (jobId + decisionRecordId) — sent back verbatim on /web/approve. */
  value: string;
}

export interface WebApprovalCard {
  type: "approval_card";
  jobId: string;
  decisionRecordId?: string;
  /**
   * `plan` (full ceremony) / `direct` (fast path) — the plan-stage approval, labels the list "Sections"
   * vs "Changes". `ship` — the ship-review gate (`Ship it` + `Back to building`;
   * `threads`/`decisions` empty). `amend` — the brain's "Amend build?" proposal at the ship gate
   * (`Approve amend` + `Dismiss`); the gate stays parked until approved.
   */
  kind?: "plan" | "direct" | "ship" | "amend";
  title: string;
  summary: string;
  decisions: ApprovalDecision[];
  threads: string[];
  planUrl?: string;
  actions: WebCardAction[];
}

export interface WebVerdictCard {
  type: "verdict_card";
  jobId: string;
  title: string;
  verdict: string;
  verdictLine: string;
}

/** One selectable answer in a question card (mirrors the backend `WebQuestionOption`). */
export interface WebQuestionOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * A formal question the brain posed via `ask_question` — rendered as a card with one button per option
 * (+ optional free-text "Other"). The operator's pick POSTs to `…/threads/:jobId/answer-question`.
 * When `answer` is set the card renders the compact answered state. Mirrors the backend `WebQuestionCard`.
 */
export interface WebQuestionCard {
  type: "question_card";
  jobId: string;
  questionId: string;
  header?: string;
  question: string;
  decisionClass?: string;
  options: WebQuestionOption[];
  allowOther: boolean;
  answer?: string;
  answeredAt?: string;
  loggedDecision?: boolean;
  /** Set when the brain RETRACTED this still-unanswered question (`withdraw_question`) — renders a compact
   *  "withdrawn" state with no answer buttons. Terminal, like `answer`. */
  withdrawnAt?: string;
  withdrawnReason?: string;
}

/**
 * A secure SECRET request the onboarding brain posed via `request_secret` — rendered as a masked input.
 * The operator's value POSTs to `…/threads/:jobId/provide-secret`, which stores it ENCRYPTED + grants
 * it; the value is NEVER part of this card. When `provided_at` is set the card renders a compact "provided"
 * state. Mirrors the backend `WebSecretInputCard` (deliberately value-free).
 */
export interface WebSecretInputCard {
  type: "secret_input_card";
  jobId: string;
  requestId: string;
  /** Secret name, or a display LABEL only when {@link ephemeral}. */
  name: string;
  /** Durable destination; absent for an ephemeral request. */
  path?: string;
  description: string;
  /** A headless-login URL (e.g. `gcloud auth login --no-launch-browser`) to render as a clickable link above the field. */
  url?: string;
  /** One-time value delivered straight to the running sandbox and NEVER stored (OAuth code, 2FA, sudo pw). */
  ephemeral?: boolean;
  /** Ephemeral-only: the in-container path the value is piped to (operational, not a secret). */
  deliver_to?: string;
  /** MCP-target: the value is a credential slot for a user-defined MCP server (written to the encrypted MCP
   *  store, not the worktree). `path` is absent for an MCP target. */
  mcp?: { server: string; slot: "header" | "env"; key: string };
  provided_at?: string;
  delivered_at?: string;
}

/**
 * A secure FILE request the onboarding brain posed via `request_file` — rendered as a file picker. The
 * operator's file is read as text and POSTs to `…/threads/:jobId/provide-file`, which stores the contents
 * ENCRYPTED + grants them; the contents are NEVER part of this card. When `provided_at` is set the card
 * renders a compact "uploaded" state. Mirrors the backend `WebFileRequestCard` (deliberately value-free).
 */
export interface WebFileRequestCard {
  type: "file_request_card";
  jobId: string;
  requestId: string;
  path: string;
  description: string;
  filename?: string;
  provided_at?: string;
  delivered_at?: string;
  /** Set when the brain retracted the request via `withdraw_file_request` — greys the card, drops the picker. */
  withdrawnAt?: string;
  withdrawnReason?: string;
}

/** One quoted selection + note in a sent review-comment bundle. `file` is the display label (e.g. the
 *  file's basename) the operator had open when they commented, not the full context-bucket path. */
export interface WebReviewCommentItem {
  file: string;
  quote: string;
  note?: string;
}

/**
 * A batch of inline review comments the operator sent via the highlight-and-comment flow ("Atlas Workspace
 * HiFi") — the operator selected text in the detail pane, noted it, and sent the queue as one message.
 * Rendered as a distinct right-aligned card (grouped by file); an optional trailing `message` is the
 * operator's typed prose, rendered as a normal bubble underneath. Mirrors the backend `review_comments_card`.
 */
export interface WebReviewCommentsCard {
  type: "review_comments_card";
  items: WebReviewCommentItem[];
  message?: string;
}

/** One attachment the operator sent from the composer (image or file). Mirrors the backend `AttachmentCardItem`. */
export interface WebAttachmentItem {
  /** Display filename. */
  name: string;
  /** Bucket-relative `/context` path (`uploads/<name>`) — fetched from the streaming raw endpoint. */
  path: string;
  kind: "image" | "file";
  size: number;
  /**
   * OPTIMISTIC-ONLY local preview URL (`URL.createObjectURL`), set on the client's own optimistic row so
   * the thumbnail shows instantly before the durable row (server `path`) reconciles in. Never sent by the
   * server.
   */
  localUrl?: string;
}

/**
 * Files/images the operator attached in the composer (or pasted). Rendered as a chip/thumbnail row ON TOP
 * of the operator's optional caption bubble. Mirrors the backend `attachments_card`.
 */
export interface WebAttachmentsCard {
  type: "attachments_card";
  items: WebAttachmentItem[];
  /** The operator's optional typed caption, rendered as a normal bubble beneath the attachments. */
  message?: string;
}

/** One proposed server in an MCP-proposal card — the non-secret definition only (mirrors the backend). */
export interface WebMcpProposalServer {
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  /** Header names; `secret:true` marks a slot the owner fills after approval (via request_secret). */
  headers?: { name: string; secret?: boolean; value?: string }[];
  env?: { name: string; secret?: boolean; value?: string }[];
  /**
   * `"static"` (default when absent) = header/env credential slots. `"oauth"` = interactive OAuth 2.1 the
   * owner completes after approving by clicking Connect in MCP settings (no secret slot to fill).
   */
  authKind?: "static" | "oauth";
  /** Non-secret OAuth knobs; only meaningful when `authKind==="oauth"`. */
  oauth?: { scope?: string; tokenAuthMethod?: "none" | "client_secret_post" | "client_secret_basic" };
  /** The brain's one-line rationale for why this server suits the repo. */
  reason?: string;
}

/**
 * A stack-matched MCP-server recommendation the onboarding brain posed via `propose_mcp_servers`. The
 * OWNER approves it (owner-only) at `…/jobs/:jobId/mcp-proposals/:requestId/approve`, which registers each
 * server on the repo; secret slots are then filled via a normal secure secret card. When `approved_at` is
 * set the card renders a compact "registered" state. Value-free (server defs only, never a secret value).
 */
export interface WebMcpProposalCard {
  type: "mcp_proposal_card";
  jobId: string;
  requestId: string;
  repoId: string;
  servers: WebMcpProposalServer[];
  approved_at?: string;
  committed?: string[];
}

/**
 * A ticket-captured callout — posted when the brain raises a ticket mid-job via `create_ticket`. Purely
 * informational (no approve/answer lifecycle); the operator clicks through to the ticket on the board.
 * Mirrors the backend `WebTicketCard`.
 */
export interface WebTicketCard {
  type: "ticket_card";
  ticketId: string;
  number: number;
  title: string;
  kind: string | null;
  priority: string | null;
  status: string;
  originDecisionSummary: string | null;
}

/**
 * An owner-approvable SKILL proposal the brain posts. `install` = reuse a maintained skill from a git
 * marketplace (`installPreview` shows the exact resolved skill + any overwrite); `create` = a skill the brain
 * AUTHORED as real files (`preview` shows SKILL.md + the file tree); `remove` = delete a registered skill.
 * The OWNER approves at `…/jobs/:jobId/skill-proposals/:requestId/approve`. Mirrors the backend card.
 */
export interface WebSkillProposalCard {
  type: "skill_proposal_card";
  jobId: string;
  requestId: string;
  repoId: string;
  scope: "org" | "repo";
  name: string;
  description: string;
  surfaces: ("brain" | "build" | "review")[];
  mode: "create" | "install" | "remove";
  rationale: string;
  stagingPath?: string;
  preview?: { skillMd: string; files: string[] };
  sourceUrl?: string;
  sourceRef?: string;
  sourceSubpath?: string;
  installPreview?: {
    rows: { name: string; description: string; overwrites: boolean }[];
  };
  priorBody?: string;
  approved_at?: string;
  dismissed_at?: string;
}

export type WebCard =
  | WebApprovalCard
  | WebVerdictCard
  | WebQuestionCard
  | WebSecretInputCard
  | WebFileRequestCard
  | WebReviewCommentsCard
  | WebAttachmentsCard
  | WebMcpProposalCard
  | WebSkillProposalCard
  | WebTicketCard;

// ── Pipeline (`…/threads/:jobId/pipeline`) ────────────────────────────────────────────────────
/** One step of a thread's locked plan — the execute folder's leaf (a Claude Code session). */
export interface PipelineStep {
  id: string;
  ordinal: number;
  title: string | null;
  brief: string;
  /** The resumable cursor within the step ('build' | 'review' | 'fix'). */
  stage: string;
  status: StepStatus;
  /** The execution batch this step belongs to within its thread; null until the thread first executes. */
  batchOrdinal: number | null;
  /**
   * The ANCHOR step id of this step's batch — a batch runs as ONE engine turn whose transcript is tagged
   * with the anchor's id. A non-anchor step must remap to this before reading the transcript / live lane.
   * Defaults to the step's own id when not yet batched.
   */
  anchorStepId: string;
  /** Every step id in this step's batch (so the sub-page can show "steps 2–4 built together"). */
  batchStepIds: string[];
}

/**
 * One review CHILD thread of a builder — a `review_lens` (one self-review pass) or the single `post_review`
 * (fix · apply · verify). A first-class thread row: its own status + streaming `lane` + (for a lens) the
 * `lensId` and finding count. The navigator renders these directly as bare child-thread nodes (no synthetic
 * `rev:`/`fix:` ids); `lane` is the `autofix:<parentId>:<lensId>` / `autofix:<parentId>:fix` transcript lane.
 */
/**
 * A lane's STATIC composer-footer default (`model · effort`) — what the footer shows BEFORE the lane's
 * first turn completes (no `turn_meta` to derive from yet). Backend-supplied per kind (`laneDefaultFooter`),
 * so nothing is hardcoded in the frontend. No `context` field — occupancy is only known after a turn runs.
 */
export interface LaneDefaultFooter {
  engine: string;
  /** The Claude model id (`'opus'`) for claude lanes; absent for codex (no pinned model → labels "Codex"). */
  model?: string;
  /** Codex reasoning effort (`'xhigh'`), when the lane runs at one. */
  effort?: string;
}

export interface PipelineReviewChild {
  id: string;
  kind: "review_lens" | "post_review";
  brief: string;
  status: ThreadStatus;
  /** The orthogonal condition overlay (skipped/failed/…) — independent of the linear {@link status} step. */
  condition: ThreadCondition;
  /** The lens id (`best_practices`/…) for a `review_lens` child; absent for `post_review`. */
  lensId?: string;
  /** Findings this lens surfaced, or null until it has run (`post_review` is always null). */
  findings: number | null;
  /** The transcript lane the child streams on (the SAME lane the backend turn writes). */
  lane: string;
  /** The lane's pre-turn footer default (`model · effort`). */
  defaultFooter: LaneDefaultFooter;
}

/**
 * One task in an orchestrating session's LIVE, LLM-authored checklist — folded server-side from its
 * `TaskCreate`/`TaskUpdate` tool calls (no fixed/expected set: `[]` just means the session hasn't created
 * any tasks yet, not "not started"). `dropped` is the SDK's `deleted` status.
 */
export interface TaskItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed" | "dropped";
  /** The SDK task's longer description — shown under an in_progress task + as the row tooltip. */
  description?: string;
  /** Present-continuous label ("Resolving the router chain") shown while in_progress; falls back to subject. */
  activeForm?: string;
  /** Dependency edges — ids of tasks this one waits on. A PENDING task with an incomplete blocker renders
   *  BLOCKED (derived; the block clears when every blocker completes or is deleted). */
  blockedBy?: string[];
}

/**
 * One BUILD LEG (context-rot rotation): a single engine session in a build thread's life. A thread's build
 * work spans many sequential Legs, each seeded from the prior one's structured handoff when its context filled.
 * `handoffMd` is the handoff the Leg authored on rotation (null for the current/live Leg). Backs the per-Leg
 * navigable rows + the handoff pill between them.
 */
export interface PipelineLeg {
  /** 1..N — the Leg's position in the thread. */
  ordinal: number;
  /** `active` (current live Leg) | `rotated` (handed off to the next) | `closed` (thread finished on it). */
  status: string;
  /** The peak main-agent context occupancy observed on this Leg (the number that tripped its rotation). */
  contextTokensPeak: number | null;
  /** The structured handoff this Leg authored on rotation — the pill shown to the next Leg. Null while live. */
  handoffMd: string | null;
  /** When the Leg was rotated/closed (ISO), or null while active. */
  endedAt: string | null;
}

export interface PipelineThread {
  id: string;
  ordinal: number;
  brief: string;
  /** The thread's scope type (backend/frontend/docs/…). */
  type: string;
  status: ThreadStatus;
  /** The orthogonal condition overlay (pause/terminal tag) — independent of the linear {@link status} step. */
  condition: ThreadCondition;
  /** The thread KIND (`builder` | `master_review`) — the single differentiator. */
  kind?: string;
  /** True for the whole-diff Codex master-review thread (derived from `kind`) — rendered "Master review"
   *  with no review children. */
  isMasterReview?: boolean;
  /**
   * This builder's review CHILD threads (review_lens × N + post_review) — each a first-class row the
   * navigator renders directly. `[]` until the builder finishes executing and its review is materialized;
   * always `[]` for a master-review thread (it IS the review).
   */
  children: PipelineReviewChild[];
  /** The thread's own live task list — see {@link TaskItem}. `[]` until its session creates a task. */
  tasks: TaskItem[];
  /** The thread's build Legs (context-rot rotation) — see {@link PipelineLeg}. `[]` for a thread that never
   *  rotated (rendered as a single implicit Leg); one row per Leg once it has rotated at least once. */
  legs?: PipelineLeg[];
  /** Whether a just-in-time plan was generated — gates the optional `plan` leaf in the nav tree. */
  hasPlan: boolean;
  /** The thread's steps (execute folder leaves), ordinal-sorted. */
  steps: PipelineStep[];
  /** The lane's pre-turn composer-footer default (`model · effort`), keyed off `kind`. */
  defaultFooter?: LaneDefaultFooter;
}

export interface PipelineJob {
  /** The thread id — the backend keys the pipeline on the thread (thread = the build unit). */
  jobId: string;
  title: string;
  kind: WireJobKind;
  status: WireJobStatus;
  halt: WireJobHalt | null;
  /**
   * Which build path was committed at approval: `'direct'` (fast, brain-implemented) | `'plan'` (driver
   * multi-thread) | `null` (never approved — still an open/awaiting-approval proposal that could become
   * either). The navigator reads this to suppress the plan-oriented empty-state placeholders (build lanes,
   * `plan.md`, generated docs) for a direct build, where they never apply. Absent on very old payloads.
   */
  buildPath?: "direct" | "plan" | null;
  decisionRecordId: string | null;
  /**
   * The MAIN brain session's own task list (folded from its `main`-lane task-tool calls) — the
   * navigator's Main row renders it. (The old job-level PR-review `reviewAgents`/`tasks`/`prReviewStatus`
   * are gone — master review is now a normal build thread with its own per-thread fields.)
   */
  mainTasks: TaskItem[];
  /** The Main (brain) lane's pre-turn footer default — Main renders from `mainTasks` (not `threads`), so it
   *  carries its own default. Absent on very old payloads. */
  mainDefaultFooter?: LaneDefaultFooter;
  /** The plan-review (Codex) thread — a first-class navigator row that opens the `codex-review:<jobId>`
   *  lane (the review dialogue Main communicates with). Null when no review has run. */
  planReview: { status: string; defaultFooter?: LaneDefaultFooter } | null;
  /** The opened PR (ARTIFACTS), or null until the PR-tail stage opens one. */
  prUrl: string | null;
  prNumber: number | null;
  /** Observed PR lifecycle (`jobs.pr_state`) — same source as the sidebar glyph; null until a PR exists. */
  prState: PrState | null;
  /** GitHub `mergeable_state` (`'dirty'` = merge conflict), or null. Refines the `open` state's coloring. */
  prMergeable: string | null;
  /** Aggregate CI outcome for the PR head (`jobs.ci_status`) — same four-state taxonomy as the sidebar
   *  dot; null = no checks reported. Only meaningful once a PR exists (prNumber != null). */
  ciStatus: CiStatus | null;
  /** Per-category CI check counts (`jobs.ci_counts`) — drives the header glyph's hover tooltip. Parallel
   *  to `ciStatus`; null when no checks reported. */
  ciCounts?: CiCounts | null;
  /** The feature branch all threads stack on (header), or null before the sandbox is cut. */
  featureBranch: string | null;
  /** The OBSERVED live branch the agent's HEAD is on; differs from featureBranch ⇒ drift (badge). Null
   *  until first sampled / on detached HEAD. */
  currentBranch: string | null;
  baseBranch: string | null;
  threads: PipelineThread[];
  /**
   * Prior PLAN REVISIONS' build lanes as read-only, browsable history — present only once a re-propose over
   * already-DONE work has forged a new revision (the common single-revision job sends `[]`/absent). Each
   * entry is a superseded revision with its own executable lanes; `revision` is 1-based by age (oldest = v1).
   * The navigator renders each as a collapsed "Previous plan (vN)" section below the active lanes.
   */
  priorRevisions?: {
    decisionRecordId: string;
    revision: number;
    status: string;
    threads: PipelineThread[];
  }[];
}

/**
 * `no_job` = the job never entered the build lifecycle (still `open`, chatting/planning). It still
 * carries the brain's own `mainTasks` so the navigator's Main row can show the checklist pre-plan.
 */
export type PipelineState =
  | PipelineJob
  | { status: "no_job"; mainTasks?: TaskItem[]; mainDefaultFooter?: LaneDefaultFooter };

/** The Main brain session's task list, from either pipeline shape (`no_job` carries it too). */
export function pipelineMainTasks(
  pipeline: PipelineState | undefined,
): TaskItem[] {
  if (!pipeline) return [];
  return ("mainTasks" in pipeline ? pipeline.mainTasks : undefined) ?? [];
}

// ── Context files (`…/threads/:jobId/context`) ────────────────────────────────────────────────
/** One file in a `/context` bucket — mirrors the backend `ContextFile`. */
export interface ContextFile {
  name: string;
  size: number;
  /** ISO timestamp of last modification. */
  mtime: string;
}

/**
 * The thread's `/context` listing: `specs` (the plan — plan.md, decision-record.md, diagrams) and
 * `artifacts` (outputs — preview HTML, screenshots). A bucket is `[]` before the agent writes anything.
 */
export interface JobContext {
  specs: ContextFile[];
  /** System-GENERATED, read-only files (e.g. decision-record.md) — written by tool calls, never by hand. */
  generated: ContextFile[];
  artifacts: ContextFile[];
}

/** One `/context` file's content for the viewer (`…/context/file?path=…`). Mirrors the backend shape. */
export interface ContextFileContent {
  name: string;
  /** Path relative to the `/context` root, forward-slashed (e.g. `specs/plan.md`). */
  path: string;
  size: number;
  mtime: string;
  /** `text` → utf-8 in `content`; `base64` → binary (images) in `content`. */
  encoding: "text" | "base64";
  /** Best-effort mime by extension (e.g. `text/markdown`, `image/png`). */
  mime: string;
  content: string;
}

// ── Supervised services (`…/threads/:jobId/services`) ────────────────────────────────────────────
/**
 * One process the agent started via `atlas-svc run`, from its durable marker file. Mirrors the backend
 * `ServiceInfo`. The marker fields (pid/startedAt/log*) are a durable snapshot; `status` is a LIVE
 * liveness check the backend runs by execing a generation-gated `kill -0` probe into the container.
 */
export interface ServiceInfo {
  id: string;
  name: string;
  cmd: string;
  pid: number | null;
  pgid: number | null;
  startedAt: string | null;
  logBytes: number;
  logUpdatedAt: string | null;
  /**
   * Live liveness: `running` (process answered in the current container generation), `stopped` (marker
   * present but the process is gone — crash, `atlas-svc stop`, or a previous/absent container),
   * `unknown` (couldn't probe: no running container, null pgid/startedAt, or a transient exec failure).
   */
  status: "running" | "stopped" | "unknown";
  /** The port the service declared via `atlas-svc run --port` (null = not an HTTP service). */
  port: number | null;
  /**
   * Public HTTPS URL when the service is exposed (has a port, not opted out, running) and the
   * backend's preview feature is on; otherwise null (feature off, or nothing to expose).
   */
  url: string | null;
}

// ── UI job model ───────────────────────────────────────────────────────────────────────────────
/** The Job UI-presentation status set from handoff §7 (semantic dot colors). */
export type JobStatus =
  | "running"
  | "planning"
  | "plan_review"
  | "awaiting_approval"
  | "awaiting_ship_review"
  | "amending"
  | "done"
  | "triaging"
  | "cancelled"
  | "deleting";

/** UI kind badge — `feat`/`fix` from WireJobKind; `event` denotes a notification-seeded job;
 *  `onboard` is the Atlas-run repo-init (onboarding) job; `review` is an external-PR review job. */
export type JobKind = "feat" | "fix" | "event" | "onboard" | "review";

/** Observed PR lifecycle — the backend `jobs.pr_state`. Null (no `pr`) means no PR yet. */
export type PrState = "open" | "merged" | "closed";

/** Aggregate CI outcome for the PR head — backend `jobs.ci_status`. null = no checks reported ("no-CI").
 *  `skipped` = checks ran but all were skipped/neutral (never a failure). */
export type CiStatus = "success" | "failure" | "pending" | "skipped"; // null handled at the field level

/** Per-category CI check counts for the PR head — backend `jobs.ci_counts`. Parallel to {@link CiStatus};
 *  null exactly when the status is null (no checks reported). The four category counts sum to `total`. */
export type CiCounts = {
  failing: number;
  pending: number;
  passed: number;
  skipped: number;
  total: number;
};

/** The observed PR on a job — drives the sidebar's PR-status glyph (see `PrStatusIcon`). `mergeable` is
 *  GitHub's `mergeable_state` ('dirty' = merge conflict); `url` links to the PR. */
export interface InboxPr {
  state: PrState;
  /** GitHub PR number, shown on sidebar rows for cross-referencing. */
  number: number | null;
  mergeable: string | null;
  url: string | null;
}
