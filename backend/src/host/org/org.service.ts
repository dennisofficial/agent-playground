import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  EOrgRole,
  EOrgStatus,
  type MemberView,
  type OrgSummary,
  type UpdateOrgDto,
} from '@workspace/shared';
import { In } from 'typeorm';
import { OrganizationMemberRepo } from '../../_lib/database/entities/organization-member.entity';
import { Organization, OrganizationRepo } from '../../_lib/database/entities/organization.entity';

@Injectable()
export class OrgService {
  constructor(
    private readonly orgs: OrganizationRepo,
    private readonly members: OrganizationMemberRepo,
  ) {}

  /** Orgs the user belongs to, each tagged with the user's role. Drives GET /auth/session. */
  async listForUser(userId: string): Promise<OrgSummary[]> {
    const memberships = await this.members.find({ where: { userId } });
    if (memberships.length === 0) return [];
    const roleById = new Map(memberships.map((m) => [m.orgId, m.role]));
    const orgs = await this.orgs.find({ where: { id: In([...roleById.keys()]) } });
    return orgs.map((o) => this.toSummary(o, roleById.get(o.id) ?? EOrgRole.MEMBER));
  }

  /** Create an org and make the caller its owner. */
  async create(userId: string, name: string): Promise<OrgSummary> {
    const org = await this.orgs.save(this.orgs.create({ name, status: EOrgStatus.ONBOARDING }));
    await this.members.save(this.members.create({ orgId: org.id, userId, role: EOrgRole.OWNER }));
    return this.toSummary(org, EOrgRole.OWNER);
  }

  async update(userId: string, orgId: string, patch: UpdateOrgDto): Promise<OrgSummary> {
    const role = await this.assertOwner(userId, orgId);
    const org = await this.orgs.findOne({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');

    if (patch.name !== undefined) org.name = patch.name;
    if (patch.defaultAutoApprove !== undefined) org.defaultAutoApprove = patch.defaultAutoApprove;
    if (patch.defaultAutoShip !== undefined) org.defaultAutoShip = patch.defaultAutoShip;
    if (patch.defaultAutoMerge !== undefined) org.defaultAutoMerge = patch.defaultAutoMerge;

    const saved = await this.orgs.save(org);
    return this.toSummary(saved, role);
  }

  async remove(userId: string, orgId: string): Promise<void> {
    await this.assertOwner(userId, orgId);
    await this.orgs.delete({ id: orgId }); // members cascade via FK onDelete: CASCADE
  }

  async membersOf(userId: string, orgId: string): Promise<MemberView[]> {
    await this.assertMember(userId, orgId);
    const rows = await this.members.find({ where: { orgId }, relations: { user: true } });
    return rows.map((m) => ({
      userId: m.userId,
      email: m.user?.email ?? '',
      name: m.user?.name ?? null,
      role: m.role,
    }));
  }

  /** Throw unless the user is a member of the org; returns their role. */
  async assertMember(userId: string, orgId: string): Promise<EOrgRole> {
    const membership = await this.members.findOne({ where: { orgId, userId } });
    if (!membership) throw new ForbiddenException('Not a member of this organization');
    return membership.role;
  }

  /** Throw unless the user owns the org; returns OWNER. */
  async assertOwner(userId: string, orgId: string): Promise<EOrgRole> {
    const role = await this.assertMember(userId, orgId);
    if (role !== EOrgRole.OWNER) throw new ForbiddenException('Owner role required');
    return role;
  }

  private toSummary(o: Organization, role: EOrgRole): OrgSummary {
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
