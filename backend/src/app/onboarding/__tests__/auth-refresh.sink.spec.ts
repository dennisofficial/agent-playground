import { describe, expect, it, vi } from 'vitest';
import { AuthRefreshSinkService } from '../auth-refresh.sink';
import type { ClaudeCredentialStore } from '../claude-credential.store';
import type { TenantCredentialStore } from '../tenant-credential.store';

function fakeTenantStore() {
  return {
    advanceCodexAuthSecret: vi.fn(async () => undefined),
  } as unknown as TenantCredentialStore & {
    advanceCodexAuthSecret: ReturnType<typeof vi.fn>;
  };
}

function fakeClaudeStore() {
  return {
    advanceClaudeCredential: vi.fn(async () => undefined),
  } as unknown as ClaudeCredentialStore & {
    advanceClaudeCredential: ReturnType<typeof vi.fn>;
  };
}

describe('AuthRefreshSinkService', () => {
  it('delegates a codex refresh to advanceCodexAuthSecret', async () => {
    const tenantStore = fakeTenantStore();
    const claudeStore = fakeClaudeStore();
    await new AuthRefreshSinkService(tenantStore, claudeStore).persist(
      { orgId: 'org1', engine: 'codex' },
      'blob',
    );
    expect(tenantStore.advanceCodexAuthSecret).toHaveBeenCalledWith(
      'org1',
      'blob',
    );
    expect(claudeStore.advanceClaudeCredential).not.toHaveBeenCalled();
  });

  it('delegates a claude refresh to advanceClaudeCredential, keyed by credentialId', async () => {
    const tenantStore = fakeTenantStore();
    const claudeStore = fakeClaudeStore();
    await new AuthRefreshSinkService(tenantStore, claudeStore).persist(
      { orgId: 'org1', engine: 'claude', credentialId: 'cred-1' },
      'blob',
    );
    expect(claudeStore.advanceClaudeCredential).toHaveBeenCalledWith(
      'org1',
      'cred-1',
      'blob',
    );
    expect(tenantStore.advanceCodexAuthSecret).not.toHaveBeenCalled();
  });

  it('swallows a store error so it never fails the turn-completion path', async () => {
    const tenantStore = fakeTenantStore();
    const claudeStore = fakeClaudeStore();
    tenantStore.advanceCodexAuthSecret.mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(
      new AuthRefreshSinkService(tenantStore, claudeStore).persist(
        { orgId: 'org1', engine: 'codex' },
        'blob',
      ),
    ).resolves.toBeUndefined();
  });
});
