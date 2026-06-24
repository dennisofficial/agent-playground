import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { Organization, OrganizationMember } from '../persistence/entities';

/** An org as the web app sees it (the caller's role folded in). */
export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  role: string;
}

/** Slugify an org name into a URL-safe handle. */
function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'org'
  );
}

/**
 * Organizations + membership — the user spine. Creating an org makes the creator its `owner`; every
 * org-scoped route is gated by `OrgMembershipGuard`, which resolves membership through this service.
 */
@Injectable()
export class OrganizationService {
  constructor(
    @InjectRepository(Organization, ATLAS_CONNECTION)
    private readonly orgs: Repository<Organization>,
    @InjectRepository(OrganizationMember, ATLAS_CONNECTION)
    private readonly members: Repository<OrganizationMember>,
  ) {}

  /** Create an org (status `onboarding`) and make `userId` its owner. */
  async create(userId: string, name: string): Promise<OrgSummary> {
    const id = randomUUID();
    const slug = await this.uniqueSlug(slugifyName(name));
    const org = await this.orgs.save(
      this.orgs.create({ id, name, slug, status: 'onboarding' }),
    );
    await this.members.save(
      this.members.create({ org_id: id, user_id: userId, role: 'owner' }),
    );
    return { id: org.id, slug: org.slug, name: org.name, status: org.status, role: 'owner' };
  }

  /** Every org the user belongs to, with their role. */
  async listForUser(userId: string): Promise<OrgSummary[]> {
    const memberships = await this.members.find({ where: { user_id: userId } });
    if (memberships.length === 0) return [];
    const roleById = new Map(memberships.map((m) => [m.org_id, m.role]));
    const orgs = await this.orgs.find({ where: { id: In([...roleById.keys()]) } });
    return orgs.map((o) => ({
      id: o.id,
      slug: o.slug,
      name: o.name,
      status: o.status,
      role: roleById.get(o.id) ?? 'member',
    }));
  }

  /** The membership row (or null) — the guard's authorization check. */
  async membership(userId: string, orgId: string): Promise<OrganizationMember | null> {
    return this.members.findOne({ where: { org_id: orgId, user_id: userId } });
  }

  /** The org row by id (or null). */
  async get(orgId: string): Promise<Organization | null> {
    return this.orgs.findOne({ where: { id: orgId } });
  }

  private async uniqueSlug(base: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      const exists = await this.orgs.findOne({ where: { slug } });
      if (!exists) return slug;
    }
    return `${base}-${randomUUID().slice(0, 6)}`;
  }
}
