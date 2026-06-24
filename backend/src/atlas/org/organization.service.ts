import { EnvService } from '@core/config/env/env.service';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, IsNull, Repository } from 'typeorm';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasOrgInvite,
  AtlasUser,
  Organization,
  OrganizationMember,
} from '../persistence/entities';

/** An org as the web app sees it (the caller's role folded in). */
export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  role: string;
}

/** A member of an org (with the user's identity). */
export interface MemberView {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

/** A pending invite (with its copy-paste link). */
export interface InviteView {
  token: string;
  email: string;
  role: string;
  link: string;
  invitedBy: string;
  createdAt: Date;
}

/** What the accept screen previews about an invite. */
export interface InvitePreview {
  orgId: string;
  orgName: string;
  email: string;
  role: string;
  accepted: boolean;
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
 * Organizations + membership + invites — the user spine. Creating an org makes the creator its `owner`;
 * every org-scoped route is gated by `OrgMembershipGuard`, which resolves membership through this service.
 * Invites are copy-paste links (a token capability) redeemed by a logged-in user.
 */
@Injectable()
export class OrganizationService {
  constructor(
    @InjectRepository(Organization, ATLAS_CONNECTION)
    private readonly orgs: Repository<Organization>,
    @InjectRepository(OrganizationMember, ATLAS_CONNECTION)
    private readonly members: Repository<OrganizationMember>,
    @InjectRepository(AtlasOrgInvite, ATLAS_CONNECTION)
    private readonly invites: Repository<AtlasOrgInvite>,
    @InjectRepository(AtlasUser, ATLAS_CONNECTION)
    private readonly users: Repository<AtlasUser>,
    private readonly env: EnvService,
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

  /** The org's members, joined to the user identity. */
  async membersOf(orgId: string): Promise<MemberView[]> {
    const rows = await this.members.find({ where: { org_id: orgId } });
    if (rows.length === 0) return [];
    const users = await this.users.find({ where: { id: In(rows.map((m) => m.user_id)) } });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((m) => ({
      userId: m.user_id,
      email: byId.get(m.user_id)?.email ?? '',
      name: byId.get(m.user_id)?.name ?? null,
      role: m.role,
    }));
  }

  // ── invites ──────────────────────────────────────────────────────────────────────────────────────

  /** Create a copy-paste invite for `email`. Returns the link the operator shares. */
  async createInvite(
    orgId: string,
    email: string,
    role: string,
    invitedBy: string,
  ): Promise<InviteView> {
    const token = randomUUID();
    const row = await this.invites.save(
      this.invites.create({
        token,
        org_id: orgId,
        email: email.toLowerCase(),
        role: role === 'admin' ? 'admin' : 'member',
        invited_by: invitedBy,
        accepted_at: null,
        accepted_by: null,
      }),
    );
    return this.toInviteView(row);
  }

  /** Pending (unredeemed) invites for an org. */
  async listInvites(orgId: string): Promise<InviteView[]> {
    const rows = await this.invites.find({
      where: { org_id: orgId, accepted_at: IsNull() },
      order: { created_at: 'DESC' },
    });
    return rows.map((r) => this.toInviteView(r));
  }

  /** Preview an invite for the accept screen (null when unknown). */
  async getInvite(token: string): Promise<InvitePreview | null> {
    const invite = await this.invites.findOne({ where: { token } });
    if (!invite) return null;
    const org = await this.orgs.findOne({ where: { id: invite.org_id } });
    return {
      orgId: invite.org_id,
      orgName: org?.name ?? invite.org_id,
      email: invite.email,
      role: invite.role,
      accepted: invite.accepted_at != null,
    };
  }

  /** Redeem an invite as `userId` — creates the membership (idempotent). Returns the org id. */
  async acceptInvite(token: string, userId: string): Promise<{ orgId: string }> {
    const invite = await this.invites.findOne({ where: { token } });
    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.accepted_at && invite.accepted_by !== userId) {
      throw new ConflictException('Invite already used');
    }

    const existing = await this.members.findOne({
      where: { org_id: invite.org_id, user_id: userId },
    });
    if (!existing) {
      await this.members.save(
        this.members.create({ org_id: invite.org_id, user_id: userId, role: invite.role }),
      );
    }
    if (!invite.accepted_at) {
      invite.accepted_at = new Date();
      invite.accepted_by = userId;
      await this.invites.save(invite);
    }
    return { orgId: invite.org_id };
  }

  /** Revoke a pending invite. */
  async revokeInvite(orgId: string, token: string): Promise<void> {
    await this.invites.delete({ token, org_id: orgId });
  }

  private toInviteView(row: AtlasOrgInvite): InviteView {
    const base = this.env.get('FRONTEND_HOST') ?? '';
    return {
      token: row.token,
      email: row.email,
      role: row.role,
      link: `${base}/invites/${row.token}`,
      invitedBy: row.invited_by,
      createdAt: row.created_at,
    };
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
