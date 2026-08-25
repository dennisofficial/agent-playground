import { PrismaService } from '@lib/prisma/prisma.service';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  EOrgRole,
  EOrgStatus,
  type MemberView,
  type OrgSummary,
  type UpdateOrgDto,
} from '@workspace/shared';
import type { OrganizationModel } from '../../generated/prisma/models';
import { ScopedDb } from '../../_lib/pgbase/scoped-db';

@Injectable()
export class OrgService {
  constructor(
    private readonly scopedDb: ScopedDb,
    private readonly prismaService: PrismaService,
  ) {}

  /** Orgs the user belongs to, each tagged with the user's role. Drives GET /auth/session. */
  async listForUser(userId: string): Promise<OrgSummary[]> {
    const memberships = await this.scopedDb.organizationMember.findMany({ where: { userId } });
    if (memberships.length === 0) return [];
    const roleById = new Map(memberships.map((m) => [m.orgId, m.role as EOrgRole]));
    const orgs = await this.scopedDb.organization.findMany({
      where: { id: { in: [...roleById.keys()] } },
    });
    return orgs.map((o) => this.toSummary(o, roleById.get(o.id) ?? EOrgRole.MEMBER));
  }

  /**
   * Create an org and make the caller its owner. Uses `PrismaService`: the caller isn't a member of
   * the org yet at the moment of creation, so it isn't visible under their own claims and `ScopedDb`
   * couldn't see it to write the membership row either.
   */
  async create(userId: string, name: string): Promise<OrgSummary> {
    const org = await this.prismaService.organization.create({
      data: { name, status: EOrgStatus.ONBOARDING },
    });
    await this.prismaService.organizationMember.create({
      data: { orgId: org.id, userId, role: EOrgRole.OWNER },
    });
    return this.toSummary(org, EOrgRole.OWNER);
  }

  async update(userId: string, orgId: string, patch: UpdateOrgDto): Promise<OrgSummary> {
    const role = await this.assertOwner(userId, orgId);
    const org = await this.scopedDb.organization.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');

    const saved = await this.scopedDb.organization.update({
      where: { id: orgId },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.defaultAutoApprove !== undefined && {
          defaultAutoApprove: patch.defaultAutoApprove,
        }),
        ...(patch.defaultAutoShip !== undefined && { defaultAutoShip: patch.defaultAutoShip }),
        ...(patch.defaultAutoMerge !== undefined && { defaultAutoMerge: patch.defaultAutoMerge }),
      },
    });
    return this.toSummary(saved, role);
  }

  async remove(userId: string, orgId: string): Promise<void> {
    await this.assertOwner(userId, orgId);
    await this.scopedDb.organization.delete({ where: { id: orgId } }); // members cascade via FK onDelete: CASCADE
  }

  async membersOf(userId: string, orgId: string): Promise<MemberView[]> {
    await this.assertMember(userId, orgId);
    const memberships = await this.scopedDb.organizationMember.findMany({ where: { orgId } });
    // User is NO_CLIENT_ACCESS, so it goes through PrismaService — scoped explicitly to the member
    // ids the org-scoped membership query above already resolved, not to every user in the table.
    const users = await this.prismaService.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, email: true, name: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    return memberships.map((m) => {
      const user = userById.get(m.userId);
      return {
        userId: m.userId,
        email: user?.email ?? '',
        name: user?.name ?? null,
        role: m.role,
      };
    });
  }

  /** Throw unless the user is a member of the org; returns their role. */
  async assertMember(userId: string, orgId: string): Promise<EOrgRole> {
    const membership = await this.scopedDb.organizationMember.findUnique({
      where: { orgId_userId: { orgId, userId } },
    });
    if (!membership) throw new ForbiddenException('Not a member of this organization');
    return membership.role as EOrgRole;
  }

  /** Throw unless the user owns the org; returns OWNER. */
  async assertOwner(userId: string, orgId: string): Promise<EOrgRole> {
    const role = await this.assertMember(userId, orgId);
    if (role !== EOrgRole.OWNER) throw new ForbiddenException('Owner role required');
    return role;
  }

  /**
   * Whether the user is an OWNER of at least one of the given orgs (empty list → false).
   *
   * Unscoped on purpose: the sole caller is the GitHub App OAuth callback, a `@Public()` route whose
   * `userId` comes from stashed callback state rather than from the ambient request — which may not
   * be authenticated at all. Under ScopedDb this would silently answer "no" for an anonymous
   * callback (empty claims match no rows), turning a legitimate installation reuse into a refusal.
   * The question asked here is about a named user, so the filter is the explicit `userId` below and
   * the answer must not depend on who is holding the request.
   */
  async ownsAnyOf(userId: string, orgIds: string[]): Promise<boolean> {
    if (orgIds.length === 0) return false;
    const owned = await this.prismaService.organizationMember.findFirst({
      where: { userId, role: EOrgRole.OWNER, orgId: { in: orgIds } },
    });
    return owned !== null;
  }

  private toSummary(o: OrganizationModel, role: EOrgRole): OrgSummary {
    return {
      id: o.id,
      name: o.name,
      status: o.status,
      role,
      defaultAutoApprove: o.defaultAutoApprove,
      defaultAutoShip: o.defaultAutoShip,
      defaultAutoMerge: o.defaultAutoMerge,
    };
  }
}
