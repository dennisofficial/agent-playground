import { ScopedDb } from '@lib/pgbase/scoped-db';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type ConnectedRepo,
  type DisconnectRepoResult,
  type RepoBranches,
  type UpdateRepoDto,
} from '@workspace/shared';
import type { RepoModel } from '../../generated/prisma/models';
import { GithubAccessAdapter } from '../github/github-access.adapter';
import { OrgService } from '../org/org.service';

const GITHUB_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

@Injectable()
export class RepoService {
  constructor(
    private readonly scopedDb: ScopedDb,
    private readonly orgService: OrgService,
    private readonly githubAccessAdapter: GithubAccessAdapter,
  ) {}

  /** Connect (or re-connect) a GitHub repo to the org by URL. Owner-only. */
  async connect(
    userId: string,
    orgId: string,
    body: { repoUrl: string; displayName?: string; baseBranch?: string },
  ): Promise<ConnectedRepo> {
    await this.orgService.assertOwner(userId, orgId);
    const parsed = RepoService.parseGithubRepoUrl(body.repoUrl);
    if (!parsed) throw new BadRequestException(`Not an HTTPS GitHub URL: ${body.repoUrl}`);
    const { owner, repo } = parsed;
    const slug = `${owner}/${repo}`;

    const probe = await this.githubAccessAdapter.probeRepo(orgId, owner, repo);
    const existing = await this.scopedDb.repo.findFirst({ where: { orgId, slug } });

    const name = body.displayName?.trim() || existing?.name || repo;
    const gitUrl = `https://github.com/${owner}/${repo}`;
    const defaultBranch = probe.accessOk
      ? (probe.defaultBranch ?? body.baseBranch ?? existing?.defaultBranch ?? 'main')
      : body.baseBranch?.trim() || existing?.defaultBranch || 'main';

    let saved = existing
      ? await this.scopedDb.repo.update({
          where: { id: existing.id },
          data: { name, gitUrl, defaultBranch, accessOk: probe.accessOk, accessCheckedAt: new Date() },
        })
      : await this.scopedDb.repo.create({
          data: {
            orgId,
            slug,
            name,
            gitUrl,
            defaultBranch,
            accessOk: probe.accessOk,
            accessCheckedAt: new Date(),
          },
        });

    if (probe.accessOk) {
      const warning = await this.githubAccessAdapter.ensureWebhook(orgId, owner, repo);
      if (saved.webhookWarning !== warning) {
        saved = await this.scopedDb.repo.update({
          where: { id: saved.id },
          data: { webhookWarning: warning },
        });
      }
    }

    return this.toConnected(saved, probe.reason);
  }

  /** Update repo metadata (no GitHub call). Owner-only. */
  async update(userId: string, repoId: string, patch: UpdateRepoDto): Promise<ConnectedRepo> {
    const repo = await this.findRepoOwned(userId, repoId);

    const saved = await this.scopedDb.repo.update({
      where: { id: repo.id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() || repo.name } : {}),
        ...(patch.defaultBranch !== undefined
          ? { defaultBranch: patch.defaultBranch.trim() || repo.defaultBranch }
          : {}),
        // '' explicitly clears the override back to the neutral default (null).
        ...(patch.branchPrefix !== undefined
          ? { branchPrefix: patch.branchPrefix.trim() || null }
          : {}),
        ...(patch.defaultAutoMergeMethod !== undefined
          ? { defaultAutoMergeMethod: patch.defaultAutoMergeMethod }
          : {}),
        ...(patch.defaultAutoMergeDeleteBranch !== undefined
          ? { defaultAutoMergeDeleteBranch: patch.defaultAutoMergeDeleteBranch }
          : {}),
      },
    });
    return this.toConnected(saved);
  }

  /** Disconnect a repo (cascades its threads). Owner-only. */
  async remove(userId: string, repoId: string): Promise<DisconnectRepoResult> {
    const repo = await this.findRepoOwned(userId, repoId);
    const threadsDeleted = repo.threadCount;
    await this.scopedDb.repo.delete({ where: { id: repo.id } });
    return { ok: true, threadsDeleted };
  }

  /** Live branch list (default first). Falls back to the stored default branch. Any member may read. */
  async branches(repoId: string): Promise<RepoBranches> {
    const repo = await this.findRepoVisible(repoId);
    const parsed = RepoService.parseGithubRepoUrl(repo.gitUrl);
    const live = parsed
      ? await this.githubAccessAdapter.listBranches(repo.orgId, parsed.owner, parsed.repo)
      : null;
    return live ?? { branches: [repo.defaultBranch], defaultBranch: repo.defaultBranch };
  }

  /** Re-run the GitHub access probe for a repo. Owner-only. */
  async revalidate(userId: string, repoId: string): Promise<ConnectedRepo> {
    const repo = await this.findRepoOwned(userId, repoId);
    const parsed = RepoService.parseGithubRepoUrl(repo.gitUrl);
    if (!parsed) throw new BadRequestException(`Not an HTTPS GitHub URL: ${repo.gitUrl}`);

    const probe = await this.githubAccessAdapter.probeRepo(repo.orgId, parsed.owner, parsed.repo);
    const saved = await this.scopedDb.repo.update({
      where: { id: repo.id },
      data: {
        accessOk: probe.accessOk,
        accessCheckedAt: new Date(),
        ...(probe.accessOk && probe.defaultBranch ? { defaultBranch: probe.defaultBranch } : {}),
      },
    });
    return this.toConnected(saved, probe.reason);
  }

  /**
   * Load a repo visible to the caller. ScopedDb's Repo policy is member-scoped (`orgId ∈
   * claims.orgIds`), so a repo outside the caller's orgs is a 404, never a leak.
   */
  private async findRepoVisible(repoId: string) {
    const repo = await this.scopedDb.repo.findFirst({ where: { id: repoId } });
    if (!repo) throw new NotFoundException('Repository not found');
    return repo;
  }

  /**
   * Load a repo the caller may write. pgbase policies carry a single (read) predicate, so the
   * owner-only write rule `@Rls` used to apply is restored here imperatively rather than at the DB —
   * a non-owner who knows the id still gets a 403, not a leak.
   */
  private async findRepoOwned(userId: string, repoId: string) {
    const repo = await this.findRepoVisible(repoId);
    await this.orgService.assertOwner(userId, repo.orgId);
    return repo;
  }

  private toConnected(
    r: Pick<
      RepoModel,
      | 'id'
      | 'slug'
      | 'name'
      | 'gitUrl'
      | 'defaultBranch'
      | 'branchPrefix'
      | 'defaultAutoMergeMethod'
      | 'defaultAutoMergeDeleteBranch'
      | 'accessOk'
    >,
    reason?: string,
  ): ConnectedRepo {
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
