import { describe, expect, it } from 'vitest';
import {
  pipelineStateSignature,
  renderAwarenessPrefix,
  renderPipelineStateSummary,
  type PipelineMarker,
} from '../pipeline-awareness';

/**
 * Unit tests for the PURE half of passive pipeline-milestone awareness — the signature/summary/prefix
 * functions the brain's flush seam composes. No I/O. The store's durable drain/dedup is covered by the
 * int test; here we lock the rendering + the "only re-state on a real change" signature contract.
 */

const RUNNING_STATE = {
  jobId: 't1',
  status: 'running',
  decisionRecordId: 'dr-1',
  prUrl: null,
  threads: [
    {
      id: 'sec-aaaaaaaa',
      ordinal: 1,
      brief: 'Backend',
      status: 'done',
      steps: [
        { id: 'ph-1111', stage: 'done', status: 'done' },
        { id: 'ph-2222', stage: 'done', status: 'done' },
      ],
    },
    {
      id: 'sec-bbbbbbbb',
      ordinal: 2,
      brief: 'Frontend',
      status: 'executing',
      steps: [{ id: 'ph-3333', stage: 'build', status: 'building' }],
    },
  ],
};

describe('pipelineStateSignature', () => {
  it('returns null when there is no build to report (no_job / open / missing)', () => {
    expect(pipelineStateSignature({ status: 'no_job' })).toBeNull();
    expect(pipelineStateSignature({ status: 'open' } as never)).toBeNull();
    expect(pipelineStateSignature(null)).toBeNull();
    expect(pipelineStateSignature(undefined)).toBeNull();
  });

  it('is deterministic for the same state', () => {
    expect(pipelineStateSignature(RUNNING_STATE)).toBe(pipelineStateSignature(RUNNING_STATE));
  });

  it('changes when a thread status advances (the in-place overwrite the snapshot CAN see)', () => {
    const before = pipelineStateSignature(RUNNING_STATE);
    const after = pipelineStateSignature({
      ...RUNNING_STATE,
      threads: [RUNNING_STATE.threads[0], { ...RUNNING_STATE.threads[1], status: 'done' }],
    });
    expect(after).not.toBe(before);
  });

  it('changes when the decision record is replaced (re-proposal → fresh watermark, no stale ordinal)', () => {
    const before = pipelineStateSignature(RUNNING_STATE);
    const after = pipelineStateSignature({
      ...RUNNING_STATE,
      decisionRecordId: 'dr-2',
    });
    expect(after).not.toBe(before);
  });

  it('changes when a PR opens', () => {
    const before = pipelineStateSignature(RUNNING_STATE);
    const after = pipelineStateSignature({
      ...RUNNING_STATE,
      prUrl: 'https://gh/pr/9',
    });
    expect(after).not.toBe(before);
  });
});

describe('renderPipelineStateSummary', () => {
  it('renders the net current state — status, each thread, and step progress', () => {
    const summary = renderPipelineStateSummary(RUNNING_STATE);
    expect(summary).toContain('Current build state: running.');
    expect(summary).toContain('Thread 1 "Backend": done [2/2 steps done]');
    expect(summary).toContain('Thread 2 "Frontend": executing [0/1 steps done]');
  });

  it('includes the PR url when present', () => {
    const summary = renderPipelineStateSummary({
      ...RUNNING_STATE,
      prUrl: 'https://gh/pr/9',
    });
    expect(summary).toContain('PR: https://gh/pr/9');
  });

  it('is empty when there is no build', () => {
    expect(renderPipelineStateSummary({ status: 'no_job' })).toBe('');
  });
});

describe('renderAwarenessPrefix', () => {
  const markers: PipelineMarker[] = [
    {
      id: 'a',
      text: 'Your plan was approved by the operator.',
      at: '2026-06-26T00:00:00.000Z',
    },
    {
      id: 'b',
      text: 'The build pipeline has started running the approved plan.',
      at: '2026-06-26T00:00:01.000Z',
    },
  ];

  it('frames the prefix as informational (not a command) and lists every marker', () => {
    const prefix = renderAwarenessPrefix(markers, null);
    expect(prefix).toContain('informational, no action needed unless asked');
    expect(prefix).toContain('- Your plan was approved by the operator.');
    expect(prefix).toContain('- The build pipeline has started running the approved plan.');
  });

  it('appends the net-state summary when one is conveyed', () => {
    const prefix = renderAwarenessPrefix(markers, 'Current build state: running.');
    expect(prefix).toContain('Current build state: running.');
  });

  it('returns the header + summary even with no markers (a pure state change)', () => {
    const prefix = renderAwarenessPrefix([], 'Current build state: running.');
    expect(prefix).toContain('informational, no action needed');
    expect(prefix).toContain('Current build state: running.');
  });

  it('returns empty when there is nothing to convey', () => {
    expect(renderAwarenessPrefix([], null)).toBe('');
  });
});
