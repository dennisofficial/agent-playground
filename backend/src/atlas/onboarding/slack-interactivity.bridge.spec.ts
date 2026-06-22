import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionApprovalService } from '../brain';
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  type AtlasSlackSurface,
  type SlackBlockAction,
  type SlackLifecycleEvent,
  type SlackViewSubmission,
} from '../surface';
import { ONBOARD_SETUP_ACTION_ID } from './onboarding-blocks';
import type { OnboardingSlackService } from './onboarding-slack.service';
import { SlackInteractivityBridge } from './slack-interactivity.bridge';

function makeHarness() {
  const interactive$ = new Subject<SlackBlockAction>();
  const viewSubmission$ = new Subject<SlackViewSubmission>();
  const lifecycle$ = new Subject<SlackLifecycleEvent>();
  const updates: unknown[] = [];
  const surface = {
    interactive$,
    viewSubmission$,
    lifecycle$,
    update: vi.fn(async (...a: unknown[]) => {
      updates.push(a);
    }),
  } as unknown as AtlasSlackSurface;

  const resolves: Array<{ jobId: string; verdict: string; ruledBy: string }> = [];
  const approvals = {
    resolve: vi.fn((jobId: string, verdict: string, ruledBy: string) => {
      resolves.push({ jobId, verdict, ruledBy });
      return true;
    }),
  } as unknown as DecisionApprovalService;

  const onboarding = {
    openSetupModal: vi.fn(async () => undefined),
    handleSetupSubmission: vi.fn(async () => undefined),
    postSetupCard: vi.fn(async () => undefined),
  } as unknown as OnboardingSlackService;

  const bridge = new SlackInteractivityBridge(surface, approvals, onboarding);
  bridge.onApplicationBootstrap();
  return { bridge, interactive$, viewSubmission$, lifecycle$, resolves, updates, approvals, onboarding };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SlackInteractivityBridge', () => {
  it('resolves an approval verdict from a block-action click and repaints the card', async () => {
    const h = makeHarness();
    h.interactive$.next({
      type: 'block_actions',
      user: { id: 'U-DENNIS' },
      team: { id: 'T1' },
      channel: { id: 'C1' },
      message: { ts: 'card-ts', blocks: [{ type: 'actions' }] },
      actions: [{ action_id: APPROVE_ACTION_ID, value: JSON.stringify({ jobId: 'job-1' }) }],
    });
    await tick();
    expect(h.resolves[0]).toEqual({ jobId: 'job-1', verdict: 'approve', ruledBy: 'U-DENNIS' });
    expect(h.updates).toHaveLength(1); // card repainted to the verdict
  });

  it('maps the deny button to a deny verdict', async () => {
    const h = makeHarness();
    h.interactive$.next({
      type: 'block_actions',
      user: { id: 'U' },
      actions: [{ action_id: DENY_ACTION_ID, value: JSON.stringify({ jobId: 'job-2' }) }],
    });
    await tick();
    expect(h.resolves[0].verdict).toBe('deny');
  });

  it('routes an onboarding button to the setup modal', async () => {
    const h = makeHarness();
    h.interactive$.next({
      type: 'block_actions',
      team: { id: 'T1' },
      channel: { id: 'C1' },
      trigger_id: 'trig',
      actions: [{ action_id: ONBOARD_SETUP_ACTION_ID }],
    });
    await tick();
    expect(h.onboarding.openSetupModal).toHaveBeenCalledOnce();
    expect(h.resolves).toHaveLength(0); // not an approval
  });

  it('routes a secret view_submission to the onboarding handler', async () => {
    const h = makeHarness();
    h.viewSubmission$.next({ type: 'view_submission', view: { callback_id: 'atlas_secret:setup' } });
    await tick();
    expect(h.onboarding.handleSetupSubmission).toHaveBeenCalledOnce();
  });

  it('posts the setup card when the bot joins a channel', async () => {
    const h = makeHarness();
    h.lifecycle$.next({ kind: 'bot_joined', teamId: 'T1', channel: 'C1' });
    await tick();
    expect(h.onboarding.postSetupCard).toHaveBeenCalledWith('T1', 'C1');
  });
});
