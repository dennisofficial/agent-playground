import { EnvService } from '@core/config/env/env.service';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { AutoApproveMode } from '@workspace/shared';
import { randomUUID } from 'node:crypto';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { JOB_TEARDOWN, type JobTeardownPort } from '../driver/job-teardown.port';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  JobEntity,
  OrganizationEntity,
  OrganizationMemberEntity,
  OrgInviteEntity,
  UserEntity,
} from '../persistence/entities';

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  role: string;
  defaultAutoApproveMode: AutoApproveMode;
  defaultAutoMerge: boolean;
}

export interface MemberView {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

export interface InviteView {
  token: string;
  email: string;
  role: string;
  link: string;
  invitedBy: string | null;
  createdAt: Date;
}

export interface InvitePreview {
  orgId: string;
  orgName: string;
  email: string;
  role: string;
  accepted: boolean;
}

function slugifyName(name: string): string {
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
  private readonly logger = new Logger(OrganizationService.name);

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
    @Inject(JOB_TEARDOWN) private readonly jobTeardown: JobTeardownPort,
    private readonly env: EnvService,
  ) {}

  async create(userId: string, name: string): Promise<OrgSummary> {
    const slug = await this.uniqueSlug(slugifyName(name));
    const org = await this.orgs.save(
      this.orgs.create({ name, slug, status: 'onboarding' }), // id is DB-generated (uuid)
    );
    await this.members.save(
      this.members.create({ org_id: org.id, user_id: userId, role: 'owner' }),
    );
    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      status: org.status,
      role: 'owner',
      defaultAutoApproveMode: org.default_auto_approve_mode ?? 'off',
      defaultAutoMerge: org.default_auto_merge ?? false,
    };
  }

  async rename(
    orgId: string,
    patch: {
      name?: string;
      slug?: string;
      defaultAutoApproveMode?: AutoApproveMode;
      defaultAutoMerge?: boolean;
    },
    role: string,
  ): Promise<OrgSummary> {
    const org = await this.orgs.findOne({ where: { id: orgId } });
    if (!org) throw new NotFoundException('OrganizationEntity not found');

    if (patch.name !== undefined) org.name = patch.name;
    if (patch.slug !== undefined) {
      const desired = slugifyName(patch.slug);
      if (desired !== org.slug) org.slug = await this.uniqueSlug(desired, orgId);
    }
    if (patch.defaultAutoApproveMode !== undefined) {
      org.default_auto_approve_mode = patch.defaultAutoApproveMode;
    }
    if (patch.defaultAutoMerge !== undefined) org.default_auto_merge = patch.defaultAutoMerge;
    const saved = await this.orgs.save(org);
    return {
      id: saved.id,
      slug: saved.slug,
      name: saved.name,
      status: saved.status,
      role,
      defaultAutoApproveMode: saved.default_auto_approve_mode,
      defaultAutoMerge: saved.default_auto_merge,
    };
  }

  async deleteOrg(orgId: string): Promise<void> {
    const threads = await this.dataSource
      .getRepository(JobEntity)
      .find({ where: { org_id: orgId }, select: { id: true } });

    for (const { id } of threads) {
      await this.jobTeardown.deleteJobDeep(id, orgId);
    }

    await this.orgs.delete({ id: orgId });

    this.logger.log(
      `deleted org ${orgId} (${threads.length} thread(s) torn down, org-scoped rows cascaded)`,
    );
  }

  async listForUser(userId: string): Promise<OrgSummary[]> {
    const memberships = await this.members.find({ where: { user_id: userId } });
    if (memberships.length === 0) return [];
    const roleById = new Map(memberships.map((m) => [m.org_id, m.role]));
    const orgs = await this.orgs.find({
      where: { id: In([...roleById.keys()]) },
    });
    return orgs.map((o) => ({
      id: o.id,
      slug: o.slug,
      name: o.name,
      status: o.status,
      role: roleById.get(o.id) ?? 'member',
      defaultAutoApproveMode: o.default_auto_approve_mode,
      defaultAutoMerge: o.default_auto_merge,
    }));
  }

  async membership(userId: string, orgId: string): Promise<OrganizationMemberEntity | null> {
    return this.members.findOne({ where: { org_id: orgId, user_id: userId } });
  }

  async ownsAnyOf(userId: string, orgIds: string[]): Promise<boolean> {
    if (orgIds.length === 0) return false;
    const owned = await this.members.findOne({
      where: { user_id: userId, role: 'owner', org_id: In(orgIds) },
    });
    return owned != null;
  }

  async get(orgId: string): Promise<OrganizationEntity | null> {
    return this.orgs.findOne({ where: { id: orgId } });
  }

  async membersOf(orgId: string): Promise<MemberView[]> {
    const rows = await this.members.find({ where: { org_id: orgId } });
    if (rows.length === 0) return [];
    const users = await this.users.find({
      where: { id: In(rows.map((m) => m.user_id)) },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((m) => ({
      userId: m.user_id,
      email: byId.get(m.user_id)?.email ?? '',
      name: byId.get(m.user_id)?.name ?? null,
      role: m.role,
    }));
  }

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

  async listInvites(orgId: string): Promise<InviteView[]> {
    const rows = await this.invites.find({
      where: { org_id: orgId, accepted_at: IsNull() },
      order: { created_at: 'DESC' },
    });
    return rows.map((r) => this.toInviteView(r));
  }

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
        this.members.create({
          org_id: invite.org_id,
          user_id: userId,
          role: invite.role,
        }),
      );
    }
    if (!invite.accepted_at) {
      invite.accepted_at = new Date();
      invite.accepted_by = userId;
      await this.invites.save(invite);
    }
    return { orgId: invite.org_id };
  }

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

  private async uniqueSlug(base: string, exceptId?: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      const exists = await this.orgs.findOne({ where: { slug } });
      if (!exists || exists.id === exceptId) return slug;
    }
    return `${base}-${randomUUID().slice(0, 6)}`;
  }
}
