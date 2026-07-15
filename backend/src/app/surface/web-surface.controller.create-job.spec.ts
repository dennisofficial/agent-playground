import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import { WebSurfaceController } from './web-surface.controller';

/**
 * Focused unit coverage for the org-default-fallback / explicit-wins / reject-invalid contract in
 * `createJob` (see the `autoApproveMode` / `autoMerge` resolution block). The rest of `createJob` (repo
 * resolution, attachment ingest, review-PR seeding, title generation) is exercised elsewhere / at the
 * integration layer — this file only pins the automation-defaults resolution.
 */

type OrgDefaults = {
  default_auto_approve_mode: string;
  default_auto_merge: boolean;
} | null;

function makeController(orgDefaults: OrgDefaults) {
  const savedRows: Array<Record<string, unknown>> = [];
  const jobs = {
    create: (x: Record<string, unknown>) => x,
    save: vi.fn(async (x: Record<string, unknown>) => {
      const row = { id: 'job-1', ...x };
      savedRows.push(row);
      return row;
    }),
  };
  const repos = {
    findOne: vi.fn(async () => ({
      id: 'repo-1',
      org_id: 'org-1',
      slug: 'repo',
    })),
  };
  const orgService = {
    get: vi.fn(async () => orgDefaults),
  };
  const surface = {
    receiveFromClient: vi.fn(),
    name: 'web',
  };
  const threadTitle = {
    generateAndApply: vi.fn(async () => undefined),
  };
  const controller = new WebSurfaceController(
    surface as never,
    {} as never, // liveTurns
    {} as never, // driverStore
    {} as never, // threadLifecycle
    {} as never, // autoMerge
    orgService as never,
    jobs as never,
    {} as never, // messages
    repos as never,
    threadTitle as never,
    {} as never, // usageBus
    {} as never, // realtime
    {} as never, // election
    {} as never, // dispatcher
    {} as never, // secrets
    {} as never, // store
    {} as never, // brain
    {} as never, // mcpStore
    {} as never, // mcpProbe
    {} as never, // conventions
    {} as never, // skillStore
    {} as never, // skillFiles
    {} as never, // skillInstaller
    {} as never, // git
    {} as never, // jobDeps
    {} as never, // moduleRef
  );
  return { controller, jobs, savedRows };
}

const ORG: CurrentOrgCtx = { id: 'org-1', role: 'member' };
const USER = { id: 'user-1' };

describe('WebSurfaceController — createJob automation-defaults fallback', () => {
  it('absent autoApproveMode/autoMerge inherit the org defaults', async () => {
    const { controller, savedRows } = makeController({
      default_auto_approve_mode: 'ship',
      default_auto_merge: true,
    });

    await controller.createJob(
      ORG,
      USER as never,
      'repo-1',
      { firstMessage: 'hi' } as never,
      undefined,
    );

    expect(savedRows[0]).toMatchObject({
      auto_approve_mode: 'ship',
      auto_approve_by: 'user-1',
      auto_merge: true,
      auto_merge_by: 'user-1',
    });
  });

  it('an explicit request value wins over the org default', async () => {
    const { controller, savedRows } = makeController({
      default_auto_approve_mode: 'ship',
      default_auto_merge: true,
    });

    await controller.createJob(
      ORG,
      USER as never,
      'repo-1',
      { firstMessage: 'hi', autoApproveMode: 'off', autoMerge: false } as never,
      undefined,
    );

    expect(savedRows[0]).not.toHaveProperty('auto_approve_mode');
    expect(savedRows[0]).not.toHaveProperty('auto_merge');
  });

  it('falls back to off/false when the org row is missing', async () => {
    const { controller, savedRows } = makeController(null);

    await controller.createJob(
      ORG,
      USER as never,
      'repo-1',
      { firstMessage: 'hi' } as never,
      undefined,
    );

    expect(savedRows[0]).not.toHaveProperty('auto_approve_mode');
    expect(savedRows[0]).not.toHaveProperty('auto_merge');
  });

  it('rejects a present-but-invalid autoApproveMode rather than falling back to the org default', async () => {
    const { controller } = makeController({
      default_auto_approve_mode: 'ship',
      default_auto_merge: true,
    });

    await expect(
      controller.createJob(
        ORG,
        USER as never,
        'repo-1',
        { firstMessage: 'hi', autoApproveMode: 'bogus' } as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a present-but-invalid autoMerge rather than falling back to the org default', async () => {
    const { controller } = makeController({
      default_auto_approve_mode: 'ship',
      default_auto_merge: true,
    });

    await expect(
      controller.createJob(
        ORG,
        USER as never,
        'repo-1',
        { firstMessage: 'hi', autoMerge: 'bogus' } as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
