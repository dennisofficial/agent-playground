import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import { OrganizationService } from './organization.service';
import type {
  OrgInviteEntity,
  UserEntity,
  OrganizationEntity,
  OrganizationMemberEntity,
} from '../persistence/entities';

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
    ? [{ org_id: 'O1', user_id: 'B', role: 'member' } as OrganizationMemberEntity]
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
    findOne: async ({ where }: { where: { org_id: string; user_id: string } }) =>
      memberRows.find((m) => m.org_id === where.org_id && m.user_id === where.user_id) ?? null,
    create: (x: Partial<OrganizationMemberEntity>) => x as OrganizationMemberEntity,
    save: async (x: OrganizationMemberEntity) => {
      memberRows.push(x);
      return x;
    },
  } as unknown as Repository<OrganizationMemberEntity>;

  const orgRows: OrganizationEntity[] = opts.orgRows ?? [
    { id: 'O1', name: 'HannibalAI', slug: 'hannibalai', status: 'onboarding' } as OrganizationEntity,
  ];
  const orgs = {
    findOne: async ({ where }: { where: { id?: string; slug?: string } }) => {
      if (where.id !== undefined) return orgRows.find((o) => o.id === where.id) ?? null;
      if (where.slug !== undefined) return orgRows.find((o) => o.slug === where.slug) ?? null;
      return null;
    },
    create: (x: Partial<OrganizationEntity>) => x as OrganizationEntity,
    save: async (x: OrganizationEntity) => {
      const i = orgRows.findIndex((o) => o.id === x.id);
      if (i >= 0) orgRows[i] = x;
      else orgRows.push(x);
      return x;
    },
  } as unknown as Repository<OrganizationEntity>;
  const users = {} as unknown as Repository<UserEntity>;
  const env = { get: () => 'http://host' } as never;

  // Records the teardown side effects so the deleteOrg test can assert on them. `ThreadLifecycleService`
  // is pulled lazily via `ModuleRef.get(...)` in `deleteOrg`, so the mock ref just hands back this fake.
  const closed: Array<{ threadId: string; orgId: string }> = [];
  const threadLifecycle = {
    closeThread: async (threadId: string, orgId: string) => {
      closed.push({ threadId, orgId });
    },
  };
  const moduleRef = { get: () => threadLifecycle } as unknown as ModuleRef;

  const deletes: Array<{ entity: string; criteria: Record<string, unknown> }> = [];
  const manager = {
    delete: async (entity: { name: string }, criteria: Record<string, unknown>) => {
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
    moduleRef,
    env,
  );
  return { svc, inviteRows, memberRows, orgRows, closed, deletes };
}

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
    expect(memberRows).toContainEqual(expect.objectContaining({ org_id: 'O1', user_id: 'B', role: 'member' }));
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
    const { svc } = makeSvc({ invite: { accepted_at: new Date(), accepted_by: 'B' } });
    await expect(svc.acceptInvite('t1', 'C')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('OrganizationService rename', () => {
  it('updates the name (slug untouched) and folds in the caller role', async () => {
    const { svc, orgRows } = makeSvc();
    const out = await svc.rename('O1', { name: 'NewName' }, 'owner');
    expect(out).toEqual({ id: 'O1', slug: 'hannibalai', name: 'NewName', status: 'onboarding', role: 'owner' });
    expect(orgRows[0].name).toBe('NewName');
  });

  it('slugifies a new slug and keeps it unique against OTHER orgs', async () => {
    const { svc } = makeSvc({
      orgRows: [
        { id: 'O1', name: 'A', slug: 'a', status: 'onboarding' } as OrganizationEntity,
        { id: 'O2', name: 'Taken', slug: 'taken', status: 'active' } as OrganizationEntity,
      ],
    });
    const out = await svc.rename('O1', { slug: 'Taken!!' }, 'owner');
    expect(out.slug).toBe('taken-2'); // 'taken' is owned by O2, so suffix
  });

  it('throws NotFound when the org is gone', async () => {
    const { svc } = makeSvc();
    await expect(svc.rename('NOPE', { name: 'x' }, 'owner')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OrganizationService deleteOrg', () => {
  it('closes every thread then sweeps all org-scoped rows (org deleted last)', async () => {
    const { svc, closed, deletes } = makeSvc({ threadIds: ['T1', 'T2'] });
    await svc.deleteOrg('O1');

    // Threads are torn down (container + worktree) before the DB rows go.
    expect(closed).toEqual([
      { threadId: 'T1', orgId: 'O1' },
      { threadId: 'T2', orgId: 'O1' },
    ]);

    const entities = deletes.map((d) => d.entity);
    expect(entities).toContain('MessageEntity');
    expect(entities).toContain('ThreadEntity');
    expect(entities).toContain('RepoEntity');
    expect(entities).toContain('OrganizationMemberEntity');
    expect(entities.at(-1)).toBe('OrganizationEntity'); // org row deleted last
    // Messages are swept by thread_id, everything else by org_id.
    expect(deletes.find((d) => d.entity === 'MessageEntity')?.criteria).toMatchObject({ thread_id: expect.anything() });
    expect(deletes.find((d) => d.entity === 'ThreadEntity')?.criteria).toEqual({ org_id: 'O1' });
  });

  it('skips thread teardown + message delete when the org has no threads', async () => {
    const { svc, closed, deletes } = makeSvc({ threadIds: [] });
    await svc.deleteOrg('O1');
    expect(closed).toHaveLength(0);
    expect(deletes.map((d) => d.entity)).not.toContain('MessageEntity');
    expect(deletes.at(-1)?.entity).toBe('OrganizationEntity');
  });
});
