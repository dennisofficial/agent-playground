import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';
import { OrganizationService } from './organization.service';
import type {
  OrgInviteEntity,
  UserEntity,
  OrganizationEntity,
  OrganizationMemberEntity,
} from '../persistence/entities';

function makeSvc(opts: { invite?: Partial<OrgInviteEntity>; alreadyMember?: boolean } = {}) {
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

  const orgs = {
    findOne: async ({ where }: { where: { id: string } }) =>
      ({ id: where.id, name: 'HannibalAI', slug: 'hannibalai', status: 'onboarding' }) as OrganizationEntity,
  } as unknown as Repository<OrganizationEntity>;
  const users = {} as unknown as Repository<UserEntity>;
  const env = { get: () => 'http://host' } as never;

  const svc = new OrganizationService(orgs, members, invites, users, env);
  return { svc, inviteRows, memberRows };
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
