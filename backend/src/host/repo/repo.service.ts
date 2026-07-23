import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db, type RlsAction } from '@workspace/nestjs-rls/nest';
import {
  type ConnectedRepo,
  type DisconnectRepoResult,
  type RepoBranches,
  type UpdateRepoDto,
} from '@workspace/shared';
import { Repo, RepoRepo } from '../../_lib/database/entities/repo.entity';
import { GithubAccessAdapter } from '../github/github-access.adapter';
import { OrgService } from '../org/org.service';

const GITHUB_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

@Injectable()
export class RepoService {
  constructor(
    private readonly repos: RepoRepo,
    private readonly orgs: OrgService,
    private readonly db: Db,
    private readonly github: GithubAccessAdapter,
  ) {}

  /** Connect (or re-connect) a GitHub repo to the org by URL. Owner-only. */
  async connect(
    userId: string,
    orgId: string,
    body: { repoUrl: string; displayName?: string; baseBranch?: string },
  ): Promise<ConnectedRepo> {
    await this.orgs.assertOwner(userId, orgId);
    const parsed = RepoService.parseGithubRepoUrl(body.repoUrl);
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
  async update(repoId: string, patch: UpdateRepoDto): Promise<ConnectedRepo> {
    const repo = await this.findRepoScoped(repoId, 'update');

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
  async remove(repoId: string): Promise<DisconnectRepoResult> {
    const repo = await this.findRepoScoped(repoId, 'delete');
    const threadsDeleted = repo.threadCount;
    await this.repos.delete({ id: repo.id });
    return { ok: true, threadsDeleted };
  }

  /** Live branch list (default first). Falls back to the stored default branch. Any member may read. */
  async branches(repoId: string): Promise<RepoBranches> {
    const repo = await this.findRepoScoped(repoId, 'read');
    const parsed = RepoService.parseGithubRepoUrl(repo.gitUrl);
    const live = parsed
      ? await this.github.listBranches(repo.orgId, parsed.owner, parsed.repo)
      : null;
    return live ?? { branches: [repo.defaultBranch], defaultBranch: repo.defaultBranch };
  }

  /** Re-run the GitHub access probe for a repo. Owner-only. */
  async revalidate(repoId: string): Promise<ConnectedRepo> {
    const repo = await this.findRepoScoped(repoId, 'update');
    const parsed = RepoService.parseGithubRepoUrl(repo.gitUrl);
    if (!parsed) throw new BadRequestException(`Not an HTTPS GitHub URL: ${repo.gitUrl}`);

    const probe = await this.github.probeRepo(repo.orgId, parsed.owner, parsed.repo);
    repo.accessOk = probe.accessOk;
    repo.accessCheckedAt = new Date();
    if (probe.accessOk && probe.defaultBranch) repo.defaultBranch = probe.defaultBranch;
    const saved = await this.repos.save(repo);
    return this.toConnected(saved, probe.reason);
  }

  /**
   * Load a repo the caller may act on for `action`, scoped by Repo's `@Rls` policy — the **same** rule
   * that gates the SSE feed (`read` → member orgs; `update`/`delete` → owned orgs). The scope is ANDed
   * into the query, so a repo outside the caller's authority is a 404 (never a leak) and REST/realtime
   * can't drift. This makes ownership authoritative at the DB, not the URL: a non-owner who knows the
   * ids still can't write.
   */
  private async findRepoScoped(repoId: string, action: RlsAction): Promise<Repo> {
    const repo = await this.db.scoped(Repo).findOneScoped({ id: repoId }, action);
    if (!repo) throw new NotFoundException('Repository not found');
    return repo;
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

  private static parseGithubRepoUrl(url: string): { owner: string; repo: string } | null {
    const m = url.trim().match(GITHUB_URL);
    return m ? { owner: m[1], repo: m[2] } : null;
  }
}
