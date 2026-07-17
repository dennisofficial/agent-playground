import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { MemberView, OrgSummary } from '@workspace/shared';
import { randomUUID } from 'node:crypto';
import { In } from 'typeorm';
import type { UpdateOrgDto } from './dto/org.dto';
import {
  OrganizationMember,
  OrganizationMemberRepo,
} from './entities/organization-member.entity';
import { Organization, OrganizationRepo } from './entities/organization.entity';

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'org'
  );
}

@Injectable()
export class OrganizationService {
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
    return orgs.map((o) => this.toSummary(o, roleById.get(o.id) ?? 'member'));
  }

  /** Create an org and make the caller its owner. */
  async create(userId: string, name: string): Promise<OrgSummary> {
    const slug = await this.uniqueSlug(slugify(name));
    const org = await this.orgs.save(this.orgs.create({ name, slug, status: 'onboarding' }));
    await this.members.save(this.members.create({ orgId: org.id, userId, role: 'owner' }));
    return this.toSummary(org, 'owner');
  }

  async update(userId: string, orgId: string, patch: UpdateOrgDto): Promise<OrgSummary> {
    const role = await this.assertOwner(userId, orgId);
    const org = await this.orgs.findOne({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');

    if (patch.name !== undefined) org.name = patch.name;
    if (patch.slug !== undefined) {
      const desired = slugify(patch.slug);
      if (desired !== org.slug) org.slug = await this.uniqueSlug(desired, orgId);
    }
    if (patch.defaultAutoApproveMode !== undefined) {
      org.defaultAutoApproveMode = patch.defaultAutoApproveMode;
    }
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
  async assertMember(userId: string, orgId: string): Promise<string> {
    const membership = await this.members.findOne({ where: { orgId, userId } });
    if (!membership) throw new ForbiddenException('Not a member of this organization');
    return membership.role;
  }

  /** Throw unless the user owns the org; returns 'owner'. */
  async assertOwner(userId: string, orgId: string): Promise<string> {
    const role = await this.assertMember(userId, orgId);
    if (role !== 'owner') throw new ForbiddenException('Owner role required');
    return role;
  }

  private toSummary(o: Organization, role: string): OrgSummary {
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      status: o.status,
      role,
      defaultAutoApproveMode: o.defaultAutoApproveMode,
      defaultAutoMerge: o.defaultAutoMerge,
    };
  }

  private async uniqueSlug(base: string, exceptId?: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      const exists = await this.orgs.findOne({ where: { slug } });
      if (!exists || exists.id === exceptId) return slug;
    }
    return `${base}-${randomUUID().slice(0, 6)}`;
  }
}
