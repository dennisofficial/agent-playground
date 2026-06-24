import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';
import { OrganizationService } from './organization.service';
import type {
  AtlasOrgInvite,
  AtlasUser,
  Organization,
  OrganizationMember,
} from '../persistence/entities';

function makeSvc(opts: { invite?: Partial<AtlasOrgInvite>; alreadyMember?: boolean } = {}) {
  const inviteRows: AtlasOrgInvite[] = opts.invite
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
        } as AtlasOrgInvite,
      ]
    : [];
  const memberRows: OrganizationMember[] = opts.alreadyMember
    ? [{ org_id: 'O1', user_id: 'B', role: 'member' } as OrganizationMember]
    : [];

  const invites = {
    findOne: async ({ where }: { where: { token: string } }) =>
      inviteRows.find((i) => i.token === where.token) ?? null,
    create: (x: Partial<AtlasOrgInvite>) => x as AtlasOrgInvite,
    save: async (x: AtlasOrgInvite) => {
      const i = inviteRows.findIndex((r) => r.token === x.token);
      if (i >= 0) inviteRows[i] = x;
      else inviteRows.push(x);
      return x;
    },
  } as unknown as Repository<AtlasOrgInvite>;

  const members = {
    findOne: async ({ where }: { where: { org_id: string; user_id: string } }) =>
      memberRows.find((m) => m.org_id === where.org_id && m.user_id === where.user_id) ?? null,
    create: (x: Partial<OrganizationMember>) => x as OrganizationMember,
    save: async (x: OrganizationMember) => {
      memberRows.push(x);
      return x;
    },
  } as unknown as Repository<OrganizationMember>;

  const orgs = {
    findOne: async ({ where }: { where: { id: string } }) =>
      ({ id: where.id, name: 'HannibalAI', slug: 'hannibalai', status: 'onboarding' }) as Organization,
  } as unknown as Repository<Organization>;
  const users = {} as unknown as Repository<AtlasUser>;
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
