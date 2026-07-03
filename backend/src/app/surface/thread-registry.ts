/**
 * THE THREAD REGISTRY — the single source of truth for "what thread kinds exist".
 *
 * A Job has many conversational **threads** — the Main brain, the per-track builders, the auto-fix
 * review-lens + fix passes, the terminal ship turn, and the Codex plan-review dialogue. They already share
 * one transport (the {@link TurnHarnessFactory} spine); what USED to be scattered was the glue AROUND that
 * transport: each feature built its own lane string, and `turn-harness` kept a SECOND independent switch
 * (`taskScopeFor`) over those same lane patterns. This registry unifies both — one descriptor per kind
 * owns its lane format, the inverse match, its task-fold scope, and its input policy.
 *
 * Vocabulary note: a *thread* (the concept) has a *lane* (its wire streaming key — a byte-identical string,
 * unchanged from before, still what Redis stream keys + SSE routes + the web `lane=` props use).
 */

/**
 * The scope a task event folds into: a build thread's own list (`thread` → `threads.tasks`) or the Main
 * brain session's list (`main` → `jobs.main_tasks`). (The old `job` → `jobs.tasks` PR-Review scope was
 * dropped when master review became a normal build thread.)
 */
export interface TaskScope {
  kind: 'thread' | 'main';
  id: string;
}

/** Every kind of thread a job can run. */
export type ThreadKind =
  | 'main' // the job brain session — the operator conversation. Lane: `main`.
  | 'builder' // a build/track thread's own session. Lane: `thread:<threadId>`. (Master review is a builder too.)
  | 'autofix-stage' // the auto-fix stage's aggregate/card lane. Lane: `autofix:<autofixId>`.
  | 'autofix-lens' // one review lens's sub-lane. Lane: `autofix:<autofixId>:<lensId>`.
  | 'autofix-fix' // the auto-fix fix turn's sub-lane. Lane: `autofix:<autofixId>:fix`.
  | 'ship' // the terminal in-sandbox open-PR turn. Lane: `ship:<jobId>`.
  | 'codex-review'; // the Codex plan-review dialogue. Lane: `codex-review:<jobId>`.

/**
 * Who holds the input side of a thread — uniform harness-wise (one `postToThread` seam), differing only by
 * policy: `operator` = the human can post (Main, shows a composer); `agent` = another agent drives it
 * (Codex review — Atlas replies via a tool, no operator composer); `none` = read-only observation.
 */
export type ThreadInput = 'operator' | 'agent' | 'none';

/** One thread kind's contract: lane construction + inverse, task-fold scope, input policy. */
export interface ThreadDescriptor {
  kind: ThreadKind;
  input: ThreadInput;
  /** Build the wire lane string from this kind's ids (e.g. `(autofixId, lensId) => autofix:…:…`). */
  lane(...ids: string[]): string;
  /** Inverse of {@link lane}: capture this kind's ids from a lane string, or `null` if it doesn't own it. */
  match(lane: string): string[] | null;
  /** Which entity's tasks column a `TaskCreate`/`TaskUpdate` on this lane folds into (`null` = not tracked). */
  taskScope(ctx: { jobId: string; ids: string[] }): TaskScope | null;
}

const AUTOFIX_LENS_RE = /^autofix:([^:]+):((?!fix$).+)$/; // `autofix:<id>:<lensId>` — excludes the `:fix` turn
const AUTOFIX_FIX_RE = /^autofix:([^:]+):fix$/;
const AUTOFIX_STAGE_RE = /^autofix:([^:]+)$/;

export const THREAD_REGISTRY: readonly ThreadDescriptor[] = [
  {
    kind: 'main',
    input: 'operator',
    lane: () => 'main',
    match: (lane) => (lane === 'main' ? [] : null),
    taskScope: ({ jobId }) => ({ kind: 'main', id: jobId }),
  },
  {
    kind: 'builder',
    input: 'none',
    lane: (threadId) => `thread:${threadId}`,
    match: (lane) => (lane.startsWith('thread:') ? [lane.slice('thread:'.length)] : null),
    taskScope: ({ ids }) => ({ kind: 'thread', id: ids[0] }),
  },
  {
    kind: 'autofix-lens',
    input: 'none',
    lane: (autofixId, lensId) => `autofix:${autofixId}:${lensId}`,
    match: (lane) => {
      const m = AUTOFIX_LENS_RE.exec(lane);
      return m ? [m[1], m[2]] : null;
    },
    taskScope: () => null,
  },
  {
    kind: 'autofix-fix',
    input: 'none',
    lane: (autofixId) => `autofix:${autofixId}:fix`,
    match: (lane) => {
      const m = AUTOFIX_FIX_RE.exec(lane);
      return m ? [m[1]] : null;
    },
    taskScope: () => null,
  },
  {
    kind: 'autofix-stage',
    input: 'none',
    lane: (autofixId) => `autofix:${autofixId}`,
    match: (lane) => {
      const m = AUTOFIX_STAGE_RE.exec(lane);
      return m ? [m[1]] : null;
    },
    taskScope: () => null,
  },
  {
    kind: 'ship',
    input: 'none',
    lane: (jobId) => `ship:${jobId}`,
    match: (lane) => (lane.startsWith('ship:') ? [lane.slice('ship:'.length)] : null),
    taskScope: () => null,
  },
  {
    kind: 'codex-review',
    input: 'agent',
    lane: (jobId) => `codex-review:${jobId}`,
    match: (lane) => (lane.startsWith('codex-review:') ? [lane.slice('codex-review:'.length)] : null),
    taskScope: () => null,
  },
];

const BY_KIND = new Map<ThreadKind, ThreadDescriptor>(THREAD_REGISTRY.map((d) => [d.kind, d]));

/** Build the wire lane string for a thread kind. Replaces the scattered per-feature lane helpers. */
export function laneFor(kind: ThreadKind, ...ids: string[]): string {
  const d = BY_KIND.get(kind);
  if (!d) throw new Error(`unknown thread kind: ${kind}`);
  return d.lane(...ids);
}

/** Find the descriptor (and captured ids) that owns a lane string, or `null`. */
export function descriptorForLane(lane: string): { descriptor: ThreadDescriptor; ids: string[] } | null {
  for (const descriptor of THREAD_REGISTRY) {
    const ids = descriptor.match(lane);
    if (ids) return { descriptor, ids };
  }
  return null;
}

/**
 * Resolve which entity's tasks column a task event on `lane` folds into. Replaces the hand-written switch
 * that lived in {@link TurnHarnessFactory}. `jobId` is needed because the `main` lane encodes no id.
 */
export function taskScopeForLane(lane: string, jobId: string): TaskScope | null {
  const hit = descriptorForLane(lane);
  return hit ? hit.descriptor.taskScope({ jobId, ids: hit.ids }) : null;
}
