import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import { APPROVE_ACTION_ID, SHIP_ACTION_ID } from './approval-blocks';
import { WebSurfaceController } from './web-surface.controller';

type ControllerMocks = {
  receiveApprovalClick: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeController(thread: {
  id?: string;
  org_id?: string;
  repo_id?: string;
  status: string;
  decision_record_id?: string | null;
} | null) {
  const row = thread
    ? {
        id: thread.id ?? 'job-1',
        org_id: thread.org_id ?? 'org-1',
        repo_id: thread.repo_id ?? 'repo-1',
        decision_record_id: thread.decision_record_id ?? null,
        status: thread.status,
      }
    : null;
  const mocks: ControllerMocks = {
    receiveApprovalClick: vi.fn(),
    update: vi.fn(async () => ({ affected: 1 })),
  };
  const jobs = {
    findOne: vi.fn(async ({ where }: { where: { id: string; org_id: string } }) =>
      row && where.id === row.id && where.org_id === row.org_id ? row : null,
    ),
    update: mocks.update,
  };
  const controller = new WebSurfaceController(
    {
      post: vi.fn(async () => 'notice-1'),
      receiveApprovalClick: mocks.receiveApprovalClick,
      name: 'web',
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // autoMerge
    {} as never,
    jobs as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // usageBus
    { available: false } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // secrets
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // skillInstaller (SkillInstallerService)
    {} as never, // git (LocalGitService)
    {} as never, // jobDeps (JobDependencyService)
  );
  return { controller, mocks };
}

const ORG: CurrentOrgCtx = { id: 'org-1', role: 'member' };
const USER = { id: 'user-1' };

describe('WebSurfaceController — setAutoApprove endpoint', () => {
  it('sets mode with no gate parked: updates the row, never clicks approve', async () => {
    const { controller, mocks } = makeController({ status: 'running' });

    const result = await controller.setAutoApprove(ORG, USER as never, 'job-1', {
      mode: 'both',
    } as never);

    expect(mocks.update).toHaveBeenCalledWith(
      { id: 'job-1', org_id: 'org-1' },
      { auto_approve_mode: 'both', auto_approve_by: 'user-1' },
    );
    expect(mocks.receiveApprovalClick).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, autoApproveMode: 'both' });
  });

  it.each(['plan', 'both'] as const)(
    'mode %s while awaiting_approval: immediately resolves the parked plan gate',
    async (mode) => {
      const { controller, mocks } = makeController({
        status: 'awaiting_approval',
        decision_record_id: 'dr-current',
      });

      const result = await controller.setAutoApprove(ORG, USER as never, 'job-1', {
        mode,
      } as never);

      expect(mocks.receiveApprovalClick).toHaveBeenCalledTimes(1);
      const [actionId, value, userId] = mocks.receiveApprovalClick.mock.calls[0];
      expect(actionId).toBe(APPROVE_ACTION_ID);
      expect(userId).toBe('user-1');
      expect(JSON.parse(value)).toEqual({ jobId: 'job-1', decisionRecordId: 'dr-current' });
      expect(result).toEqual({ ok: true, autoApproveMode: mode });
    },
  );

  it.each(['ship', 'off'] as const)(
    'mode %s while awaiting_approval: does NOT resolve the parked plan gate',
    async (mode) => {
      const { controller, mocks } = makeController({
        status: 'awaiting_approval',
        decision_record_id: 'dr-current',
      });

      const result = await controller.setAutoApprove(ORG, USER as never, 'job-1', {
        mode,
      } as never);

      expect(mocks.receiveApprovalClick).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, autoApproveMode: mode });
    },
  );

  it.each(['ship', 'both'] as const)(
    'mode %s while awaiting_ship_review: immediately resolves the parked ship gate',
    async (mode) => {
      const { controller, mocks } = makeController({ status: 'awaiting_ship_review' });

      const result = await controller.setAutoApprove(ORG, USER as never, 'job-1', {
        mode,
      } as never);

      expect(mocks.receiveApprovalClick).toHaveBeenCalledTimes(1);
      const [actionId, value, userId] = mocks.receiveApprovalClick.mock.calls[0];
      expect(actionId).toBe(SHIP_ACTION_ID);
      expect(userId).toBe('user-1');
      expect(JSON.parse(value)).toEqual({ jobId: 'job-1' });
      expect(result).toEqual({ ok: true, autoApproveMode: mode });
    },
  );

  it.each(['plan', 'off'] as const)(
    'mode %s while awaiting_ship_review: does NOT resolve the parked ship gate',
    async (mode) => {
      const { controller, mocks } = makeController({ status: 'awaiting_ship_review' });

      const result = await controller.setAutoApprove(ORG, USER as never, 'job-1', {
        mode,
      } as never);

      expect(mocks.receiveApprovalClick).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, autoApproveMode: mode });
    },
  );

  it("mode 'off': persists auto_approve_mode:'off' with NO auto_approve_by, never clicks approve", async () => {
    const { controller, mocks } = makeController({ status: 'awaiting_approval' });

    const result = await controller.setAutoApprove(ORG, USER as never, 'job-1', {
      mode: 'off',
    } as never);

    expect(mocks.update).toHaveBeenCalledWith(
      { id: 'job-1', org_id: 'org-1' },
      { auto_approve_mode: 'off' },
    );
    expect(mocks.receiveApprovalClick).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, autoApproveMode: 'off' });
  });

  it('404s for a foreign-org / missing thread', async () => {
    const { controller } = makeController(null);

    await expect(
      controller.setAutoApprove(ORG, USER as never, 'job-1', { mode: 'both' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an invalid mode', async () => {
    const { controller } = makeController({ status: 'running' });

    await expect(
      controller.setAutoApprove(ORG, USER as never, 'job-1', { mode: 'yes' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing mode field', async () => {
    const { controller } = makeController({ status: 'running' });

    await expect(
      controller.setAutoApprove(ORG, USER as never, 'job-1', {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
