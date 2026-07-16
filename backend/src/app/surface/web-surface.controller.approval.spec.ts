import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import {
  APPROVE_ACTION_ID,
  SHIP_ACTION_ID,
  RETRACT_SHIP_ACTION_ID,
} from './approval-blocks';
import { WebSurfaceController } from './web-surface.controller';

type ControllerMocks = {
  post: ReturnType<typeof vi.fn>;
  receiveApprovalClick: ReturnType<typeof vi.fn>;
  appendSystemOperatorMessage: ReturnType<typeof vi.fn>;
};

function makeController(thread: {
  id?: string;
  org_id?: string;
  repo_id?: string;
  status: string;
  decision_record_id?: string | null;
}) {
  const row = {
    id: thread.id ?? 'job-1',
    org_id: thread.org_id ?? 'org-1',
    repo_id: thread.repo_id ?? 'repo-1',
    decision_record_id: thread.decision_record_id ?? null,
    status: thread.status,
  };
  const mocks: ControllerMocks = {
    post: vi.fn(async () => 'notice-1'),
    receiveApprovalClick: vi.fn(),
    appendSystemOperatorMessage: vi.fn(async () => undefined),
  };
  const jobs = {
    findOne: vi.fn(
      async ({ where }: { where: { id: string; org_id: string } }) =>
        where.id === row.id && where.org_id === row.org_id ? row : null,
    ),
  };
  const controller = new WebSurfaceController(
    {
      post: mocks.post,
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
    { appendSystemOperatorMessage: mocks.appendSystemOperatorMessage } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never, // skillInstaller (SkillInstallerService)
    {} as never, // git (LocalGitService)
    {} as never, // jobDeps (JobDependencyService)
    {} as never, // moduleRef (ModuleRef)
    {} as never, // intake (StimulusIntake)
  );
  return { controller, mocks };
}

const ORG: CurrentOrgCtx = { id: 'org-1', role: 'member' };
const USER = { id: 'user-1' };

describe('WebSurfaceController — plan approval endpoint', () => {
  it('returns ok:false and posts a notice for a stale click on a withdrawn/non-awaiting plan', async () => {
    const { controller, mocks } = makeController({
      status: 'planning',
      decision_record_id: 'dr-current',
    });
    const result = await controller.approve(ORG, USER as never, 'job-1', {
      actionId: APPROVE_ACTION_ID,
      value: JSON.stringify({ jobId: 'job-1', decisionRecordId: 'dr-current' }),
    });

    expect(result).toMatchObject({ ok: false, jobId: 'job-1' });
    expect(result.message).toContain('changed or was withdrawn');
    expect(mocks.receiveApprovalClick).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith(
      'repo-1',
      expect.stringContaining('changed or was withdrawn'),
      expect.objectContaining({ threadTs: 'job-1', orgId: 'org-1' }),
    );
    expect(mocks.appendSystemOperatorMessage).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('changed or was withdrawn'),
      { source: 'system_operator' },
    );
  });

  it('returns ok:false and posts a notice for a stale click on a superseded decision record', async () => {
    const { controller, mocks } = makeController({
      status: 'awaiting_approval',
      decision_record_id: 'dr-current',
    });
    const result = await controller.approve(ORG, USER as never, 'job-1', {
      actionId: APPROVE_ACTION_ID,
      value: JSON.stringify({ jobId: 'job-1', decisionRecordId: 'dr-old' }),
    });

    expect(result).toMatchObject({ ok: false, jobId: 'job-1' });
    expect(mocks.receiveApprovalClick).not.toHaveBeenCalled();
    expect(mocks.appendSystemOperatorMessage).toHaveBeenCalledTimes(1);
  });

  it('emits the approval click only when the clicked decision record is current', async () => {
    const { controller, mocks } = makeController({
      status: 'awaiting_approval',
      decision_record_id: 'dr-current',
    });
    const value = JSON.stringify({
      jobId: 'job-1',
      decisionRecordId: 'dr-current',
    });

    const result = await controller.approve(ORG, USER as never, 'job-1', {
      actionId: APPROVE_ACTION_ID,
      value,
    });

    expect(result).toEqual({ ok: true, jobId: 'job-1' });
    expect(mocks.receiveApprovalClick).toHaveBeenCalledWith(
      APPROVE_ACTION_ID,
      value,
      'user-1',
      undefined,
    );
    expect(mocks.appendSystemOperatorMessage).not.toHaveBeenCalled();
  });

  it('does not apply the decision-record preflight to ship-review approvals', async () => {
    const { controller, mocks } = makeController({
      status: 'awaiting_ship_review',
      decision_record_id: null,
    });
    const value = JSON.stringify({ jobId: 'job-1' });

    const result = await controller.approve(ORG, USER as never, 'job-1', {
      actionId: SHIP_ACTION_ID,
      value,
    });

    expect(result).toEqual({ ok: true, jobId: 'job-1' });
    expect(mocks.receiveApprovalClick).toHaveBeenCalledWith(
      SHIP_ACTION_ID,
      value,
      'user-1',
      undefined,
    );
  });

  it('does not apply the decision-record preflight to ship-review retracts', async () => {
    const { controller, mocks } = makeController({
      status: 'awaiting_ship_review',
      decision_record_id: null,
    });
    const value = JSON.stringify({ jobId: 'job-1' });

    const result = await controller.approve(ORG, USER as never, 'job-1', {
      actionId: RETRACT_SHIP_ACTION_ID,
      value,
    });

    expect(result).toEqual({ ok: true, jobId: 'job-1' });
    expect(mocks.receiveApprovalClick).toHaveBeenCalledWith(
      RETRACT_SHIP_ACTION_ID,
      value,
      'user-1',
      undefined,
    );
  });

  it('rejects a click whose value targets a different route job', async () => {
    const { controller } = makeController({
      status: 'awaiting_approval',
      decision_record_id: 'dr-current',
    });

    await expect(
      controller.approve(ORG, USER as never, 'job-1', {
        actionId: APPROVE_ACTION_ID,
        value: JSON.stringify({
          jobId: 'other-job',
          decisionRecordId: 'dr-current',
        }),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
