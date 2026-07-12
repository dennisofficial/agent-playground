import { describe, expect, it } from 'vitest';
import {
  COMMIT_AND_PUSH_INSTRUCTION,
  renderBatchTask,
  renderMasterReviewTask,
} from './thread-driver.service';
import type { DriverThread } from './driver-store.service';
import type { ResolvedRepo } from './repo-resolver';
import type { DecisionRecord, Step } from '../domain';
import { SANDBOX_RESET_NOTICE, BG_TASK_CAP_NOTICE } from '../engine/engine.types';
import { SVC_NUDGE_TEXT } from '../engine/engine-core';

/**
 * Golden-snapshot baseline for the driver/engine PROSE strings sent into build/review/gate turns. Every
 * snapshot captures CURRENT output verbatim — a regression pass, not a spec of intent (see the sibling
 * `prompt-kit` snapshot specs). `CONTINUATION_PREAMBLE` is colocated in `../brain` instead (see
 * `continuation-preamble-snapshot.spec.ts`) to keep this file's import graph light.
 */

const record: DecisionRecord = {
  overview: 'Build the widget catalog end-to-end.',
  decisions: [
    { decisionClass: 'data_model', title: 'Use pgvector', ruling: 'HNSW index on embeddings' },
    { decisionClass: 'cross_cutting', title: 'Ship in-sandbox', ruling: 'Atlas opens the PR itself' },
  ],
} as unknown as DecisionRecord;

const steps: Step[] = [
  {
    id: 's1',
    threadId: 't1',
    jobId: 'j1',
    ordinal: 10,
    title: 'Step one',
    brief: 'do the thing',
    stage: 'build',
    status: 'pending',
    sessionId: null,
    batchOrdinal: null,
    legOrdinal: 1,
    commitSha: null,
  },
] as Step[];

const baseThread: DriverThread = {
  id: 't1',
  jobId: 'j1',
  orgId: 'o1',
  ordinal: 10,
  brief: 'A build thread',
  plan: null,
  orientation: null,
  handoffIn: null,
  handoffOut: null,
  status: 'executing',
  kind: 'builder',
  parentThreadId: null,
  startSha: null,
} as DriverThread;

const repo = { defaultBranch: 'main' } as ResolvedRepo;

describe('driver/engine prose golden snapshots', () => {
  it('COMMIT_AND_PUSH_INSTRUCTION', async () => {
    await expect(COMMIT_AND_PUSH_INSTRUCTION).toMatchFileSnapshot(
      './__snapshots__/commit-and-push-instruction.txt',
    );
  });

  it('renderBatchTask — no decision record (simplest deterministic baseline)', async () => {
    await expect(renderBatchTask(null, baseThread, steps)).toMatchFileSnapshot(
      './__snapshots__/render-batch-task-no-record.txt',
    );
  });

  it('renderBatchTask — with a decision record (decisions branch baselined too)', async () => {
    await expect(renderBatchTask(record, baseThread, steps)).toMatchFileSnapshot(
      './__snapshots__/render-batch-task-with-record.txt',
    );
  });

  it('renderMasterReviewTask', async () => {
    await expect(renderMasterReviewTask(record, repo)).toMatchFileSnapshot(
      './__snapshots__/render-master-review-task.txt',
    );
  });

  it('SANDBOX_RESET_NOTICE', async () => {
    await expect(SANDBOX_RESET_NOTICE).toMatchFileSnapshot('./__snapshots__/sandbox-reset-notice.txt');
  });

  it('BG_TASK_CAP_NOTICE', async () => {
    await expect(BG_TASK_CAP_NOTICE).toMatchFileSnapshot('./__snapshots__/bg-task-cap-notice.txt');
  });

  it('SVC_NUDGE_TEXT', async () => {
    await expect(SVC_NUDGE_TEXT).toMatchFileSnapshot('./__snapshots__/svc-nudge-text.txt');
  });
});
