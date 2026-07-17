import type { EnvService } from '@core/config/env/env.service';
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { GitHubAppTokenService } from '../git/github-app-token.service';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import type { OrganizationService } from '../org/organization.service';
import type { UserEntity } from '../persistence/entities';
import type { GithubAppConnectState, GithubAppStateStore } from './github-app-state.store';
import { GithubAppCallbackController, GithubAppController } from './github-app.controller';
import type { OnboardingService } from './onboarding.service';
import type { TenantCredentials, TenantCredentialStore } from './tenant-credential.store';

const ORG: CurrentOrgCtx = { id: 'org-1', role: 'owner' };
const USER = { id: 'user-1' } as UserEntity;

function fakeStore(
  overrides: {
    read?: TenantCredentials | null;
    presence?: Partial<Awaited<ReturnType<TenantCredentialStore['presence']>>>;
    write?: (orgId: string, patch: unknown) => Promise<void>;
    orgsHoldingInstallation?: string[];
  } = {},
) {
  return {
    read: vi.fn(async () => overrides.read ?? null),
    write: vi.fn(overrides.write ?? (async () => undefined)),
    orgsHoldingInstallation: vi.fn(async () => overrides.orgsHoldingInstallation ?? []),
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
    orgsHoldingInstallation: ReturnType<typeof vi.fn>;
    presence: ReturnType<typeof vi.fn>;
  };
}

function fakeOrgs(overrides: { ownsAnyOf?: boolean } = {}) {
  return {
    ownsAnyOf: vi.fn(async () => overrides.ownsAnyOf ?? false),
  } as unknown as OrganizationService & { ownsAnyOf: ReturnType<typeof vi.fn> };
}

function fakeAppTokens(
  overrides: {
    isConfigured?: boolean;
    appSlug?: string;
    getInstallation?: (id: string) => Promise<{
      id: string;
      account: { login: string; id: number; type: string };
    } | null>;
    getInstallationToken?: (id: string) => Promise<string>;
  } = {},
) {
  return {
    isConfigured: vi.fn(() => overrides.isConfigured ?? true),
    appSlug: vi.fn(async () => overrides.appSlug ?? 'atlas-app'),
    getInstallation:
      overrides.getInstallation ??
      vi.fn(async () => ({
        id: '999',
        account: { login: 'acme', id: 1, type: 'Organization' },
      })),
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

function fakeStateStore(
  overrides: {
    stash?: string;
    consume?: (nonce: string) => Promise<GithubAppConnectState | null>;
  } = {},
) {
  return {
    stash: vi.fn(async () => overrides.stash ?? 'nonce-abc'),
    consume: vi.fn(overrides.consume ?? (async () => ({ orgId: 'org-1', userId: 'user-1' }))),
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
  return { redirect: vi.fn() } as unknown as Response & {
    redirect: ReturnType<typeof vi.fn>;
  };
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
      const result = await controller.installUrl(ORG, USER);
      expect(result.url).toBe(
        'https://github.com/apps/atlas-app/installations/new?state=nonce-xyz',
      );
      expect(stateStore.stash).toHaveBeenCalledWith('org-1', 'user-1');
    });

    it('throws BadRequest when the App is not configured', async () => {
      const controller = new GithubAppController(
        fakeStore(),
        fakeAppTokens({ isConfigured: false }),
        fakeOnboarding(),
        fakeStateStore(),
      );
      await expect(controller.installUrl(ORG, USER)).rejects.toBeInstanceOf(BadRequestException);
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
      await expect(controller.setMode(ORG, { mode: 'app' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
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
      expect(store.write).toHaveBeenCalledWith('org-1', {
        githubAuthMode: 'app',
      });
      expect(onboarding.tryActivate).toHaveBeenCalledWith('org-1');
    });

    it('rejects switching to pat mode when no PAT is on the row', async () => {
      const store = fakeStore({ read: null });
      const controller = new GithubAppController(
        store,
        fakeAppTokens(),
        fakeOnboarding(),
        fakeStateStore(),
      );
      await expect(controller.setMode(ORG, { mode: 'pat' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(store.write).not.toHaveBeenCalled();
    });

    it('accepts switching back to pat mode when a PAT is present', async () => {
      const store = fakeStore({ read: { githubPat: 'ghp_x' } });
      const controller = new GithubAppController(
        store,
        fakeAppTokens(),
        fakeOnboarding(),
        fakeStateStore(),
      );
      const result = await controller.setMode(ORG, { mode: 'pat' });
      expect(result).toEqual({ ok: true, mode: 'pat' });
      expect(store.write).toHaveBeenCalledWith('org-1', {
        githubAuthMode: 'pat',
      });
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
        read: {
          githubAppInstallationId: '123',
          githubAppInstallationAccount: 'acme',
        },
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
  it('on success (first claim): consumes state, verifies + persists the installation, redirects ?githubApp=connected', async () => {
    const store = fakeStore(); // orgsHoldingInstallation defaults to [] — no other holder
    const onboarding = fakeOnboarding();
    const stateStore = fakeStateStore({
      consume: async () => ({ orgId: 'org-1', userId: 'user-1' }),
    });
    const appTokens = fakeAppTokens({
      getInstallation: async () => ({
        id: '999',
        account: { login: 'acme', id: 1, type: 'Organization' },
      }),
      getInstallationToken: async () => 'ghs_minted',
    });
    const orgs = fakeOrgs();
    const res = fakeRes();
    const controller = new GithubAppCallbackController(
      stateStore,
      appTokens,
      store,
      onboarding,
      orgs,
      fakeEnv(),
    );

    await controller.callback('999', 'install', 'nonce-abc', res);

    expect(stateStore.consume).toHaveBeenCalledWith('nonce-abc');
    expect(store.orgsHoldingInstallation).toHaveBeenCalledWith('999', 'org-1');
    expect(orgs.ownsAnyOf).not.toHaveBeenCalled(); // no other holder → ownership never queried
    expect(store.write).toHaveBeenCalledWith('org-1', {
      githubAppInstallationId: '999',
      githubAppInstallationAccount: 'acme',
    });
    // Connecting the App must NEVER auto-flip the in-sandbox auth mode.
    expect(store.write).not.toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ githubAuthMode: expect.anything() }),
    );
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
      fakeOrgs(),
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
      fakeOrgs(),
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
    const stateStore = fakeStateStore({
      consume: async () => ({ orgId: 'org-1', userId: 'user-1' }),
    });
    const appTokens = fakeAppTokens({ getInstallation: async () => null });
    const store = fakeStore();
    const res = fakeRes();
    const controller = new GithubAppCallbackController(
      stateStore,
      appTokens,
      store,
      fakeOnboarding(),
      fakeOrgs(),
      fakeEnv(),
    );

    await controller.callback('999', 'install', 'nonce-abc', res);

    expect(store.write).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://console.atlas.test/orgs/org-1/settings?githubApp=error&reason=verification_failed',
    );
  });

  it('reuse allowed: installation held by an org the user owns → persists + redirects connected', async () => {
    const stateStore = fakeStateStore({
      consume: async () => ({ orgId: 'org-2', userId: 'user-1' }),
    });
    const store = fakeStore({ orgsHoldingInstallation: ['org-1'] });
    const onboarding = fakeOnboarding();
    const orgs = fakeOrgs({ ownsAnyOf: true }); // user-1 owns org-1, a current holder
    const res = fakeRes();
    const controller = new GithubAppCallbackController(
      stateStore,
      fakeAppTokens(),
      store,
      onboarding,
      orgs,
      fakeEnv(),
    );

    await controller.callback('999', 'install', 'nonce-abc', res);

    expect(store.orgsHoldingInstallation).toHaveBeenCalledWith('999', 'org-2');
    expect(orgs.ownsAnyOf).toHaveBeenCalledWith('user-1', ['org-1']);
    expect(store.write).toHaveBeenCalledWith('org-2', {
      githubAppInstallationId: '999',
      githubAppInstallationAccount: 'acme',
    });
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://console.atlas.test/orgs/org-2/settings?githubApp=connected',
    );
  });

  it('reuse denied: installation held only by an org the user does NOT own → already_connected, no write', async () => {
    const stateStore = fakeStateStore({
      consume: async () => ({ orgId: 'org-2', userId: 'user-1' }),
    });
    const store = fakeStore({ orgsHoldingInstallation: ['org-1'] });
    const orgs = fakeOrgs({ ownsAnyOf: false }); // user-1 owns none of the holders
    const res = fakeRes();
    const controller = new GithubAppCallbackController(
      stateStore,
      fakeAppTokens(),
      store,
      fakeOnboarding(),
      orgs,
      fakeEnv(),
    );

    await controller.callback('999', 'install', 'nonce-abc', res);

    expect(orgs.ownsAnyOf).toHaveBeenCalledWith('user-1', ['org-1']);
    expect(store.write).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://console.atlas.test/orgs/org-2/settings?githubApp=error&reason=already_connected',
    );
  });

  it('reuse denied for a legacy nonce (no userId): another holder → already_connected, no write', async () => {
    const stateStore = fakeStateStore({
      consume: async () => ({ orgId: 'org-2', userId: null }),
    });
    const store = fakeStore({ orgsHoldingInstallation: ['org-1'] });
    const orgs = fakeOrgs({ ownsAnyOf: true });
    const res = fakeRes();
    const controller = new GithubAppCallbackController(
      stateStore,
      fakeAppTokens(),
      store,
      fakeOnboarding(),
      orgs,
      fakeEnv(),
    );

    await controller.callback('999', 'install', 'nonce-abc', res);

    // Can't verify ownership without a user — fail closed, never consult ownership.
    expect(orgs.ownsAnyOf).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://console.atlas.test/orgs/org-2/settings?githubApp=error&reason=already_connected',
    );
  });
});
