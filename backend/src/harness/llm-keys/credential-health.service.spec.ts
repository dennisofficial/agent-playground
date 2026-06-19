import { describe, expect, it, vi } from 'vitest';
import { CredentialHealthService } from './credential-health.service';
import type { RotateKeysPresenter } from './rotate-keys-presenter.port';

describe('CredentialHealthService', () => {
  it('posts the update-keys card for the failing provider', async () => {
    const present = vi.fn(async () => undefined);
    const svc = new CredentialHealthService({
      present,
    } as RotateKeysPresenter);
    await svc.reportAuthError('T1', 'slack:T1:C1', 'anthropic');
    expect(present).toHaveBeenCalledTimes(1);
    const arg = present.mock.calls[0][0];
    expect(arg).toMatchObject({ team: 'T1', surfaceId: 'slack:T1:C1' });
    expect(arg.reason).toMatch(/Anthropic.*unauthorized/i);
  });

  it('throttles repeats per (team, provider) — a dead key 401s every turn', async () => {
    const present = vi.fn(async () => undefined);
    const svc = new CredentialHealthService({
      present,
    } as RotateKeysPresenter);
    await svc.reportAuthError('T1', 's', 'anthropic');
    await svc.reportAuthError('T1', 's', 'anthropic'); // within window → throttled
    expect(present).toHaveBeenCalledTimes(1);
    // A DIFFERENT provider for the same team is independent.
    await svc.reportAuthError('T1', 's', 'openai');
    expect(present).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when no presenter is bound (headless)', async () => {
    const svc = new CredentialHealthService(undefined);
    await expect(
      svc.reportAuthError('T1', 's', 'anthropic'),
    ).resolves.toBeUndefined();
  });
});
