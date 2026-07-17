import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import type { JobTeardownPort } from '../../driver/job-teardown.port';
import { OrganizationService } from '../organization.service';
import type {
  OrgInviteEntity,
  UserEntity,
  OrganizationEntity,
  OrganizationMemberEntity,
} from '../../persistence/entities';

function makeSvc(
  opts: {
    invite?: Partial<OrgInviteEntity>;
    alreadyMember?: boolean;
    orgRows?: OrganizationEntity[];
    threadIds?: string[];
  } = {},
) {
  const inviteRows: OrgInviteEntity[] = opts.invite
    ? [
        {
          token: 't1',
          org_id: 'O1',
          email: 'b@x.com',
          role: 'member',
          invited_by: 'A',
          accepted_at: null,
          accepted_by: null,
          ...opts.invite,
        } as OrgInviteEntity,
      ]
    : [];
  const memberRows: OrganizationMemberEntity[] = opts.alreadyMember
    ? [
        {
          org_id: 'O1',
          user_id: 'B',
          role: 'member',
        } as OrganizationMemberEntity,
      ]
    : [];

  const invites = {
    findOne: async ({ where }: { where: { token: string } }) =>
      inviteRows.find((i) => i.token === where.token) ?? null,
    create: (x: Partial<OrgInviteEntity>) => x as OrgInviteEntity,
    save: async (x: OrgInviteEntity) => {
      const i = inviteRows.findIndex((r) => r.token === x.token);
      if (i >= 0) inviteRows[i] = x;
      else inviteRows.push(x);
      return x;
    },
  } as unknown as Repository<OrgInviteEntity>;

  const members = {
    findOne: async ({
      where,
    }: {
      where: { org_id: string; user_id: string };
    }) =>
      memberRows.find(
        (m) => m.org_id === where.org_id && m.user_id === where.user_id,
      ) ?? null,
    find: async ({ where }: { where: { user_id: string } }) =>
      memberRows.filter((m) => m.user_id === where.user_id),
    create: (x: Partial<OrganizationMemberEntity>) =>
      x as OrganizationMemberEntity,
    save: async (x: OrganizationMemberEntity) => {
      memberRows.push(x);
      return x;
    },
  } as unknown as Repository<OrganizationMemberEntity>;

  const orgRows: OrganizationEntity[] = opts.orgRows ?? [
    {
      id: 'O1',
      name: 'HannibalAI',
      slug: 'hannibalai',
      status: 'onboarding',
    } as OrganizationEntity,
  ];
  const orgDeletes: Array<Record<string, unknown>> = [];
  const orgs = {
    findOne: async ({ where }: { where: { id?: string; slug?: string } }) => {
      if (where.id !== undefined)
        return orgRows.find((o) => o.id === where.id) ?? null;
      if (where.slug !== undefined)
        return orgRows.find((o) => o.slug === where.slug) ?? null;
      return null;
    },
    find: async ({ where }: { where: { id: { value: string[] } } }) => {
      const ids = new Set(where.id.value);
      return orgRows.filter((o) => ids.has(o.id));
    },
    create: (x: Partial<OrganizationEntity>) => x as OrganizationEntity,
    save: async (x: OrganizationEntity) => {
      const i = orgRows.findIndex((o) => o.id === x.id);
      if (i >= 0) orgRows[i] = x;
      else orgRows.push(x);
      return x;
    },
    delete: async (criteria: Record<string, unknown>) => {
      orgDeletes.push(criteria);
      return { affected: 1 };
    },
  } as unknown as Repository<OrganizationEntity>;
  const users = {} as unknown as Repository<UserEntity>;
  const env = { get: () => 'http://host' } as never;

  // Records the per-thread deep deletes so the deleteOrg test can assert on them. `deleteOrg` reaches the
  // driver's physical teardown through the injected `JOB_TEARDOWN` port; the fake implements that port.
  const deepDeleted: Array<{ jobId: string; orgId: string }> = [];
  const jobTeardown: JobTeardownPort = {
    deleteJobDeep: async (jobId: string, orgId: string) => {
      deepDeleted.push({ jobId, orgId });
    },
  };

  const deletes: Array<{ entity: string; criteria: Record<string, unknown> }> =
    [];
  const manager = {
    delete: async (
      entity: { name: string },
      criteria: Record<string, unknown>,
    ) => {
      deletes.push({ entity: entity.name, criteria });
      return { affected: 1 };
    },
  };
  const threadRows = (opts.threadIds ?? []).map((id) => ({ id }));
  const dataSource = {
    getRepository: () => ({ find: async () => threadRows }),
    transaction: async (cb: (m: typeof manager) => Promise<void>) => {
      await cb(manager);
    },
  } as unknown as DataSource;

  const svc = new OrganizationService(
    orgs,
    members,
    invites,
    users,
    dataSource,
    jobTeardown,
    env,
  );
  return {
    svc,
    inviteRows,
    memberRows,
    orgRows,
    deepDeleted,
    deletes,
    orgDeletes,
  };
}

describe('OrganizationService create', () => {
  it('returns off/false automation defaults for a fresh org', async () => {
    const { svc } = makeSvc({ orgRows: [] });
    const out = await svc.create('U1', 'HannibalAI');
    expect(out.defaultAutoApproveMode).toBe('off');
    expect(out.defaultAutoMerge).toBe(false);
  });
});

describe('OrganizationService listForUser', () => {
  it("carries each org row's automation defaults alongside the caller role", async () => {
    const { svc } = makeSvc({
      orgRows: [
        {
          id: 'O1',
          name: 'HannibalAI',
          slug: 'hannibalai',
          status: 'onboarding',
          default_auto_approve_mode: 'plan',
          default_auto_merge: true,
        } as OrganizationEntity,
      ],
      alreadyMember: true,
    });
    const out = await svc.listForUser('B');
    expect(out).toEqual([
      {
        id: 'O1',
        slug: 'hannibalai',
        name: 'HannibalAI',
        status: 'onboarding',
        role: 'member',
        defaultAutoApproveMode: 'plan',
        defaultAutoMerge: true,
      },
    ]);
  });
});

describe('OrganizationService invites', () => {
  it('createInvite returns a copy-paste link with FRONTEND_HOST + the token', async () => {
    const { svc } = makeSvc();
    const invite = await svc.createInvite('O1', 'B@X.com', 'A');
    expect(invite.email).toBe('b@x.com'); // lower-cased
    expect(invite.link).toBe(`http://host/invites/${invite.token}`);
  });

  it('acceptInvite creates the membership and marks the invite redeemed', async () => {
    const { svc, inviteRows, memberRows } = makeSvc({ invite: {} });
    const { orgId } = await svc.acceptInvite('t1', 'B');
    expect(orgId).toBe('O1');
    expect(memberRows).toContainEqual(
      expect.objectContaining({ org_id: 'O1', user_id: 'B', role: 'member' }),
    );
    expect(inviteRows[0].accepted_by).toBe('B');
    expect(inviteRows[0].accepted_at).not.toBeNull();
  });

  it('acceptInvite is idempotent for the same user (no duplicate membership)', async () => {
    const { svc, memberRows } = makeSvc({ invite: {} });
    await svc.acceptInvite('t1', 'B');
    await svc.acceptInvite('t1', 'B');
    expect(memberRows.filter((m) => m.user_id === 'B')).toHaveLength(1);
  });

  it('acceptInvite rejects a different user once redeemed', async () => {
    const { svc } = makeSvc({
      invite: { accepted_at: new Date(), accepted_by: 'B' },
    });
    await expect(svc.acceptInvite('t1', 'C')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('OrganizationService rename', () => {
  it('updates the name (slug untouched) and folds in the caller role', async () => {
    const { svc, orgRows } = makeSvc({
      orgRows: [
        {
          id: 'O1',
          name: 'HannibalAI',
          slug: 'hannibalai',
          status: 'onboarding',
          default_auto_approve_mode: 'off',
          default_auto_merge: false,
        } as OrganizationEntity,
      ],
    });
    const out = await svc.rename('O1', { name: 'NewName' }, 'owner');
    expect(out).toEqual({
      id: 'O1',
      slug: 'hannibalai',
      name: 'NewName',
      status: 'onboarding',
      role: 'owner',
      defaultAutoApproveMode: 'off',
      defaultAutoMerge: false,
    });
    expect(orgRows[0].name).toBe('NewName');
  });

  it('sets default_auto_approve_mode / default_auto_merge when the patch includes them', async () => {
    const { svc, orgRows } = makeSvc({
      orgRows: [
        {
          id: 'O1',
          name: 'HannibalAI',
          slug: 'hannibalai',
          status: 'onboarding',
          default_auto_approve_mode: 'off',
          default_auto_merge: false,
        } as OrganizationEntity,
      ],
    });
    const out = await svc.rename(
      'O1',
      { defaultAutoApproveMode: 'ship', defaultAutoMerge: true },
      'owner',
    );
    expect(out.defaultAutoApproveMode).toBe('ship');
    expect(out.defaultAutoMerge).toBe(true);
    expect(orgRows[0].default_auto_approve_mode).toBe('ship');
    expect(orgRows[0].default_auto_merge).toBe(true);
  });

  it('leaves default_auto_approve_mode / default_auto_merge untouched when the patch omits them', async () => {
    const { svc, orgRows } = makeSvc({
      orgRows: [
        {
          id: 'O1',
          name: 'HannibalAI',
          slug: 'hannibalai',
          status: 'onboarding',
          default_auto_approve_mode: 'plan',
          default_auto_merge: true,
        } as OrganizationEntity,
      ],
    });
    const out = await svc.rename('O1', { name: 'NewName' }, 'owner');
    expect(out.defaultAutoApproveMode).toBe('plan');
    expect(out.defaultAutoMerge).toBe(true);
    expect(orgRows[0].default_auto_approve_mode).toBe('plan');
    expect(orgRows[0].default_auto_merge).toBe(true);
  });

  it('slugifies a new slug and keeps it unique against OTHER orgs', async () => {
    const { svc } = makeSvc({
      orgRows: [
        {
          id: 'O1',
          name: 'A',
          slug: 'a',
          status: 'onboarding',
        } as OrganizationEntity,
        {
          id: 'O2',
          name: 'Taken',
          slug: 'taken',
          status: 'active',
        } as OrganizationEntity,
      ],
    });
    const out = await svc.rename('O1', { slug: 'Taken!!' }, 'owner');
    expect(out.slug).toBe('taken-2'); // 'taken' is owned by O2, so suffix
  });

  it('throws NotFound when the org is gone', async () => {
    const { svc } = makeSvc();
    await expect(
      svc.rename('NOPE', { name: 'x' }, 'owner'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OrganizationService deleteOrg', () => {
  // The schema now carries FK ON DELETE CASCADE, so deleteOrg does the physical per-thread teardown then
  // deletes the org ROW — the database cascades every remaining org-scoped row. There is no explicit
  // per-table app-side sweep anymore.
  it('tears down every thread, then deletes the org row (FK cascade sweeps the rest)', async () => {
    const { svc, deepDeleted, deletes, orgDeletes } = makeSvc({
      threadIds: ['T1', 'T2'],
    });
    await svc.deleteOrg('O1');

    // Each thread is deep-deleted (container + worktree teardown; its rows cascade) before the org row.
    expect(deepDeleted).toEqual([
      { jobId: 'T1', orgId: 'O1' },
      { jobId: 'T2', orgId: 'O1' },
    ]);

    // The org row is deleted exactly once; FK cascade removes the rest. No explicit per-table sweep runs,
    // and `users` is never touched (no FK from users → org).
    expect(orgDeletes).toEqual([{ id: 'O1' }]);
    expect(deletes).toHaveLength(0);
  });

  it('still deletes the org row when the org has no threads', async () => {
    const { svc, deepDeleted, orgDeletes } = makeSvc({ threadIds: [] });
    await svc.deleteOrg('O1');
    expect(deepDeleted).toHaveLength(0);
    expect(orgDeletes).toEqual([{ id: 'O1' }]);
  });
});
