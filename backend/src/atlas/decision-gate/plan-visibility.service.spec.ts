import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type {
  ChatSurface,
  InboundChatMessage,
  PostOptions,
} from '../surface';
import type { DecisionClassification } from './decision-gate.types';
import {
  PlanVisibilityService,
  renderSectionPlan,
} from './plan-visibility.service';

class FakeSurface implements ChatSurface {
  readonly name = 'fake';
  readonly inbound$ = new Subject<InboundChatMessage>();
  readonly posts: Array<{ channel: string; text: string; opts?: PostOptions }> = [];
  async post(channel: string, text: string, opts?: PostOptions): Promise<string | undefined> {
    this.posts.push({ channel, text, ...(opts ? { opts } : {}) });
    return 'ts-1';
  }
  async react(): Promise<void> {}
  async unreact(): Promise<void> {}
}

const covered: DecisionClassification = {
  verdict: 'covered',
  decisionClass: 'cross_cutting',
  reason: 'Reuses the chosen auth guard.',
  via: 'rule',
  coveredBy: 'Auth via JWT guard',
};
const proceeding: DecisionClassification = {
  verdict: 'proceed',
  reason: 'Renamed a local helper.',
  via: 'rule',
};
const ask: DecisionClassification = {
  verdict: 'ask',
  decisionClass: 'data_model',
  reason: 'New column — parked.',
  via: 'rule',
};

describe('renderSectionPlan', () => {
  it('renders title + plan, and surfaces covered/proceed decisions but NOT ask', () => {
    const text = renderSectionPlan({
      channel: 'C1',
      threadTs: 'root',
      title: 'Backend',
      plan: 'Phase 1: client. Phase 2: handler.',
      decisions: [covered, proceeding, ask],
    });
    expect(text).toContain('Plan — Backend');
    expect(text).toContain('Phase 1: client.');
    expect(text).toContain('Decisions made autonomously');
    expect(text).toContain('Reuses the chosen auth guard.');
    expect(text).toContain('per "Auth via JWT guard"');
    expect(text).toContain('Renamed a local helper.');
    // The ask-class decision is NOT surfaced here (it goes through park-and-ask).
    expect(text).not.toContain('New column — parked.');
  });

  it('omits the decisions block when there are none to surface', () => {
    const text = renderSectionPlan({
      channel: 'C1',
      title: 'Frontend',
      plan: 'Build the page.',
      decisions: [ask],
    });
    expect(text).not.toContain('Decisions made autonomously');
  });
});

describe('PlanVisibilityService', () => {
  it('posts into the thread and returns the ts (non-blocking)', async () => {
    const surface = new FakeSurface();
    const svc = new PlanVisibilityService(surface);
    const ts = await svc.postSectionPlan({
      channel: 'C1',
      threadTs: 'root',
      title: 'Backend',
      plan: 'do the thing',
    });
    expect(ts).toBe('ts-1');
    expect(surface.posts[0]?.opts?.threadTs).toBe('root');
    expect(surface.posts[0]?.text).toContain('Plan — Backend');
  });

  it('swallows a post failure (visibility never breaks the pipeline)', async () => {
    const surface = new FakeSurface();
    surface.post = async () => {
      throw new Error('slack down');
    };
    const svc = new PlanVisibilityService(surface);
    await expect(
      svc.postSectionPlan({ channel: 'C1', title: 'X', plan: 'y' }),
    ).resolves.toBeUndefined();
  });
});
