import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type GuardAction, RealtimeEngine } from '@workspace/pg-realtime';
import { PG_REALTIME_ENGINE } from '@workspace/pg-realtime/nest';
import { scopedFindWhere } from '@workspace/pg-realtime/typeorm';
import {
  type ConnectedRepo,
  type DisconnectRepoResult,
  type RepoBranches,
  type RepoView,
  type UpdateRepoDto,
} from '@workspace/shared';
import { OrgService } from '../org/org.service';
import { Repo, RepoRepo } from './entities/repo.entity';
import { GITHUB_ACCESS_PORT, type GithubAccessPort } from './ports/github-access.port';

const GITHUB_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

function parseGithubRepoUrl(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(GITHUB_URL);
  return m ? { owner: m[1], repo: m[2] } : null;
}

@Injectable()
export class RepoService {
  constructor(
    private readonly repos: RepoRepo,
    private readonly orgs: OrgService,
    @Inject(PG_REALTIME_ENGINE) private readonly realtime: RealtimeEngine,
    @Inject(GITHUB_ACCESS_PORT) private readonly github: GithubAccessPort,
  ) {}

  /** Repos connected under an org, oldest first. */
  async list(userId: string, orgId: string): Promise<RepoView[]> {
    await this.orgs.assertMember(userId, orgId);
    const rows = await this.repos.find({ where: { orgId }, order: { createdAt: 'ASC' } });
    return rows.map((r) => this.toView(r));
  }

  /** Every repo across the caller's orgs (member-scoped via the `repos` guard) — the cross-org picker +
   *  the client-side `repoId → name` map for the sidebar. No org in the path; RLS scopes it. */
  async listAll(userId: string): Promise<RepoView[]> {
    const { allowed, where } = await scopedFindWhere<Repo>({
      rls: this.realtime.rls,
      model: 'repos',
      user: { id: userId },
      action: 'read',
      where: {},
    });
    if (!allowed) return [];
    const rows = await this.repos.find({ where, order: { createdAt: 'ASC' } });
    return rows.map((r) => this.toView(r));
  }

  /** Connect (or re-connect) a GitHub repo to the org by URL. Owner-only. */
  async connect(
    userId: string,
    orgId: string,
    body: { repoUrl: string; displayName?: string; baseBranch?: string },
  ): Promise<ConnectedRepo> {
    await this.orgs.assertOwner(userId, orgId);
    const parsed = parseGithubRepoUrl(body.repoUrl);
    if (!parsed) throw new BadRequestException(`Not an HTTPS GitHub URL: ${body.repoUrl}`);
    const { owner, repo } = parsed;
    const slug = `${owner}/${repo}`;

    const probe = await this.github.probeRepo(orgId, owner, repo);

    let entity = await this.repos.findOne({ where: { orgId, slug } });
    if (!entity) entity = this.repos.create({ orgId, slug, name: repo });

    entity.name = body.displayName?.trim() || entity.name || repo;
    entity.gitUrl = `https://github.com/${owner}/${repo}`;
    entity.defaultBranch = probe.accessOk
      ? (probe.defaultBranch ?? body.baseBranch ?? entity.defaultBranch ?? 'main')
      : body.baseBranch?.trim() || entity.defaultBranch || 'main';
    entity.accessOk = probe.accessOk;
    entity.accessCheckedAt = new Date();

    let saved = await this.repos.save(entity);

    if (probe.accessOk) {
      const warning = await this.github.ensureWebhook(orgId, owner, repo);
      if (saved.webhookWarning !== warning) {
        saved.webhookWarning = warning;
        saved = await this.repos.save(saved);
      }
    }

    return this.toConnected(saved, probe.reason);
  }

  /** Update repo metadata (no GitHub call). Owner-only. */
  async update(userId: string, repoId: string, patch: UpdateRepoDto): Promise<ConnectedRepo> {
    const repo = await this.findRepoScoped(userId, repoId, 'update');

    if (patch.name !== undefined) repo.name = patch.name.trim() || repo.name;
    if (patch.defaultBranch !== undefined)
      repo.defaultBranch = patch.defaultBranch.trim() || repo.defaultBranch;
    // '' explicitly clears the override back to the neutral default (null).
    if (patch.branchPrefix !== undefined) repo.branchPrefix = patch.branchPrefix.trim() || null;
    if (patch.defaultAutoMergeMethod !== undefined)
      repo.defaultAutoMergeMethod = patch.defaultAutoMergeMethod;
    if (patch.defaultAutoMergeDeleteBranch !== undefined)
      repo.defaultAutoMergeDeleteBranch = patch.defaultAutoMergeDeleteBranch;

    const saved = await this.repos.save(repo);
    return this.toConnected(saved);
  }

  /** Disconnect a repo (cascades its threads). Owner-only. */
  async remove(userId: string, repoId: string): Promise<DisconnectRepoResult> {
    const repo = await this.findRepoScoped(userId, repoId, 'delete');
    const threadsDeleted = repo.threadCount;
    await this.repos.delete({ id: repo.id });
    return { ok: true, threadsDeleted };
  }

  /** Live branch list (default first). Falls back to the stored default branch. Any member may read. */
  async branches(userId: string, repoId: string): Promise<RepoBranches> {
    const repo = await this.findRepoScoped(userId, repoId, 'read');
    const parsed = parseGithubRepoUrl(repo.gitUrl);
    const live = parsed
      ? await this.github.listBranches(repo.orgId, parsed.owner, parsed.repo)
      : null;
    return live ?? { branches: [repo.defaultBranch], defaultBranch: repo.defaultBranch };
  }

  /** Re-run the GitHub access probe for a repo. Owner-only. */
  async revalidate(userId: string, repoId: string): Promise<ConnectedRepo> {
    const repo = await this.findRepoScoped(userId, repoId, 'update');
    const parsed = parseGithubRepoUrl(repo.gitUrl);
    if (!parsed) throw new BadRequestException(`Not an HTTPS GitHub URL: ${repo.gitUrl}`);

    const probe = await this.github.probeRepo(repo.orgId, parsed.owner, parsed.repo);
    repo.accessOk = probe.accessOk;
    repo.accessCheckedAt = new Date();
    if (probe.accessOk && probe.defaultBranch) repo.defaultBranch = probe.defaultBranch;
    const saved = await this.repos.save(repo);
    return this.toConnected(saved, probe.reason);
  }

  /**
   * Load a repo the caller may act on for `action`, scoped by the **same** `repos` realtime guard
   * (`RepoRealtimeGuard`) that gates the SSE feed. `scopedFindWhere` runs the guard (`canRead` → member
   * orgs; `canUpdate`/`canDelete` → owned orgs) and ANDs its `orgId In (...)` scope into the query — so a
   * repo outside the caller's authority is a 404 (never a leak) and REST/realtime can't drift. This is
   * what lets item ops drop `orgId` from the path AND makes ownership authoritative at the DB, not the
   * URL: a non-owner who knows the ids still can't write.
   */
  private async findRepoScoped(userId: string, repoId: string, action: GuardAction): Promise<Repo> {
    const { allowed, where } = await scopedFindWhere<Repo>({
      rls: this.realtime.rls,
      model: 'repos',
      user: { id: userId },
      action,
      where: { id: repoId },
    });
    const repo = allowed ? await this.repos.findOne({ where }) : null;
    if (!repo) throw new NotFoundException('Repository not found');
    return repo;
  }

  private toView(r: Repo): RepoView {
    return {
      id: r.id,
      orgId: r.orgId,
      slug: r.slug,
      name: r.name,
      gitUrl: r.gitUrl,
      defaultBranch: r.defaultBranch,
      accessOk: r.accessOk,
      accessCheckedAt: r.accessCheckedAt ? r.accessCheckedAt.toISOString() : null,
      threadCount: r.threadCount,
      onboardingThreadId: r.onboardingThreadId,
      onboardedAt: r.onboardedAt ? r.onboardedAt.toISOString() : null,
      webhookWarning: r.webhookWarning,
      branchPrefix: r.branchPrefix,
      defaultAutoMergeMethod: r.defaultAutoMergeMethod,
      defaultAutoMergeDeleteBranch: r.defaultAutoMergeDeleteBranch,
    };
  }

  private toConnected(r: Repo, reason?: string): ConnectedRepo {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      gitUrl: r.gitUrl,
      defaultBranch: r.defaultBranch,
      branchPrefix: r.branchPrefix,
      defaultAutoMergeMethod: r.defaultAutoMergeMethod,
      defaultAutoMergeDeleteBranch: r.defaultAutoMergeDeleteBranch,
      accessOk: r.accessOk,
      ...(reason ? { reason } : {}),
    };
  }
}
