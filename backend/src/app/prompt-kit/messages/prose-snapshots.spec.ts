import { describe, expect, it } from 'vitest';
import {
  COMMIT_AND_PUSH_INSTRUCTION,
  renderBatchTask,
  renderMasterReviewTask,
} from './batch-task';
import type { DriverThread } from '../../driver/driver-store.service';
import type { ResolvedRepo } from '../../driver/repo-resolver';
import type { DecisionRecord, Step } from '@shared/domain';

/**
 * Golden-snapshot baseline for the driver-run turn PROSE strings sent into build/review/gate turns. Every
 * snapshot captures CURRENT output verbatim — a regression pass, not a spec of intent (see the sibling
 * `prompt-kit` snapshot specs). The sibling `driver/prompt-prose-snapshots.spec.ts` covers the engine consts
 * that stayed behind (`SANDBOX_RESET_NOTICE`, `BG_TASK_CAP_NOTICE`, `SVC_NUDGE_TEXT`).
 */

const record: DecisionRecord = {
  overview: 'Build the widget catalog end-to-end.',
  decisions: [
    {
      decisionClass: 'data_model',
      title: 'Use pgvector',
      ruling: 'HNSW index on embeddings',
    },
    {
      decisionClass: 'cross_cutting',
      title: 'Ship in-sandbox',
      ruling: 'Atlas opens the PR itself',
    },
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
  status: 'idle',
  kind: 'builder',
  threadGroupId: 't1',
  parentThreadId: null,
  startSha: null,
} as DriverThread;

const repo = { defaultBranch: 'main' } as ResolvedRepo;

describe('driver-run turn prose golden snapshots', () => {
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
    await expect(
      renderBatchTask(record, baseThread, steps),
    ).toMatchFileSnapshot('./__snapshots__/render-batch-task-with-record.txt');
  });

  it('renderBatchTask — with a skill nudge (the <available_skills> block spliced in)', async () => {
    await expect(
      renderBatchTask(record, baseThread, steps, [
        { name: 'nestjs-best-practices', reason: 'backend NestJS work' },
      ]),
    ).toMatchFileSnapshot('./__snapshots__/render-batch-task-with-nudge.txt');
  });

  it('renderMasterReviewTask', async () => {
    await expect(renderMasterReviewTask(record, repo)).toMatchFileSnapshot(
      './__snapshots__/render-master-review-task.txt',
    );
  });
});
