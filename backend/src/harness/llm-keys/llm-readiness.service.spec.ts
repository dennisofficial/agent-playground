import { LlmReadinessService } from './llm-readiness.service';
import type { TenantCredentialService } from './tenant-credential.service';

/** Fake credential service whose per-team readiness is controllable. */
const fakeCreds = (ready: Record<string, boolean>) =>
  ({
    isReady: vi.fn(async (teamId: string) => !!ready[teamId]),
  }) as unknown as TenantCredentialService;

describe('LlmReadinessService (per-tenant)', () => {
  it('is not ready until a refresh finds the workspace keys', async () => {
    const ready: Record<string, boolean> = { T1: false };
    const svc = new LlmReadinessService(fakeCreds(ready));
    expect(svc.isReady('T1')).toBe(false);
    expect(await svc.refresh('T1')).toBe(false);
    expect(svc.isReady('T1')).toBe(false);

    ready.T1 = true;
    expect(await svc.refresh('T1')).toBe(true);
    expect(svc.isReady('T1')).toBe(true);
  });

  it('fires ready$ with the teamId exactly once, on the pending→ready edge', async () => {
    const ready: Record<string, boolean> = { T1: true };
    const svc = new LlmReadinessService(fakeCreds(ready));
    const edges: string[] = [];
    svc.ready$.subscribe((t) => edges.push(t));

    expect(await svc.refresh('T1')).toBe(true);
    expect(await svc.refresh('T1')).toBe(true); // idempotent — no second edge
    expect(edges).toEqual(['T1']);
  });

  it('isolates workspaces — T1 ready does not make T2 ready', async () => {
    const svc = new LlmReadinessService(fakeCreds({ T1: true, T2: false }));
    expect(await svc.refresh('T1')).toBe(true);
    expect(svc.isReady('T1')).toBe(true);
    expect(svc.isReady('T2')).toBe(false);
    expect(await svc.refresh('T2')).toBe(false);
  });

  it('ensureChecked probes an unknown workspace and flips it ready', async () => {
    const ready: Record<string, boolean> = { T1: true };
    const svc = new LlmReadinessService(fakeCreds(ready));
    const edges: string[] = [];
    svc.ready$.subscribe((t) => edges.push(t));

    svc.ensureChecked('T1');
    await new Promise((r) => setTimeout(r, 0)); // let the async probe settle
    expect(svc.isReady('T1')).toBe(true);
    expect(edges).toEqual(['T1']);
  });
});
