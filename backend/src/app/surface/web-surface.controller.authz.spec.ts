import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import { WebSurfaceController } from './web-surface.controller';

/**
 * Cross-tenant isolation regression (the hole Codex flagged): `OrgMembershipGuard` only proves the
 * caller is a member of `:orgId`, but thread-keyed ops act on a `threadId`. Without scoping, a member of
 * ANY org with a leaked thread id could read/write/DELETE another org's thread — and `deleteThreadDeep`
 * would then wipe that tenant's thread + all its children. `requireThread(threadId, org.id)` closes it:
 * every thread-keyed op resolves the thread scoped to the caller's org or 404s.
 *
 * Pure unit test — the controller is instantiated with mocked repos; `threads.findOne` returns a row only
 * when its `org_id` matches, emulating the scoped query.
 */
function makeController(threadOrgId: string) {
  const deleteThreadDeep = vi.fn(async () => undefined);
  const threads = {
    findOne: vi.fn(async ({ where }: { where: { id: string; org_id: string } }) =>
      where.org_id === threadOrgId ? { id: where.id, org_id: threadOrgId, repo_id: 'repo-1' } : null,
    ),
    delete: vi.fn(async () => ({ affected: 1 })),
  };
  const messages = { find: vi.fn(async () => []), delete: vi.fn(async () => undefined) };

  const controller = new WebSurfaceController(
    {} as never, // surface
    {} as never, // liveTurns
    {} as never, // driverStore
    { deleteThreadDeep } as never, // threadLifecycle
    {} as never, // orgService
    threads as never,
    messages as never,
    {} as never, // repos
    {} as never, // threadTitle
    {} as never, // ticketEvents
    { available: false } as never, // realtime
    { isLeader: () => true, getState: () => 'leader', isDraining: () => false } as never, // election
    { dispatch: async () => undefined } as never, // dispatcher (JOB_DISPATCHER)
  );
  return { controller, deleteThreadDeep, threads, messages };
}

describe('WebSurfaceController — cross-tenant authz', () => {
  const orgB: CurrentOrgCtx = { id: 'orgB', role: 'owner' };

  it("deleteThread on another org's thread 404s and never tears it down", async () => {
    const { controller, deleteThreadDeep } = makeController('orgA'); // thread belongs to org A
    await expect(controller.deleteThread(orgB, 'leaked-thread-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(deleteThreadDeep).not.toHaveBeenCalled();
  });

  it("messageHistory on another org's thread 404s and never reads messages", async () => {
    const { controller, messages } = makeController('orgA');
    await expect(controller.messageHistory(orgB, 'leaked-thread-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(messages.find).not.toHaveBeenCalled();
  });

  it("deleteThread on the caller's OWN thread proceeds (full org-scoped cascade)", async () => {
    const { controller, deleteThreadDeep } = makeController('orgB'); // thread belongs to org B
    await controller.deleteThread(orgB, 'my-thread-id');
    expect(deleteThreadDeep).toHaveBeenCalledWith('my-thread-id', 'orgB');
  });
});
