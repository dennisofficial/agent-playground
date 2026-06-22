import { describe, expect, it, vi } from 'vitest';
import type { AtlasSlackSurface, SlackViewSubmission } from '../surface';
import { ONBOARD_SETUP_CALLBACK } from './onboarding-blocks';
import { OnboardingSlackService } from './onboarding-slack.service';
import type { OnboardingService, OnboardingStatus } from './onboarding.service';
import type { TenantCredentialStore } from './tenant-credential.store';

function makeSurface() {
  const posts: Array<{ channel: string; text: string; teamId?: string }> = [];
  const modals: Array<{ triggerId: string; teamId?: string }> = [];
  const surface = {
    post: vi.fn(async (channel: string, text: string, opts?: { teamId?: string }) => {
      posts.push({ channel, text, teamId: opts?.teamId });
      return 'ts-1';
    }),
    openModal: vi.fn(async (triggerId: string, _view: unknown, teamId?: string) => {
      modals.push({ triggerId, teamId });
    }),
  } as unknown as AtlasSlackSurface;
  return { surface, posts, modals };
}

function makeOnboarding(status: Partial<OnboardingStatus> = {}) {
  const binds: unknown[] = [];
  const full: OnboardingStatus = {
    teamId: 'T1',
    lifecycle: 'onboarding',
    steps: { installed: true, channelBound: false, llmKey: false, engineAuth: false, githubPat: false },
    missing: ['bind_channel', 'llm_key', 'github_pat'],
    ...status,
  };
  const onboarding = {
    bindChannel: vi.fn(async (a: unknown) => {
      binds.push(a);
      return { channelId: 'ch-1' };
    }),
    status: vi.fn(async () => full),
    tryActivate: vi.fn(async () => ({ ...full, lifecycle: 'active', missing: [] })),
  } as unknown as OnboardingService;
  return { onboarding, binds };
}

function makeStore() {
  const writes: Array<{ teamId: string; patch: Record<string, unknown> }> = [];
  const store = {
    write: vi.fn(async (teamId: string, patch: Record<string, unknown>) => {
      writes.push({ teamId, patch });
    }),
  } as unknown as TenantCredentialStore;
  return { store, writes };
}

function submission(values: Record<string, string>): SlackViewSubmission {
  const state = {
    repo: { repo_input: { value: values.repo ?? null } },
    github_pat: { pat_input: { value: values.pat ?? null } },
    anthropic_key: { key_input: { value: values.anthropic ?? null } },
  };
  return {
    type: 'view_submission',
    team: { id: 'T1' },
    view: {
      callback_id: ONBOARD_SETUP_CALLBACK,
      private_metadata: JSON.stringify({ teamId: 'T1', channelRef: 'C1' }),
      state: { values: state },
    },
  };
}

describe('OnboardingSlackService', () => {
  it('handleSetupSubmission writes secrets, binds the channel, activates, and confirms', async () => {
    const { surface, posts } = makeSurface();
    const { onboarding, binds } = makeOnboarding();
    const { store, writes } = makeStore();
    const svc = new OnboardingSlackService(surface, onboarding, store);

    await svc.handleSetupSubmission(
      submission({ repo: 'https://github.com/acme/web', pat: 'ghp_x', anthropic: 'sk-ant-1' }),
    );

    expect(writes[0].patch).toEqual({ anthropicApiKey: 'sk-ant-1', githubPat: 'ghp_x' });
    expect(binds[0]).toMatchObject({ teamId: 'T1', channelRef: 'C1', projectId: 'web', repoUrl: 'https://github.com/acme/web' });
    expect(onboarding.tryActivate).toHaveBeenCalledWith('T1');
    expect(posts[0].channel).toBe('C1');
    expect(posts[0].teamId).toBe('T1');
  });

  it('handleSetupSubmission with only a key writes no bind', async () => {
    const { surface } = makeSurface();
    const { onboarding, binds } = makeOnboarding();
    const { store, writes } = makeStore();
    const svc = new OnboardingSlackService(surface, onboarding, store);

    await svc.handleSetupSubmission(submission({ anthropic: 'sk-ant-1' }));
    expect(writes[0].patch).toEqual({ anthropicApiKey: 'sk-ant-1' });
    expect(binds).toHaveLength(0); // no repo → no channel bind
  });

  it('postSetupCard is a no-op once fully configured', async () => {
    const { surface, posts } = makeSurface();
    const { onboarding } = makeOnboarding({ lifecycle: 'active', missing: [] });
    const { store } = makeStore();
    const svc = new OnboardingSlackService(surface, onboarding, store);

    await svc.postSetupCard('T1', 'C1');
    expect(posts).toHaveLength(0);
  });
});
