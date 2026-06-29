import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LocalGitService } from '../git';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { RepoDecisionEntity, RepoEntity } from '../persistence/entities';
import { ledgerContentHash, parseLedgerFrontmatter } from './decision-ledger.service';

/**
 * THE DECISION-LEDGER MANIFEST MANAGER (Phase 2) — owns `repo_decisions`, the graph + freshness source of
 * truth over the committed `.atlas/decisions/` files. Two write paths:
 *
 *  • {@link recordPromoted} — at promotion (ship), upsert a `proposed` row per written slug with the
 *    promotion-time `content_hash`. This baseline is what merge-accept + edit-detection compare against.
 *  • {@link reconcileFromBaseCheckout} — on PR merge (for the merged repo) + on boot (all repos): read the
 *    MERGED default-branch ledger and (a) flip a matching proposed row to `accepted`, (b) refresh the
 *    supersession graph, (c) FLAG a row whose merged file diverged from its baseline (a human edit) —
 *    never overwriting the baseline or auto-trusting the change.
 *
 * The base checkout under `reposRoot()` is the canonical merged view (NOT a per-thread worktree, which is
 * torn down right after merge). Best-effort throughout: a reconcile hiccup never blocks a merge or boot.
 */

/** What promotion hands the manifest — the durable fields + the promotion-time hash, per written slug. */
export interface PromotedManifestInput {
  slug: string;
  title: string;
  contentHash: string;
  tags: string[];
  sourceThread: string | null;
  supersedes: string[];
  supersededBy: string | null;
  governsPaths: string[];
}

const LEDGER_DIR = '.atlas/decisions';

@Injectable()
export class RepoDecisionManifestService {
  private readonly logger = new Logger(RepoDecisionManifestService.name);

  constructor(
    @InjectRepository(RepoDecisionEntity, DB_CONNECTION)
    private readonly manifest: Repository<RepoDecisionEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    private readonly git: LocalGitService,
    private readonly creds: CredentialResolver,
  ) {}

  /**
   * Upsert `proposed` manifest rows for a thread's freshly-promoted decisions (their files are written +
   * about to be committed on the thread's branch). The `content_hash` is the promotion-time baseline that
   * merge-accept matches against. Idempotent on `(org, repo, slug)` — a re-promotion refreshes the row.
   */
  async recordPromoted(
    orgId: string,
    repoId: string,
    entries: PromotedManifestInput[],
  ): Promise<void> {
    for (const e of entries) {
      const existing = await this.manifest.findOne({
        where: { org_id: orgId, repo_id: repoId, slug: e.slug },
      });
      const fields = {
        title: e.title,
        tags: e.tags,
        source_thread: e.sourceThread,
        supersedes: e.supersedes,
        superseded_by: e.supersededBy,
        governs_paths: e.governsPaths,
        content_hash: e.contentHash,
        // A fresh promotion is the new ground truth → clear any stale flag and (re)set it proposed.
        status: e.supersededBy ? 'superseded' : 'proposed',
        flagged: false,
      };
      if (existing) {
        await this.manifest.update({ id: existing.id }, fields);
      } else {
        await this.manifest.save(
          this.manifest.create({ org_id: orgId, repo_id: repoId, slug: e.slug, ...fields }),
        );
      }
    }
  }

  /**
   * Reconcile a repo's manifest against its MERGED default-branch ledger. Returns counts. Resolves the repo
   * + token, refreshes `origin/<default>` (via `ensureRepo`), then for each merged decision file:
   *   - matches the promotion baseline → flip `proposed`→`accepted` (or `superseded`), refresh the graph;
   *   - diverged from the baseline → a HUMAN EDIT → set `flagged`, leave the baseline untouched;
   *   - no manifest row (a pre-manifest or hand-added file) → first-seen-trust: record it `accepted`.
   */
  async reconcileFromBaseCheckout(
    orgId: string,
    repoId: string,
  ): Promise<{ reconciled: number; accepted: number; flagged: number }> {
    const repo = await this.repos.findOne({ where: { id: repoId, org_id: orgId } });
    if (!repo?.git_url) return { reconciled: 0, accepted: 0, flagged: 0 };
    const token = await this.creds.githubToken(orgId).catch(() => undefined);
    const project = await this.git.ensureRepo({
      repoId,
      gitUrl: repo.git_url,
      defaultBranch: repo.default_branch ?? undefined,
      ...(token ? { token } : {}),
    });
    const ref = `origin/${project.defaultBranch}`;
    const files = (await this.git.listFilesAtRef(project.repoPath, ref, LEDGER_DIR)).filter(
      (f) => f.endsWith('.md') && !f.endsWith('/index.md'),
    );

    const now = new Date();
    let accepted = 0;
    let flagged = 0;
    for (const path of files) {
      const content = await this.git.readFileAtRef(project.repoPath, ref, path);
      if (content == null) continue;
      const fm = parseLedgerFrontmatter(content);
      const slug = fm.id ?? path.replace(/^.*\//, '').replace(/\.md$/, '');
      const hash = ledgerContentHash(content);
      const status = fm.supersededBy ? 'superseded' : 'accepted';
      const graph = {
        title: fm.title ?? slug,
        tags: fm.tags,
        source_thread: fm.sourceThread,
        supersedes: fm.supersedes,
        superseded_by: fm.supersededBy,
        governs_paths: fm.governsPaths,
        last_reconciled: now,
      };

      const existing = await this.manifest.findOne({
        where: { org_id: orgId, repo_id: repoId, slug },
      });
      if (!existing) {
        // No baseline (pre-Phase-2 merge, or a hand-added decision) — trust the merged state once.
        await this.manifest.save(
          this.manifest.create({
            org_id: orgId,
            repo_id: repoId,
            slug,
            status,
            content_hash: hash,
            flagged: false,
            ...graph,
          }),
        );
        accepted++;
        continue;
      }
      if (existing.content_hash === hash) {
        // Merged file matches our baseline → accept it (or keep superseded) + refresh the graph.
        await this.manifest.update({ id: existing.id }, { status, ...graph });
        if (status === 'accepted') accepted++;
        continue;
      }
      // Diverged from the baseline we recorded → a change Atlas didn't promote = a HUMAN EDIT. Flag it for
      // operator review; do NOT update content_hash (never auto-trust) and do NOT touch the file.
      if (!existing.flagged) {
        this.logger.warn(
          `ledger drift: ${repoId}/${slug} on ${ref} diverged from its recorded baseline — flagging for operator review (not auto-trusted)`,
        );
      }
      await this.manifest.update({ id: existing.id }, { flagged: true, last_reconciled: now });
      flagged++;
    }
    if (accepted || flagged) {
      this.logger.log(
        `ledger reconcile ${repoId}: ${files.length} file(s), ${accepted} accepted, ${flagged} flagged`,
      );
    }
    return { reconciled: files.length, accepted, flagged };
  }

  /** All repos that have at least one connected git url — the boot reconcile's work-list. */
  async reposWithGit(): Promise<{ orgId: string; repoId: string }[]> {
    const rows = await this.repos.find();
    return rows
      .filter((r) => r.git_url)
      .map((r) => ({ orgId: r.org_id, repoId: r.id }));
  }
}
