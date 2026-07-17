import type { DecisionRecord, Step } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import { renderBatchTask } from '../../prompt-kit/messages/batch-task';
import type { DriverThread } from '../driver-store.service';
import { extractOrientation } from '../thread-driver.service';

describe('extractOrientation', () => {
  it('pulls the trimmed body out of a <repo-orientation> block', () => {
    const text =
      'Here is the plan.\n<repo-orientation>\nMonorepo (pnpm). Backend in `backend/`.\n' +
      'Verify: `pnpm -C backend typecheck && pnpm -C backend test:unit`.\n</repo-orientation>\nDone.';
    expect(extractOrientation(text)).toBe(
      'Monorepo (pnpm). Backend in `backend/`.\n' +
        'Verify: `pnpm -C backend typecheck && pnpm -C backend test:unit`.',
    );
  });

  it('returns null when the block is absent, empty, or the input is undefined', () => {
    expect(extractOrientation(undefined)).toBeNull();
    expect(extractOrientation('a plan with no orientation block')).toBeNull();
    expect(extractOrientation('<repo-orientation>   </repo-orientation>')).toBeNull();
  });

  it('finds the block even when fenced in a code block and is case-insensitive', () => {
    const fenced = '```\n<REPO-ORIENTATION>layout: single package</REPO-ORIENTATION>\n```';
    expect(extractOrientation(fenced)).toBe('layout: single package');
  });

  it('caps a runaway body to keep the build task bounded', () => {
    const huge = 'x'.repeat(5000);
    const out = extractOrientation(`<repo-orientation>${huge}</repo-orientation>`)!;
    expect(out.length).toBeLessThanOrEqual(1501); // 1500 + the ellipsis
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('renderBatchTask orientation injection', () => {
  const record = {
    overview: 'Build X',
    decisions: [],
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
  ];
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
    condition: 'none',
    kind: 'builder',
    threadGroupId: 'tg-1',
    type: 'general',
    parentThreadId: null,
    startSha: null,
  };

  it('includes the orientation cheat-sheet, framed as subordinate to code + specs, when set', () => {
    const task = renderBatchTask(
      record,
      {
        ...baseThread,
        orientation: 'Monorepo — verify: pnpm -C backend test:unit',
      },
      steps,
    );
    expect(task).toContain('Repo orientation');
    expect(task).toContain('Monorepo — verify: pnpm -C backend test:unit');
    expect(task).toContain('remain authoritative');
  });

  it('omits the orientation section entirely when the thread has none', () => {
    const task = renderBatchTask(record, baseThread, steps);
    expect(task).not.toContain('Repo orientation');
  });
});
