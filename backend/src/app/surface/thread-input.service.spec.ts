import { describe, expect, it, vi } from 'vitest';
import { ThreadInputService } from './thread-input.service';
import { laneFor } from './thread-registry';

/**
 * The shared send seam — routes `postToThread(lane, …)` to the transport REGISTERED for the lane's thread
 * kind (via the THREAD_REGISTRY), and hard-blocks read-only lanes. It reimplements no transport; these tests
 * assert the routing + the read-only invariant, not delivery mechanics.
 */
describe('ThreadInputService — the shared send seam', () => {
  const ctx = { jobId: 'J', orgId: 'O', repoId: 'R' };

  it('routes a post to the handler registered for the lane’s kind, with the registry-captured ids', async () => {
    const svc = new ThreadInputService();
    const post = vi.fn(async () => undefined);
    svc.register('codex-review', { post });

    await svc.postToThread(laneFor('codex-review', 'J'), ctx, 'my rebuttal');

    expect(post).toHaveBeenCalledWith({ ...ctx, ids: ['J'] }, 'my rebuttal');
  });

  it('THROWS on a read-only (input:"none") lane rather than silently dropping the message', async () => {
    const svc = new ThreadInputService();
    // ship is `input:'none'` — no handler should ever be consulted.
    await expect(svc.postToThread(laneFor('ship', 'J'), ctx, 'x')).rejects.toThrow(/read-only/);
  });

  it('THROWS when an input-accepting kind has no registered handler (a boot-order bug)', async () => {
    const svc = new ThreadInputService();
    await expect(svc.postToThread(laneFor('main', 'J'), ctx, 'x')).rejects.toThrow(
      /no input handler/,
    );
  });

  it('THROWS on a lane no thread kind owns', async () => {
    const svc = new ThreadInputService();
    await expect(svc.postToThread('bogus:lane', ctx, 'x')).rejects.toThrow(/no thread kind owns/);
  });

  it('canPost reflects handler presence AND the read-only invariant', () => {
    const svc = new ThreadInputService();
    expect(svc.canPost(laneFor('codex-review', 'J'))).toBe(false); // no handler yet
    svc.register('codex-review', { post: vi.fn(async () => undefined) });
    expect(svc.canPost(laneFor('codex-review', 'J'))).toBe(true); // registered
    expect(svc.canPost(laneFor('ship', 'J'))).toBe(false); // read-only, never postable
  });
});
