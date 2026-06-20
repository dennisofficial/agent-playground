import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChatSurface,
  DecisionApprovalCard,
  InboundChatMessage,
  PostOptions,
} from '../surface';
import { DecisionApprovalService } from './decision-approval.service';

class FakeSurface implements ChatSurface {
  readonly name = 'fake';
  readonly inbound$ = new Subject<InboundChatMessage>();
  readonly posts: Array<{ channel: string; text: string; opts?: PostOptions }> = [];
  private seq = 0;
  async post(channel: string, text: string, opts?: PostOptions): Promise<string | undefined> {
    this.posts.push({ channel, text, ...(opts ? { opts } : {}) });
    return `card-${++this.seq}`;
  }
  async react(): Promise<void> {}
  async unreact(): Promise<void> {}
}

const CARD: DecisionApprovalCard = {
  jobId: 'job-1',
  decisionRecordId: 'dr-1',
  title: 'CSV export',
  summary: 'Add CSV export.',
  sections: ['Backend', 'Frontend'],
};

describe('DecisionApprovalService', () => {
  let surface: FakeSurface;
  let svc: DecisionApprovalService;

  beforeEach(() => {
    surface = new FakeSurface();
    svc = new DecisionApprovalService(surface);
  });

  afterEach(() => svc.onModuleDestroy());

  it('posts the approval card (with blocks) into the thread', async () => {
    const handle = await svc.request({ channel: 'C1', threadTs: 'root-1' }, CARD);
    expect(surface.posts).toHaveLength(1);
    expect(surface.posts[0]?.channel).toBe('C1');
    expect(surface.posts[0]?.opts?.threadTs).toBe('root-1');
    expect(Array.isArray(surface.posts[0]?.opts?.blocks)).toBe(true);
    expect(handle.jobId).toBe('job-1');
    expect(svc.pendingCount).toBe(1);
  });

  it('resolves the verdict promise on approve', async () => {
    const handle = await svc.request({ channel: 'C1', threadTs: 'root-1' }, CARD);
    expect(svc.resolve('job-1', 'approve', 'U-dennis')).toBe(true);
    const resolution = await handle.verdict;
    expect(resolution.verdict).toBe('approve');
    expect(resolution.ruledBy).toBe('U-dennis');
    expect(svc.pendingCount).toBe(0);
  });

  it('carries the change-request note through on request_changes', async () => {
    const handle = await svc.request({ channel: 'C1' }, CARD);
    svc.resolve('job-1', 'request_changes', 'U-dennis', 'use streaming');
    const resolution = await handle.verdict;
    expect(resolution.verdict).toBe('request_changes');
    expect(resolution.note).toBe('use streaming');
  });

  it('resolve on an unknown / already-resolved job is a no-op (returns false)', async () => {
    await svc.request({ channel: 'C1' }, CARD);
    expect(svc.resolve('job-1', 'approve', 'U')).toBe(true);
    expect(svc.resolve('job-1', 'deny', 'U')).toBe(false); // already resolved
    expect(svc.resolve('nonexistent', 'approve', 'U')).toBe(false);
  });

  it('cancel rejects a pending approval', async () => {
    const handle = await svc.request({ channel: 'C1' }, CARD);
    svc.cancel('job-1', 'job dropped');
    await expect(handle.verdict).rejects.toThrow('job dropped');
    expect(svc.pendingCount).toBe(0);
  });
});
