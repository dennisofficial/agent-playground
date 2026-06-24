import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import { WebSurfaceController } from './web-surface.controller';

/**
 * Cross-tenant isolation regression (the hole Codex flagged): `OrgMembershipGuard` only proves the
 * caller is a member of `:orgId`, but thread-keyed ops act on a `threadId`. Without scoping, a member of
 * ANY org with a leaked thread id could read/write/DELETE another org's thread — and the FK cascade would
 * then wipe that tenant's thread + all its children. `requireThread(threadId, org.id)` closes it: every
 * thread-keyed op resolves the thread scoped to the caller's org or 404s.
 *
 * Pure unit test — the controller is instantiated with mocked repos; `threads.findOne` returns a row only
 * when its `org_id` matches, emulating the scoped query.
 */
function makeController(threadOrgId: string) {
  const closeThread = vi.fn(async () => undefined);
  const threadDelete = vi.fn(async () => ({ affected: 1 }));
  const threads = {
    findOne: vi.fn(async ({ where }: { where: { id: string; org_id: string } }) =>
      where.org_id === threadOrgId ? { id: where.id, org_id: threadOrgId, repo_id: 'repo-1' } : null,
    ),
    delete: threadDelete,
  };
  const messages = { find: vi.fn(async () => []), delete: vi.fn(async () => undefined) };

  const controller = new WebSurfaceController(
    {} as never, // surface
    {} as never, // driverStore
    { closeThread } as never, // threadLifecycle
    {} as never, // orgService
    threads as never,
    messages as never,
    {} as never, // repos
  );
  return { controller, closeThread, threadDelete, threads, messages };
}

describe('WebSurfaceController — cross-tenant authz', () => {
  const orgB: CurrentOrgCtx = { id: 'orgB', role: 'owner' };

  it("deleteThread on another org's thread 404s and never closes/deletes it", async () => {
    const { controller, closeThread, threadDelete } = makeController('orgA'); // thread belongs to org A
    await expect(controller.deleteThread(orgB, 'leaked-thread-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(closeThread).not.toHaveBeenCalled();
    expect(threadDelete).not.toHaveBeenCalled();
  });

  it("messageHistory on another org's thread 404s and never reads messages", async () => {
    const { controller, messages } = makeController('orgA');
    await expect(controller.messageHistory(orgB, 'leaked-thread-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(messages.find).not.toHaveBeenCalled();
  });

  it("deleteThread on the caller's OWN thread proceeds (close + org-scoped delete)", async () => {
    const { controller, closeThread, threadDelete } = makeController('orgB'); // thread belongs to org B
    await controller.deleteThread(orgB, 'my-thread-id');
    expect(closeThread).toHaveBeenCalledWith('my-thread-id', 'orgB');
    expect(threadDelete).toHaveBeenCalledWith({ id: 'my-thread-id', org_id: 'orgB' });
  });
});
