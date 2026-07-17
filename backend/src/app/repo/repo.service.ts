import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AutoMergeMethod,
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
    @Inject(GITHUB_ACCESS_PORT) private readonly github: GithubAccessPort,
  ) {}

  /** Repos connected under an org, oldest first. */
  async list(userId: string, orgId: string): Promise<RepoView[]> {
    await this.orgs.assertMember(userId, orgId);
    const rows = await this.repos.find({ where: { orgId }, order: { createdAt: 'ASC' } });
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
      : (body.baseBranch?.trim() || entity.defaultBranch || 'main');
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
  async update(
    userId: string,
    orgId: string,
    repoId: string,
    patch: UpdateRepoDto,
  ): Promise<ConnectedRepo> {
    await this.orgs.assertOwner(userId, orgId);
    const repo = await this.findScoped(orgId, repoId);

    if (patch.name !== undefined) repo.name = patch.name.trim() || repo.name;
    if (patch.defaultBranch !== undefined) repo.defaultBranch = patch.defaultBranch.trim() || repo.defaultBranch;
    // '' explicitly clears the override back to the neutral default (null).
    if (patch.branchPrefix !== undefined) repo.branchPrefix = patch.branchPrefix.trim() || null;
    if (patch.defaultAutoMergeMethod !== undefined) repo.defaultAutoMergeMethod = patch.defaultAutoMergeMethod;
    if (patch.defaultAutoMergeDeleteBranch !== undefined)
      repo.defaultAutoMergeDeleteBranch = patch.defaultAutoMergeDeleteBranch;

    const saved = await this.repos.save(repo);
    return this.toConnected(saved);
  }

  /** Disconnect a repo (cascades its threads). Owner-only. */
  async remove(userId: string, orgId: string, repoId: string): Promise<DisconnectRepoResult> {
    await this.orgs.assertOwner(userId, orgId);
    const repo = await this.findScoped(orgId, repoId);
    const threadsDeleted = repo.threadCount;
    await this.repos.delete({ id: repo.id });
    return { ok: true, threadsDeleted };
  }

  /** Live branch list (default first). Falls back to the stored default branch. */
  async branches(userId: string, orgId: string, repoId: string): Promise<RepoBranches> {
    await this.orgs.assertMember(userId, orgId);
    const repo = await this.findScoped(orgId, repoId);
    const parsed = parseGithubRepoUrl(repo.gitUrl);
    const live = parsed ? await this.github.listBranches(orgId, parsed.owner, parsed.repo) : null;
    return live ?? { branches: [repo.defaultBranch], defaultBranch: repo.defaultBranch };
  }

  /** Re-run the GitHub access probe for a repo. Owner-only. */
  async revalidate(userId: string, orgId: string, repoId: string): Promise<ConnectedRepo> {
    await this.orgs.assertOwner(userId, orgId);
    const repo = await this.findScoped(orgId, repoId);
    const parsed = parseGithubRepoUrl(repo.gitUrl);
    if (!parsed) throw new BadRequestException(`Not an HTTPS GitHub URL: ${repo.gitUrl}`);

    const probe = await this.github.probeRepo(orgId, parsed.owner, parsed.repo);
    repo.accessOk = probe.accessOk;
    repo.accessCheckedAt = new Date();
    if (probe.accessOk && probe.defaultBranch) repo.defaultBranch = probe.defaultBranch;
    const saved = await this.repos.save(repo);
    return this.toConnected(saved, probe.reason);
  }

  private async findScoped(orgId: string, repoId: string): Promise<Repo> {
    const repo = await this.repos.findOne({ where: { id: repoId, orgId } });
    if (!repo) throw new NotFoundException('Repository not found');
    return repo;
  }

  private toView(r: Repo): RepoView {
    return {
      id: r.id,
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
      defaultAutoMergeMethod: r.defaultAutoMergeMethod as AutoMergeMethod,
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
      defaultAutoMergeMethod: r.defaultAutoMergeMethod as AutoMergeMethod,
      defaultAutoMergeDeleteBranch: r.defaultAutoMergeDeleteBranch,
      accessOk: r.accessOk,
      ...(reason ? { reason } : {}),
    };
  }
}
