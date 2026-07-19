import type {
  EJobStatus,
  EThreadCondition,
  EThreadStatus,
  JobView,
  TaskView,
} from '@workspace/shared';
/**
 * The backend "system is working" axis (`idle | turn | plan_review | build | master_review`) —
 * single-sourced in `@workspace/shared`. Carried on the realtime row; the dot itself reads `needsYou`.
 */
export const APPROVE_ACTION_ID = 'atlas_approval:approve';
export const REQUEST_CHANGES_ACTION_ID = 'atlas_approval:request_changes';
export const DENY_ACTION_ID = 'atlas_approval:deny';
export const VIEW_PLAN_ACTION_ID = 'atlas_approval:view_plan';
/** The SHIP-REVIEW gate's "Ship it" button — the SECOND human gate (after {@link APPROVE_ACTION_ID} at the
 *  plan stage), clicked while the job is `awaiting_ship_review`. POSTs to the SAME `/approve` endpoint with
 *  a `value` of just `{ jobId }` (no decision record — nothing to re-rule, just resume the build). */
export const SHIP_ACTION_ID = 'atlas_approval:ship';
/** The ship-review gate's manual "Amend build" retract — sends `awaiting_ship_review → amending`
 *  without discarding completed work (mirrors the Atlas `withdraw_ship` tool). POSTs to the SAME
 *  `/approve` endpoint with the ship card's `{ jobId }` value. Must match the backend string in
 *  `approval-blocks.ts`. */
export const RETRACT_SHIP_ACTION_ID = 'atlas_approval:retract_ship';
/** The brain's "Amend build?" PROPOSAL buttons (the `withdraw_ship` tool's card). Unlike the plain
 *  ship-card retract, the gate stays parked until the operator approves: `Approve amend` runs the operator
 *  retract AND wakes the brain; `Dismiss` just clears the card. Must match `approval-blocks.ts`. */
export const AMEND_APPROVE_ACTION_ID = 'atlas_approval:amend_approve';
export const AMEND_DISMISS_ACTION_ID = 'atlas_approval:amend_dismiss';
/** The MERGE gate's "Merge PR" button — the THIRD human gate (after Approve/Ship). Auto-merge auto-clicks
 *  the same gate. POSTs to the SAME `/approve` endpoint with a `value` of just `{ jobId }`. */
export const MERGE_ACTION_ID = 'atlas_approval:merge';
/** The `atlas-prod` gated-write approval card's buttons — `Execute write` runs the operator's approved
 *  single SQL statement on the DML-only `mcp_writer` role; `Deny` marks the ledger row rejected. Its button
 *  `value` carries `{ jobId, writeId }` (the `prod_maintenance_write` row id). Must match the backend
 *  strings in `approval-blocks.ts` exactly. */
export const DB_WRITE_APPROVE_ACTION_ID = 'atlas_approval:db_write_approve';
export const DB_WRITE_DENY_ACTION_ID = 'atlas_approval:db_write_deny';

export type ApprovalActionId =
  | typeof APPROVE_ACTION_ID
  | typeof REQUEST_CHANGES_ACTION_ID
  | typeof DENY_ACTION_ID
  | typeof SHIP_ACTION_ID
  | typeof RETRACT_SHIP_ACTION_ID
  | typeof AMEND_APPROVE_ACTION_ID
  | typeof AMEND_DISMISS_ACTION_ID
  | typeof MERGE_ACTION_ID
  | typeof DB_WRITE_APPROVE_ACTION_ID
  | typeof DB_WRITE_DENY_ACTION_ID;

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
  style: 'primary' | 'danger' | 'default';
  /** Link buttons (e.g. "View full plan") carry a URL; otherwise the click POSTs a verdict. */
  url?: string;
  /** Serialized `ApprovalActionMeta` (jobId + decisionRecordId) — sent back verbatim on /web/approve. */
  value: string;
}

/** One build thread's SELF-REPORTED verification, carried on the `ship` card (backend `ShipThreadVerification`
 *  in `web-approval-card.ts`). No judge grades it — `unverified` just flags a thread that asserted done with
 *  zero evidence, so the operator knows to eyeball it. */
export interface ShipThreadVerification {
  /** The build thread's title/brief. */
  title: string;
  /** Whether this thread asserted completion; `not_done` is advisory on the ship card. */
  status: 'done' | 'not_done';
  /** The thread's captured verification evidence (command + exit code + output tail). */
  verification: {
    kind: string;
    command: string;
    exitCode: number;
    outputTail: string;
  }[];
  /** The thread asserted done but reported no verification evidence at all. */
  unverified: boolean;
}

export interface WebApprovalCard {
  type: 'approval_card';
  jobId: string;
  decisionRecordId?: string;
  /**
   * `plan` (full ceremony) / `direct` (fast path) — the plan-stage approval, labels the list "Sections"
   * vs "Changes". `ship` — the ship-review gate (`Ship it` + `Back to building`;
   * `threads`/`decisions` empty). `amend` — the brain's "Amend build?" proposal at the ship gate
   * (`Approve amend` + `Dismiss`); the gate stays parked until approved. `merge` — the merge gate
   * (`Merge PR`), posted once the PR is GitHub-mergeable; `threads`/`decisions` empty. `db_write` — the
   * `atlas-prod` gated-write approval card (`Execute write` + `Deny`; `threads`/`decisions` empty); the
   * proposed statement rides `sql`/`estimatedRows`/`estimateLabel`/`error`.
   */
  kind?: 'plan' | 'direct' | 'ship' | 'amend' | 'merge' | 'db_write';
  title: string;
  summary: string;
  decisions: ApprovalDecision[];
  threads: string[];
  planUrl?: string;
  actions: WebCardAction[];
  /** ISO timestamp stamped when the operator clicks "Spin up preview" at the ship gate — hides the button. */
  previewRequestedAt?: string;
  /** `ship` card only — each build thread's self-reported verification evidence. Verbatim passthrough,
   *  no judge; rendered so the operator reviews the honest signal before shipping. */
  verifications?: ShipThreadVerification[];
  /** `db_write` card only — the exact proposed single SQL statement (the approved artifact). */
  sql?: string;
  /** `db_write` card only — the EXPLAIN-estimated row count, when available. */
  estimatedRows?: number;
  /** `db_write` card only — whether {@link estimatedRows} is a real planner `estimate`, `unavailable`
   *  (the SELECT-only role can't EXPLAIN this statement — expected/benign for DML), or the EXPLAIN
   *  surfaced a genuine statement `error`. Kept in sync with backend `webDbWriteApprovalCard`. */
  estimateLabel?: 'estimate' | 'unavailable' | 'error';
  /** `db_write` card only — a genuine EXPLAIN-time failure (syntax/bad column) so the operator sees the
   *  statement will fail BEFORE approving. Absent for a benign permission-denied preview. */
  error?: string;
}

export interface WebVerdictCard {
  type: 'verdict_card';
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
 * (+ optional free-text "Other"). The operator's pick POSTs an `answer_question` item to `…/threads/:jobId/message`.
 * When `answer` is set the card renders the compact answered state. Mirrors the backend `WebQuestionCard`.
 */
export interface WebQuestionCard {
  type: 'question_card';
  jobId: string;
  questionId: string;
  header?: string;
  question: string;
  decisionClass?: string;
  options: WebQuestionOption[];
  allowOther: boolean;
  answer?: string;
  answeredAt?: string;
  /** ISO time the answer was actually delivered (taken by the SDK/engine); absent while still in flight
   *  (drives the sending → landed transition once {@link answer} is set). */
  deliveredAt?: string;
  loggedDecision?: boolean;
  /** Set when the brain RETRACTED this still-unanswered question (`withdraw_question`) — renders a compact
   *  "withdrawn" state with no answer buttons. Terminal, like `answer`. */
  withdrawnAt?: string;
  withdrawnReason?: string;
  /** `'build'` cards (the driver's onboarding/build-flow questions) keep the immediate answer-question POST;
   *  `'brain'` (or absent, for older rows) cards stage in the composer tray for batched Send. */
  origin?: 'brain' | 'build';
}

/**
 * A secure SECRET request the onboarding brain posed via `request_secret` — rendered as a masked input.
 * The operator's value POSTs to `…/threads/:jobId/provide-secret`, which stores it ENCRYPTED + grants
 * it; the value is NEVER part of this card. When `provided_at` is set the card renders a compact "provided"
 * state. Mirrors the backend `WebSecretInputCard` (deliberately value-free).
 */
export interface WebSecretInputCard {
  type: 'secret_input_card';
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
  mcp?: { server: string; slot: 'header' | 'env'; key: string };
  provided_at?: string;
  delivered_at?: string;
  /** Set when the brain RETRACTED this still-unprovided request (`withdraw_secret_request`) — renders a
   *  compact "withdrawn" state with no input. Terminal, like `provided_at`. */
  withdrawnAt?: string;
  withdrawnReason?: string;
}

/**
 * A secure FILE request the onboarding brain posed via `request_file` — rendered as a file picker. The
 * operator's file is read as text and POSTs a `file_answered` item to `…/threads/:jobId/message`, which stores
 * the contents ENCRYPTED + grants them; the contents are NEVER part of this card. When `provided_at` is set the
 * card renders a compact "uploaded" state. Mirrors the backend `WebFileRequestCard` (deliberately value-free).
 */
export interface WebFileRequestCard {
  type: 'file_request_card';
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
  /** Present when the comment anchors to a diff line range (the GitHub-style gutter flow) rather than a
   *  free-text selection. Carries the old-file and/or new-file spans covered (both when the selection
   *  straddles deletions and additions) plus the signed diff `fragment` the operator selected. */
  lines?: {
    path: string;
    oldStart?: number;
    oldEnd?: number;
    newStart?: number;
    newEnd?: number;
    fragment: string;
  };
}

/**
 * A batch of inline review comments the operator sent via the highlight-and-comment flow ("Atlas Workspace
 * HiFi") — the operator selected text in the detail pane, noted it, and sent the queue as one message.
 * Rendered as a distinct right-aligned card (grouped by file); an optional trailing `message` is the
 * operator's typed prose, rendered as a normal bubble underneath. Mirrors the backend `review_comments_card`.
 */
export interface WebReviewCommentsCard {
  type: 'review_comments_card';
  items: WebReviewCommentItem[];
  message?: string;
}

/** One attachment the operator sent from the composer (image or file). Mirrors the backend `AttachmentCardItem`. */
export interface WebAttachmentItem {
  /** Display filename. */
  name: string;
  /** Bucket-relative `/context` path (`uploads/<name>`) — fetched from the streaming raw endpoint. */
  path: string;
  kind: 'image' | 'file';
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
  type: 'attachments_card';
  items: WebAttachmentItem[];
  /** The operator's optional typed caption, rendered as a normal bubble beneath the attachments. */
  message?: string;
}

/** One proposed server in an MCP-proposal card — the non-secret definition only (mirrors the backend). */
export interface WebMcpProposalServer {
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  /** Header names; `secret:true` marks a slot the owner fills after approval (via request_secret). */
  headers?: { name: string; secret?: boolean; value?: string }[];
  env?: { name: string; secret?: boolean; value?: string }[];
  /**
   * `"static"` (default when absent) = header/env credential slots. `"oauth"` = interactive OAuth 2.1 the
   * owner completes after approving by clicking Connect on the proposal card or in MCP settings (no secret slot to fill).
   */
  authKind?: 'static' | 'oauth';
  /** Non-secret OAuth knobs; only meaningful when `authKind==="oauth"`. */
  oauth?: {
    scope?: string;
    tokenAuthMethod?: 'none' | 'client_secret_post' | 'client_secret_basic';
  };
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
  type: 'mcp_proposal_card';
  jobId: string;
  requestId: string;
  repoId: string;
  /** Registration scope: `'org'` (every repo) or `'repo'` (this repo only). Absent on legacy cards ⇒ `'repo'`. */
  scope?: 'org' | 'repo';
  /** `register` new servers (default) or `remove` existing ones. Absent on legacy cards ⇒ `register`. */
  mode?: 'register' | 'remove';
  servers: WebMcpProposalServer[];
  approved_at?: string;
  committed?: string[];
}

/**
 * An owner-approvable SKILL proposal the brain posts. `install` = reuse a maintained skill from a git
 * marketplace (`installPreview` shows the exact resolved skill + any overwrite); `create` = a skill the brain
 * AUTHORED as real files (`preview` shows SKILL.md + the file tree); `remove` = delete a registered skill.
 * The OWNER approves at `…/jobs/:jobId/skill-proposals/:requestId/approve`. Mirrors the backend card.
 */
export interface WebSkillProposalCard {
  type: 'skill_proposal_card';
  jobId: string;
  requestId: string;
  repoId: string;
  scope: 'org' | 'repo';
  name: string;
  description: string;
  surfaces: ('brain' | 'build' | 'review')[];
  mode: 'create' | 'install' | 'remove';
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
  | WebSkillProposalCard;

/**
 * A lane's STATIC composer-footer default (`model · effort`) — what the footer shows BEFORE the lane's
 * first turn completes (no `turn_meta` to derive from yet). Backend-supplied per role (`laneDefaultFooter`),
 * so nothing is hardcoded in the frontend. No `context` field — occupancy is only known after a turn runs.
 */
export interface LaneDefaultFooter {
  engine: string;
  /** The Claude model id (`'opus'`) for claude lanes; absent for codex (no pinned model → labels "Codex"). */
  model?: string;
  /** Codex reasoning effort (`'xhigh'`), when the lane runs at one. */
  effort?: string;
}

/**
 * One review CHILD thread of a builder — a `review_agent` (one read-only review lens) or the single
 * `review_fix` (fix · apply · verify). Grouped under the SAME STAGE as its parent builder; related to it by
 * `parentId` (surfaced via the `threadChildren` selector — the web never needs the raw
 * parent link). A first-class thread row: its own status + streaming `lane` + (for review_agent) the
 * `lensId` and finding count. The navigator renders these directly as bare child-thread nodes (no synthetic
 * `rev:`/`fix:` ids); `lane` is the `autofix:<parentId>:<lensId>` / `autofix:<parentId>:fix` transcript lane
 * (unchanged wire format from before — only the role names changed, from `review_lens`/`post_review`).
 */
export interface PipelineReviewChild {
  id: string;
  role: 'review_agent' | 'review_fix';
  brief: string;
  status: EThreadStatus;
  /** The orthogonal condition overlay (skipped/failed/…) — independent of the linear {@link status} step. */
  condition: EThreadCondition;
  /** The lens id (`best_practices`/…) for a `review_agent` child; absent for `review_fix`. */
  lensId?: string;
  /** Findings this lens surfaced, or null until it has run (`review_fix` is always null). */
  findings: number | null;
  /** The transcript lane the child streams on (the SAME lane the backend turn writes). */
  lane: string;
  /** The lane's pre-turn footer default (`model · effort`). */
  defaultFooter: LaneDefaultFooter;
}

/**
 * One task in a thread group's LIVE, LLM-authored checklist — written server-side by the `task_create`/
 * `task_update` host-bridge tools (no fixed/expected set: `[]` just means nobody has created a task
 * yet, not "not started"). Owned by the THREAD GROUP (not a single thread), so it survives builder-leg
 * rotation within a build thread group. `dropped` is the `deleted` status.
 */
export interface TaskItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'dropped';
  /** The SDK task's longer description — shown under an in_progress task + as the row tooltip. */
  description?: string;
  /** Present-continuous label ("Resolving the router chain") shown while in_progress; falls back to subject. */
  activeForm?: string;
  /** Dependency edges — ids of tasks this one waits on. A PENDING task with an incomplete blocker renders
   *  BLOCKED (derived; the block clears when every blocker completes or is deleted). */
  blockedBy?: string[];
}

/** Immutable snapshot of the job that spawned another job, captured at create time. */
export type JobProvenance = { jobId: string; title: string | null };

/** A live blocker of a `blocked` job — one row per job it depends on. */
export type JobBlocker = {
  jobId: string;
  title: string | null;
  prState: string | null;
  status: EJobStatus;
};

/**
 * The job-workspace pipeline read — the job detail (`GET /jobs/:id`) paired with its flat task feed
 * (`GET /jobs/:id/tasks`). Components consume the shared DTOs (`JobView`/`ThreadGroupView`/`ThreadView`/
 * `TaskView`) directly; the navigator's derivations (task-join, role flags, `no_job` discrimination) and
 * the fields the backend read model doesn't emit yet live in `job-workspace/lib/pipeline-selectors.ts`.
 */
export interface Pipeline {
  job: JobView;
  tasks: TaskView[];
}

/** One file in a `/context` bucket — mirrors the backend `ContextFile`. */
export interface ContextFile {
  name: string;
  size: number;
  /** ISO timestamp of last modification. */
  mtime: string;
}

/**
 * The thread's `/context` listing: `specs` (the plan — plan.md, decision-record.md, diagrams),
 * `artifacts` (human-facing deliverables — preview HTML, mockups, reports), and `evidence` (live-run proof —
 * logs, screenshots, RESULTS.md). A bucket is `[]` before the agent writes anything.
 */
export interface JobContext {
  specs: ContextFile[];
  /** System-GENERATED, read-only files (e.g. decision-record.md) — written by tool calls, never by hand. */
  generated: ContextFile[];
  artifacts: ContextFile[];
  evidence: ContextFile[];
}

/** One `/context` file's content for the viewer (`…/context/file?path=…`). Mirrors the backend shape. */
export interface ContextFileContent {
  name: string;
  /** Path relative to the `/context` root, forward-slashed (e.g. `specs/plan.md`). */
  path: string;
  size: number;
  mtime: string;
  /** `text` → utf-8 in `content`; `base64` → binary (images) in `content`. */
  encoding: 'text' | 'base64';
  /** Best-effort mime by extension (e.g. `text/markdown`, `image/png`). */
  mime: string;
  content: string;
}

/** One hunk of a file's unified diff — mirrors the backend `JobDiffHunk` (`app/surface/job-diff.ts`).
 *  `lines` are sign-prefixed (`' '` context / `'+'` add / `'-'` del), offsets are 1-based file lines. */
export interface JobDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** One file's change in the accumulated job diff — mirrors the backend `JobDiffFile`. */
export interface JobDiffFile {
  path: string;
  /** Prior path for a rename; absent otherwise. */
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: JobDiffHunk[];
}

/** The accumulated multi-file diff for a job — mirrors the backend `JobDiff`. `truncated` when the diff
 *  exceeded the surface's size cap and some files/hunks were dropped. */
export interface JobDiff {
  files: JobDiffFile[];
  truncated: boolean;
}

/** One file's line totals/status in the cheap diff summary — mirrors the backend `JobDiffSummaryFile`. */
export interface JobDiffSummaryFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Numstat-only summary (no hunks) for the sidebar counts — mirrors the backend `JobDiffSummary`. */
export interface JobDiffSummary {
  files: JobDiffSummaryFile[];
}

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
  status: 'running' | 'stopped' | 'unknown';
  /** The port the service declared via `atlas-svc run --port` (null = not an HTTP service). */
  port: number | null;
  /**
   * Public HTTPS URL when the service is exposed (has a port, not opted out, running) and the
   * backend's preview feature is on; otherwise null (feature off, or nothing to expose).
   */
  url: string | null;
}

/** Observed PR lifecycle — the backend `jobs.pr_state`. Null (no `pr`) means no PR yet. */
export type PrState = 'open' | 'merged' | 'closed';

/** Aggregate CI outcome for the PR head — backend `jobs.ci_status`. null = no checks reported ("no-CI").
 *  `skipped` = checks ran but all were skipped/neutral (never a failure). */
export type CiStatus = 'success' | 'failure' | 'pending' | 'skipped'; // null handled at the field level

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
