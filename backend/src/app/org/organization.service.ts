import { EnvService } from '@core/config/env/env.service';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  OrgInviteEntity,
  ThreadEntity,
  UserEntity,
  OrganizationEntity,
  OrganizationMemberEntity,
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
  invitedBy: string | null;
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
    @InjectRepository(OrganizationEntity, DB_CONNECTION)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(OrganizationMemberEntity, DB_CONNECTION)
    private readonly members: Repository<OrganizationMemberEntity>,
    @InjectRepository(OrgInviteEntity, DB_CONNECTION)
    private readonly invites: Repository<OrgInviteEntity>,
    @InjectRepository(UserEntity, DB_CONNECTION)
    private readonly users: Repository<UserEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    // `ThreadLifecycleService` is resolved LAZILY in `deleteOrg` via this ref + a dynamic `import()`.
    // A STATIC import of the driver service would close an ES module cycle
    // (organization.service → driver/thread-lifecycle → onboarding barrel → onboarding controllers →
    // org-membership.guard → organization.service), which leaves `OrganizationService` undefined at boot.
    // `ModuleRef` is core (no module dependency) and the dynamic import is evaluated after boot.
    private readonly moduleRef: ModuleRef,
    private readonly env: EnvService,
  ) {}

  /** Create an org (status `onboarding`) and make `userId` its owner. */
  async create(userId: string, name: string): Promise<OrgSummary> {
    const slug = await this.uniqueSlug(slugifyName(name));
    const org = await this.orgs.save(
      this.orgs.create({ name, slug, status: 'onboarding' }), // id is DB-generated (uuid)
    );
    await this.members.save(
      this.members.create({ org_id: org.id, user_id: userId, role: 'owner' }),
    );
    return { id: org.id, slug: org.slug, name: org.name, status: org.status, role: 'owner' };
  }

  /**
   * Rename / re-slug an org (owner-only at the controller). `name` is re-validated at the DTO; `slug`, when
   * given, is slugified + kept unique (excluding this org). `role` is the caller's role, folded into the
   * returned summary so it's complete. Throws `NotFoundException` if the org is gone.
   */
  async rename(
    orgId: string,
    patch: { name?: string; slug?: string },
    role: string,
  ): Promise<OrgSummary> {
    const org = await this.orgs.findOne({ where: { id: orgId } });
    if (!org) throw new NotFoundException('OrganizationEntity not found');

    if (patch.name !== undefined) org.name = patch.name;
    if (patch.slug !== undefined) {
      const desired = slugifyName(patch.slug);
      if (desired !== org.slug) org.slug = await this.uniqueSlug(desired, orgId);
    }
    const saved = await this.orgs.save(org);
    return { id: saved.id, slug: saved.slug, name: saved.name, status: saved.status, role };
  }

  /**
   * Delete an org and everything under it. DB FK cascades (org → repos → threads → messages/sections/
   * phases/decision_records/stimuli/sandboxes, plus members/credentials/invites/memory) do the row sweep,
   * so this just CLOSES the threads first (tearing down each per-thread container + git worktree —
   * side-effecting, not part of the cascade) then deletes the org row. Idempotent-ish: a missing org
   * deletes nothing.
   */
  async deleteOrg(orgId: string): Promise<void> {
    const threads = await this.dataSource
      .getRepository(ThreadEntity)
      .find({ where: { org_id: orgId }, select: { id: true } });
    const threadIds = threads.map((t) => t.id);

    // Side-effecting teardown (containers + worktrees) — before the cascade removes the rows. Resolve the
    // driver service lazily (see the constructor note on the cycle); `strict: false` searches the whole
    // app. `.js` extension: a relative dynamic `import()` carries ESM semantics under `moduleResolution:
    // nodenext`, which requires the explicit extension (static CJS imports don't).
    const { ThreadLifecycleService } = await import('../driver/thread-lifecycle.service.js');
    const threadLifecycle = this.moduleRef.get(ThreadLifecycleService, { strict: false });
    for (const threadId of threadIds) {
      await threadLifecycle.closeThread(threadId, orgId);
    }

    // One delete — the FK ON DELETE CASCADE chain removes every dependent row.
    await this.orgs.delete({ id: orgId });
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
  async membership(userId: string, orgId: string): Promise<OrganizationMemberEntity | null> {
    return this.members.findOne({ where: { org_id: orgId, user_id: userId } });
  }

  /** The org row by id (or null). */
  async get(orgId: string): Promise<OrganizationEntity | null> {
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

  /** Create a copy-paste invite for `email`. Invites always grant `member` (the only invitable role —
   *  `owner` is the creator). Returns the link the operator shares. */
  async createInvite(orgId: string, email: string, invitedBy: string): Promise<InviteView> {
    const token = randomUUID();
    const row = await this.invites.save(
      this.invites.create({
        token,
        org_id: orgId,
        email: email.toLowerCase(),
        role: 'member',
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

  private toInviteView(row: OrgInviteEntity): InviteView {
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

  /** A slug not used by any OTHER org (`exceptId` lets an org keep/reshape its own slug on rename). */
  private async uniqueSlug(base: string, exceptId?: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      const exists = await this.orgs.findOne({ where: { slug } });
      if (!exists || exists.id === exceptId) return slug;
    }
    return `${base}-${randomUUID().slice(0, 6)}`;
  }
}
