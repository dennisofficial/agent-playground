import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceConfigStore } from '../../onboarding/workspace-config.store';
import type { InstallAwarenessFilter, InstallFilterVerdict } from '../install-awareness-filter';
import { ProfileAwarenessService } from '../profile-awareness.service';
import type {
  WorkspaceProfileService,
  WorkspaceProfileSnapshot,
} from '../workspace-profile.service';

const EMPTY_SNAPSHOT: WorkspaceProfileSnapshot = {
  mounts: [],
  setupScript: { present: false, length: 0 },
  previewRecipe: { present: false, length: 0 },
  secretFiles: [],
  mcpServers: [],
  skills: [],
  houseStyle: null,
};

function fakeConfigStore(transition: 'add' | 'remove' | null): WorkspaceConfigStore {
  return {
    applyToolingTransition: vi.fn().mockResolvedValue(transition),
  } as unknown as WorkspaceConfigStore;
}

function fakeProfile(snapshot: WorkspaceProfileSnapshot = EMPTY_SNAPSHOT): WorkspaceProfileService {
  return {
    describe: vi.fn().mockResolvedValue(snapshot),
    render: vi.fn().mockReturnValue('- Mounts: none'),
  } as unknown as WorkspaceProfileService;
}

function fakeFilter(opts: {
  verdict?: InstallFilterVerdict;
  throws?: boolean;
}): InstallAwarenessFilter {
  return {
    filter: vi.fn().mockImplementation(() => {
      if (opts.throws) return Promise.reject(new Error('boom'));
      return Promise.resolve(opts.verdict);
    }),
  };
}

const HANDLE_INPUT = {
  orgId: 'org-1',
  repoId: 'repo-1',
  jobId: 'job-1',
  sessionType: 'brain',
  command: 'pnpm add eslint',
};

describe('ProfileAwarenessService — Stage-2 filter wiring', () => {
  it('a fired transition + filter {suppress:true} → handle returns null (suppressed)', async () => {
    const filter = fakeFilter({
      verdict: { suppress: true, suggestion: '', reason: 'noise' },
    });
    const configStore = fakeConfigStore('add');
    const svc = new ProfileAwarenessService(configStore, fakeProfile(), filter);

    const text = await svc.handle(HANDLE_INPUT);

    expect(text).toBeNull();
    expect(configStore.applyToolingTransition).toHaveBeenCalledTimes(1);
    expect(filter.filter).toHaveBeenCalledTimes(1);
  });

  it('a fired transition + filter {suppress:false, suggestion} → Stage-1 text + the suggestion', async () => {
    const filter = fakeFilter({
      verdict: {
        suppress: false,
        suggestion: 'Add the eslint-review skill',
        reason: 'new lint tool',
      },
    });
    const svc = new ProfileAwarenessService(fakeConfigStore('add'), fakeProfile(), filter);

    const text = await svc.handle(HANDLE_INPUT);

    expect(text).toContain('[profile-awareness]');
    expect(text).toContain('pnpm:eslint');
    expect(text).toContain('Suggestion: Add the eslint-review skill');
  });

  it('a fired transition + filter {suppress:false, suggestion:""} → plain Stage-1 text, no "Suggestion:" line', async () => {
    const filter = fakeFilter({
      verdict: { suppress: false, suggestion: '', reason: 'nothing specific' },
    });
    const svc = new ProfileAwarenessService(fakeConfigStore('add'), fakeProfile(), filter);

    const text = await svc.handle(HANDLE_INPUT);

    expect(text).toContain('[profile-awareness]');
    expect(text).not.toContain('Suggestion:');
  });

  it('filter returns undefined (no key / unavailable) → falls back to plain Stage-1 text', async () => {
    const filter = fakeFilter({ verdict: undefined });
    const svc = new ProfileAwarenessService(fakeConfigStore('add'), fakeProfile(), filter);

    const text = await svc.handle(HANDLE_INPUT);

    expect(text).toContain('[profile-awareness]');
    expect(text).not.toContain('Suggestion:');
  });

  it('passes installed skills as the filter catalog even though the rendered profile omits them', async () => {
    const filter = fakeFilter({
      verdict: { suppress: true, suggestion: '', reason: 'covered by skill' },
    });
    const svc = new ProfileAwarenessService(
      fakeConfigStore('add'),
      fakeProfile({
        ...EMPTY_SNAPSHOT,
        skills: [
          {
            name: 'eslint-review',
            description: 'Reviews eslint violations.',
            tier: 'repo',
            enabled: true,
          },
        ],
      }),
      filter,
    );

    await svc.handle(HANDLE_INPUT);

    expect(filter.filter).toHaveBeenCalledWith(
      expect.objectContaining({
        catalog: expect.stringContaining('eslint-review (repo) — Reviews eslint violations.'),
      }),
    );
  });

  it('filter throws → fail-silent to plain Stage-1 text (never propagates, never suppresses)', async () => {
    const filter = fakeFilter({ throws: true });
    const svc = new ProfileAwarenessService(fakeConfigStore('add'), fakeProfile(), filter);

    const text = await svc.handle(HANDLE_INPUT);

    expect(text).toContain('[profile-awareness]');
  });

  it('filter provider absent (kill-switch off) → plain Stage-1 text, filter never consulted', async () => {
    const svc = new ProfileAwarenessService(fakeConfigStore('add'), fakeProfile(), undefined);

    const text = await svc.handle(HANDLE_INPUT);

    expect(text).toContain('[profile-awareness]');
  });

  it('profile service absent → Stage 2 stays off even with a filter bound', async () => {
    const filter = fakeFilter({
      verdict: { suppress: true, suggestion: '', reason: 'would suppress' },
    });
    const svc = new ProfileAwarenessService(fakeConfigStore('add'), undefined, filter);

    const text = await svc.handle(HANDLE_INPUT);

    expect(filter.filter).not.toHaveBeenCalled();
    expect(text).toContain('[profile-awareness]');
  });

  it('no transition (steady-state repeat) → null, filter never consulted', async () => {
    const filter = fakeFilter({
      verdict: { suppress: false, suggestion: 'ignored', reason: 'n/a' },
    });
    const svc = new ProfileAwarenessService(fakeConfigStore(null), fakeProfile(), filter);

    const text = await svc.handle(HANDLE_INPUT);

    expect(text).toBeNull();
    expect(filter.filter).not.toHaveBeenCalled();
  });

  it('a "remove" transition + suppress:false → the retire checklist text, unaffected by filter shape', async () => {
    const filter = fakeFilter({
      verdict: { suppress: false, suggestion: '', reason: 'genuine retire' },
    });
    const svc = new ProfileAwarenessService(fakeConfigStore('remove'), fakeProfile(), filter);

    const text = await svc.handle({
      ...HANDLE_INPUT,
      command: 'pnpm remove eslint',
    });

    expect(text).toContain('removed');
    expect(text).toContain('pnpm:eslint');
  });
});
