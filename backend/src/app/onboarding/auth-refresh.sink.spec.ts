import { describe, expect, it, vi } from 'vitest';
import { AuthRefreshSinkService } from './auth-refresh.sink';
import type { TenantCredentialStore } from './tenant-credential.store';

function fakeStore() {
  return {
    advanceCodexAuthSecret: vi.fn(async () => undefined),
  } as unknown as TenantCredentialStore & { advanceCodexAuthSecret: ReturnType<typeof vi.fn> };
}

describe('AuthRefreshSinkService', () => {
  it('delegates a codex refresh to advanceCodexAuthSecret', async () => {
    const store = fakeStore();
    await new AuthRefreshSinkService(store).persist('org1', 'codex', 'blob');
    expect(store.advanceCodexAuthSecret).toHaveBeenCalledWith('org1', 'blob');
  });

  it('ignores non-codex engines (Claude has no file-based auth.json refresh)', async () => {
    const store = fakeStore();
    await new AuthRefreshSinkService(store).persist('org1', 'claude', 'blob');
    expect(store.advanceCodexAuthSecret).not.toHaveBeenCalled();
  });

  it('swallows a store error so it never fails the turn-completion path', async () => {
    const store = fakeStore();
    store.advanceCodexAuthSecret.mockRejectedValueOnce(new Error('db down'));
    await expect(new AuthRefreshSinkService(store).persist('org1', 'codex', 'blob')).resolves.toBeUndefined();
  });
});
