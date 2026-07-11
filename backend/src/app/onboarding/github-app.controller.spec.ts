import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import type { GitHubAppTokenService } from '../git/github-app-token.service';
import { GithubAppCallbackController, GithubAppController } from './github-app.controller';
import type { GithubAppStateStore } from './github-app-state.store';
import type { OnboardingService } from './onboarding.service';
import type { TenantCredentials, TenantCredentialStore } from './tenant-credential.store';

const ORG: CurrentOrgCtx = { id: 'org-1', role: 'owner' };

function fakeStore(overrides: {
  read?: TenantCredentials | null;
  presence?: Partial<Awaited<ReturnType<TenantCredentialStore['presence']>>>;
  write?: (orgId: string, patch: unknown) => Promise<void>;
} = {}) {
  return {
    read: vi.fn(async () => overrides.read ?? null),
    write: vi.fn(overrides.write ?? (async () => undefined)),
    presence: vi.fn(async () => ({
      hasAnthropic: false,
      hasOpenai: false,
      hasGithub: false,
      engineAuthSet: false,
      hasCodex: false,
      hasGithubApp: false,
      githubAuthMode: 'pat' as const,
      ...overrides.presence,
    })),
  } as unknown as TenantCredentialStore & {
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    presence: ReturnType<typeof vi.fn>;
  };
}

function fakeAppTokens(overrides: {
  isConfigured?: boolean;
  appSlug?: string;
  getInstallation?: (id: string) => Promise<{ id: string; account: { login: string; id: number; type: string } } | null>;
  getInstallationToken?: (id: string) => Promise<string>;
} = {}) {
  return {
    isConfigured: vi.fn(() => overrides.isConfigured ?? true),
    appSlug: vi.fn(async () => overrides.appSlug ?? 'atlas-app'),
    getInstallation:
      overrides.getInstallation ??
      vi.fn(async () => ({ id: '999', account: { login: 'acme', id: 1, type: 'Organization' } })),
    getInstallationToken: overrides.getInstallationToken ?? vi.fn(async () => 'ghs_minted'),
  } as unknown as GitHubAppTokenService & {
    isConfigured: ReturnType<typeof vi.fn>;
    appSlug: ReturnType<typeof vi.fn>;
  };
}

function fakeOnboarding() {
  return {
    tryActivate: vi.fn(async () => undefined),
  } as unknown as OnboardingService & { tryActivate: ReturnType<typeof vi.fn> };
}

function fakeStateStore(overrides: { stash?: string; consume?: (nonce: string) => Promise<string | null> } = {}) {
  return {
    stash: vi.fn(async () => overrides.stash ?? 'nonce-abc'),
    consume: vi.fn(overrides.consume ?? (async () => 'org-1')),
  } as unknown as GithubAppStateStore & {
    stash: ReturnType<typeof vi.fn>;
    consume: ReturnType<typeof vi.fn>;
  };
}

function fakeEnv(frontendHost = 'https://console.atlas.test') {
  return {
    get: vi.fn(() => frontendHost),
  } as unknown as EnvService;
}

function fakeRes() {
  return { redirect: vi.fn() } as unknown as Response & { redirect: ReturnType<typeof vi.fn> };
}

describe('GithubAppController', () => {
  describe('install-url', () => {
    it('returns a github.com/apps/<slug>/installations/new?state=<nonce> URL', async () => {
      const appTokens = fakeAppTokens({ appSlug: 'atlas-app' });
      const stateStore = fakeStateStore({ stash: 'nonce-xyz' });
      const controller = new GithubAppController(
        fakeStore(),
        appTokens,
        fakeOnboarding(),
        stateStore,
      );
      const result = await controller.installUrl(ORG);
      expect(result.url).toBe('https://github.com/apps/atlas-app/installations/new?state=nonce-xyz');
      expect(stateStore.stash).toHaveBeenCalledWith('org-1');
    });

    it('throws BadRequest when the App is not configured', async () => {
      const controller = new GithubAppController(
        fakeStore(),
        fakeAppTokens({ isConfigured: false }),
        fakeOnboarding(),
        fakeStateStore(),
      );
      await expect(controller.installUrl(ORG)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('PUT mode', () => {
    it('rejects switching to app mode when no installation id is on the row', async () => {
      const store = fakeStore({ read: {} });
      const controller = new GithubAppController(
        store,
        fakeAppTokens(),
        fakeOnboarding(),
        fakeStateStore(),
      );
      await expect(controller.setMode(ORG, { mode: 'app' })).rejects.toBeInstanceOf(BadRequestException);
      expect(store.write).not.toHaveBeenCalled();
    });

    it('accepts switching to app mode when an installation id is present', async () => {
      const store = fakeStore({ read: { githubAppInstallationId: '123' } });
      const onboarding = fakeOnboarding();
      const controller = new GithubAppController(
        store,
        fakeAppTokens(),
        onboarding,
        fakeStateStore(),
      );
      const result = await controller.setMode(ORG, { mode: 'app' });
      expect(result).toEqual({ ok: true, mode: 'app' });
      expect(store.write).toHaveBeenCalledWith('org-1', { githubAuthMode: 'app' });
      expect(onboarding.tryActivate).toHaveBeenCalledWith('org-1');
    });

    it('always allows switching back to pat mode', async () => {
      const store = fakeStore({ read: null });
      const controller = new GithubAppController(
        store,
        fakeAppTokens(),
        fakeOnboarding(),
        fakeStateStore(),
      );
      const result = await controller.setMode(ORG, { mode: 'pat' });
      expect(result).toEqual({ ok: true, mode: 'pat' });
      expect(store.write).toHaveBeenCalledWith('org-1', { githubAuthMode: 'pat' });
    });
  });

  describe('DELETE', () => {
    it('clears the installation and falls back to pat mode', async () => {
      const store = fakeStore();
      const onboarding = fakeOnboarding();
      const controller = new GithubAppController(
        store,
        fakeAppTokens(),
        onboarding,
        fakeStateStore(),
      );
      const result = await controller.disconnect(ORG);
      expect(result).toEqual({ ok: true });
      expect(store.write).toHaveBeenCalledWith('org-1', {
        githubAppInstallationId: null,
        githubAppInstallationAccount: null,
        githubAuthMode: 'pat',
      });
      expect(onboarding.tryActivate).toHaveBeenCalledWith('org-1');
    });
  });

  describe('GET status', () => {
    it('shapes configured/connected/mode/installationId/account from presence + read', async () => {
      const store = fakeStore({
        presence: { hasGithubApp: true, githubAuthMode: 'app' },
        read: { githubAppInstallationId: '123', githubAppInstallationAccount: 'acme' },
      });
      const controller = new GithubAppController(
        store,
        fakeAppTokens({ isConfigured: true }),
        fakeOnboarding(),
        fakeStateStore(),
      );
      const result = await controller.status(ORG);
      expect(result).toEqual({
        configured: true,
        connected: true,
        mode: 'app',
        installationId: '123',
        account: 'acme',
      });
    });

    it('nulls installationId/account when no row exists', async () => {
      const controller = new GithubAppController(
        fakeStore({ read: null }),
        fakeAppTokens(),
        fakeOnboarding(),
        fakeStateStore(),
      );
      const result = await controller.status(ORG);
      expect(result.installationId).toBeNull();
      expect(result.account).toBeNull();
    });
  });
});

describe('GithubAppCallbackController', () => {
  it('on success: consumes state, verifies + persists the installation, redirects ?githubApp=connected', async () => {
    const store = fakeStore();
    const onboarding = fakeOnboarding();
    const stateStore = fakeStateStore({ consume: async () => 'org-1' });
    const appTokens = fakeAppTokens({
      getInstallation: async () => ({ id: '999', account: { login: 'acme', id: 1, type: 'Organization' } }),
      getInstallationToken: async () => 'ghs_minted',
    });
    const res = fakeRes();
    const controller = new GithubAppCallbackController(stateStore, appTokens, store, onboarding, fakeEnv());

    await controller.callback('999', 'install', 'nonce-abc', res);

    expect(stateStore.consume).toHaveBeenCalledWith('nonce-abc');
    expect(store.write).toHaveBeenCalledWith('org-1', {
      githubAppInstallationId: '999',
      githubAuthMode: 'app',
      githubAppInstallationAccount: 'acme',
    });
    expect(onboarding.tryActivate).toHaveBeenCalledWith('org-1');
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://console.atlas.test/orgs/org-1/settings?githubApp=connected',
    );
  });

  it('bad/expired state: redirects invalid_state without writing', async () => {
    const store = fakeStore();
    const stateStore = fakeStateStore({ consume: async () => null });
    const res = fakeRes();
    const controller = new GithubAppCallbackController(
      stateStore,
      fakeAppTokens(),
      store,
      fakeOnboarding(),
      fakeEnv(),
    );

    await controller.callback('999', 'install', 'bad-nonce', res);

    expect(store.write).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://console.atlas.test/?githubApp=error&reason=invalid_state',
    );
  });

  it('missing state or installation_id: redirects invalid_state without consuming', async () => {
    const stateStore = fakeStateStore();
    const res = fakeRes();
    const controller = new GithubAppCallbackController(
      stateStore,
      fakeAppTokens(),
      fakeStore(),
      fakeOnboarding(),
      fakeEnv(),
    );

    await controller.callback(undefined, 'install', undefined, res);

    expect(stateStore.consume).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://console.atlas.test/?githubApp=error&reason=invalid_state',
    );
  });

  it('installation verification failure: redirects verification_failed', async () => {
    const stateStore = fakeStateStore({ consume: async () => 'org-1' });
    const appTokens = fakeAppTokens({ getInstallation: async () => null });
    const store = fakeStore();
    const res = fakeRes();
    const controller = new GithubAppCallbackController(
      stateStore,
      appTokens,
      store,
      fakeOnboarding(),
      fakeEnv(),
    );

    await controller.callback('999', 'install', 'nonce-abc', res);

    expect(store.write).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://console.atlas.test/orgs/org-1/settings?githubApp=error&reason=verification_failed',
    );
  });

  it('unique-violation on write (installation already claimed): redirects already_connected', async () => {
    const stateStore = fakeStateStore({ consume: async () => 'org-1' });
    const conflict = Object.assign(new QueryFailedError('insert', [], new Error('duplicate key')), {
      code: '23505',
    });
    const store = fakeStore({
      write: async () => {
        throw conflict;
      },
    });
    const res = fakeRes();
    const controller = new GithubAppCallbackController(
      stateStore,
      fakeAppTokens(),
      store,
      fakeOnboarding(),
      fakeEnv(),
    );

    await controller.callback('999', 'install', 'nonce-abc', res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://console.atlas.test/orgs/org-1/settings?githubApp=error&reason=already_connected',
    );
  });
});
