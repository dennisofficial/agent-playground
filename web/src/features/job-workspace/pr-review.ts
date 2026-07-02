import type { JobMessage } from '@/lib/api/job-api';
import type { TaskItem } from '@/lib/api/types';

/**
 * PR REVIEW — the single job-level master-review thread that runs once every build thread finishes, right
 * before the pull request opens (design handoff "thread navigation": the pinned FINAL REVIEW row). It is
 * one Claude orchestrator session riding the shared transcript spine on the stable `pr-review:<jobId>`
 * lane; every durable block it emits is tagged `meta.prReviewId = jobId` (see backend
 * `build-ship.service.ts`), and a `pr_review_anchor` row marks where in Main the pass started. Its own
 * LLM-authored task list (master review → apply fixes → verify) is server-folded into `job.tasks`, with
 * the coarse pass status on `job.prReviewStatus` — the pinned navigator row renders both.
 */

/** The navigator node (`?lane=`) that opens the PR Review transcript in the LEFT pane, like a thread. */
export const PR_REVIEW_NODE = 'pr-review';

/** The live-stream lane the PR Review session rides (matches the backend `prReviewLane`). */
export const prReviewLane = (jobId: string): string => `pr-review:${jobId}`;

export interface PrReviewIndex {
  /** `message.ts` of every block the PR Review session emitted (peel these out of Main). */
  childKeys: Set<string>;
  /** `message.ts` of every `pr_review_anchor` row (peeled from Main too — the pinned nav row is the
   *  surface; the stage's plain "PR Review — …" notice line still renders as the in-conversation signal). */
  anchorKeys: Set<string>;
}

/** Index the PR Review session's blocks so Main can peel them and the `pr-review` lane can render them. */
export function indexPrReviewBlocks(messages: JobMessage[]): PrReviewIndex {
  const childKeys = new Set<string>();
  const anchorKeys = new Set<string>();
  for (const m of messages) {
    if (m.kind === 'pr_review_anchor') {
      anchorKeys.add(m.ts);
      continue;
    }
    if (typeof m.meta?.prReviewId === 'string') childKeys.add(m.ts);
  }
  return { childKeys, anchorKeys };
}

/** The pinned row's presentation status, from the coarse pass status (+ null = not started → gated). */
export type PrReviewDisplay = 'queued' | 'reviewing' | 'fixing' | 'verifying' | 'done' | 'failed';

/**
 * Derive the pinned row's status word. `running` covers the whole session, so the finer sub-state
 * ("reviewing"/"fixing"/"verifying") comes from whichever task is currently `in_progress` — the
 * orchestrator's own task list is already that detailed (see `PipelineJob.prReviewStatus`).
 */
export function prReviewDisplay(
  status: 'queued' | 'running' | 'opened' | 'failed' | null,
  tasks: TaskItem[],
): PrReviewDisplay {
  if (status === 'opened') return 'done';
  if (status === 'failed') return 'failed';
  if (status !== 'running') return 'queued';
  const active = tasks.find((t) => t.status === 'in_progress');
  const subject = active?.subject.toLowerCase() ?? '';
  if (subject.includes('fix')) return 'fixing';
  if (subject.includes('verif') || subject.includes('build') || subject.includes('test')) return 'verifying';
  return 'reviewing';
}
