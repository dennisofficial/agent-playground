import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { createMutex } from '../domain/async';
import type {
  IntegrationResult,
  NewWorktree,
  Worktree,
} from './worktree.types';

const execFileAsync = promisify(execFile);

// Git branch-config key recording a personal branch's shared integration branch. Lives in the main
// repo config (shared across linked worktrees, removed with `git branch -D`), so the association
// survives restarts and re-attaches. Third-level config names must be alphanumeric/dash.
const SHARED_CONFIG_KEY = 'agent-shared';

/** Turn an employee-supplied name into a short, branch/dir-safe slug. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'work'
  );
}

const withSubdir = (checkout: string, subdir: string) =>
  subdir ? join(checkout, subdir) : checkout;

/**
 * Employee-managed git worktrees off the repo at WORKER_ROOT. Checkouts live at
 * `<repoRoot>/.worktrees/<id>-<slug>` (gitignored); the unique id prefixes the directory AND the
 * default branch, so duplicate names and concurrent creates can't collide. All mutating git ops
 * serialize through one mutex — worktree/branch operations on a single repo must not interleave.
 *
 * Lifecycle is fully employee-managed (no reaping). The registry itself is in-memory, but git is
 * the durable store: on boot, existing `.worktrees/wt-*` checkouts are re-adopted from
 * `git worktree list`, so trees and branches survive a restart even though sessions don't.
 * The service is git-only on remove/publish/pull — session-aware policy (no open sessions on
 * remove, no mid-turn merges) lives in the tools, which can see the session registry without a
 * module cycle.
 *
 * Multi-employee feature work converges on a SHARED INTEGRATION BRANCH (`shared/<slug>`, never
 * checked out): each employee's personal branch is cut FROM it, `publish()` pushes committed work
 * onto it (merging teammates' work in first when needed), `pull()` takes it. Dennis reviews the
 * shared branch — it's what becomes the PR.
 * (Layout/adoption/integration ported from playground/src/workspace.ts.)
 */
@Injectable()
export class WorktreeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorktreeService.name);
  private readonly worktrees = new Map<string, Worktree>();
  private readonly gitOps = createMutex();
  private counter = 0;
  private layoutPromise?: Promise<{ repoRoot: string; subdir: string; worktreesDir: string }>;

  constructor(private readonly env: EnvService) {}

  /**
   * The repo worktrees are cut from. Required at use time (not boot) so a missing value fails the
   * employee's tool call loudly instead of failing the whole app.
   */
  workerRoot(): string {
    const root = this.env.get('WORKER_ROOT');
    if (!root) {
      throw new Error(
        'WORKER_ROOT is not set — set it to the absolute path of the repo worktrees are cut from.',
      );
    }
    return root;
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: cwd ?? this.workerRoot(),
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }

  /**
   * Repo layout, resolved once. A worktree is a FULL-repo checkout, so when WORKER_ROOT is a
   * subdirectory of its repo (a monorepo app dir), sessions operate at the same subpath inside the
   * worktree.
   */
  private layout() {
    return (this.layoutPromise ??= (async () => {
      const repoRoot = await this.git(['rev-parse', '--show-toplevel']);
      // git reports the SYMLINK-RESOLVED toplevel; resolve WORKER_ROOT the same way or the
      // subdir computation breaks under a symlinked root (e.g. macOS /var → /private/var).
      const workerRoot = await realpath(this.workerRoot());
      return {
        repoRoot,
        subdir: relative(repoRoot, workerRoot),
        worktreesDir: join(repoRoot, '.worktrees'),
      };
    })());
  }

  private nextId(): string {
    return `wt-${(++this.counter).toString().padStart(3, '0')}`;
  }

  /** Warn (don't block) when the base checkout has uncommitted tracked changes — worktrees branch
   * from committed HEAD, so uncommitted scratch simply won't appear in them. */
  private async dirtyBaseWarning(): Promise<string | undefined> {
    const dirty = await this.git(['status', '--porcelain', '--untracked-files=no']).catch(() => '');
    return dirty.trim()
      ? 'Note: the base checkout has uncommitted tracked changes — they will NOT appear in this worktree (it branches from committed HEAD).'
      : undefined;
  }

  /** Normalize an employee-supplied shared name to `shared/<slug>` (a leading `shared/` is allowed
   * and stripped first, so passing a full branch name back in can't double-prefix). */
  private sharedBranchName(input: string): string {
    return `shared/${slugify(input.replace(/^shared\//, ''))}`;
  }

  /** Create the shared integration branch from committed HEAD if absent. "Already exists" is
   * success — the branch can pre-exist from a prior process or a teammate's earlier create. (Only
   * called inside the gitOps mutex, so no extra memoization is needed.) */
  private async ensureSharedBranch(shared: string): Promise<void> {
    await this.git(['branch', shared, 'HEAD']).catch((e) => {
      if (!/already exists/i.test(String(e))) throw e;
    });
  }

  /** True when the checkout has a merge in progress (MERGE_HEAD present). Both publish and pull
   * must refuse then: HEAD is still the pre-merge commit, so a push would publish stale work and
   * the next merge would die with "unfinished merge". */
  private async mergeInProgress(checkout: string): Promise<boolean> {
    return this.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], checkout).then(
      () => true,
      () => false,
    );
  }

  private async conflictedFiles(checkout: string): Promise<string[]> {
    return this.git(['diff', '--name-only', '--diff-filter=U'], checkout)
      .then((s) => s.split('\n').filter(Boolean))
      .catch(() => []);
  }

  private async readSharedConfig(branch: string): Promise<string | undefined> {
    return this.git(['config', '--get', `branch.${branch}.${SHARED_CONFIG_KEY}`]).then(
      (v) => v || undefined,
      () => undefined,
    );
  }

  /**
   * Create a worktree. No `branch` → cut a fresh `agent/<owner>/<id>-<slug>` from the shared
   * integration branch when `shared` is given (everyone on a feature starts from the same base),
   * else from WORKER_ROOT's committed HEAD. With `branch`: attach to it if it exists (git itself
   * refuses a branch already checked out elsewhere — the error surfaces to the caller), else
   * create it; a recorded shared association is restored from branch config on attach.
   */
  async create(input: NewWorktree): Promise<{ worktree: Worktree; warning?: string }> {
    return this.gitOps(async () => {
      // A checked-out shared branch would make every teammate's publish fail forever with git's
      // "refusing to update checked out branch" — the shared branch is a ref, never a checkout.
      if (input.branch?.startsWith('shared/')) {
        throw new Error(
          'Shared branches are never checked out — pass `shared` instead of `branch` to join one.',
        );
      }
      const { subdir, worktreesDir } = await this.layout();
      const id = this.nextId();
      const slug = slugify(input.name);
      const checkout = join(worktreesDir, `${id}-${slug}`);
      await mkdir(worktreesDir, { recursive: true });
      const warning = await this.dirtyBaseWarning();

      let shared = input.shared ? this.sharedBranchName(input.shared) : undefined;
      if (shared) await this.ensureSharedBranch(shared);

      let branch: string;
      let baseRef: string;
      if (!input.branch) {
        branch = `agent/${input.ownerBot}/${id}-${slug}`;
        baseRef = await this.git(['rev-parse', shared ?? 'HEAD']);
        await this.git(['worktree', 'add', '-b', branch, checkout, baseRef]);
      } else {
        branch = input.branch;
        const exists = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(
          () => true,
          () => false,
        );
        if (exists) {
          // Re-attach: a recorded association is the truth — without this, a removed-then-reopened
          // worktree would silently lose publish/pull.
          const recorded = await this.readSharedConfig(branch);
          if (recorded && shared && recorded !== shared) {
            throw new Error(
              `Branch ${branch} already publishes to ${recorded} — it can't join ${shared}.`,
            );
          }
          shared = recorded ?? shared;
          baseRef = await this.git(['rev-parse', branch]);
          await this.git(['worktree', 'add', checkout, branch]);
        } else {
          baseRef = await this.git(['rev-parse', shared ?? 'HEAD']);
          await this.git(['worktree', 'add', '-b', branch, checkout, baseRef]);
        }
      }
      if (shared) {
        await this.git(['config', `branch.${branch}.${SHARED_CONFIG_KEY}`, shared]);
      }

      const worktree: Worktree = {
        id,
        name: input.name,
        branch,
        baseRef,
        path: withSubdir(checkout, subdir),
        checkout,
        ownerBot: input.ownerBot,
        project: input.project,
        ...(shared ? { sharedBranch: shared } : {}),
      };
      this.worktrees.set(id, worktree);
      this.logger.log(`${id} created: ${branch} at ${checkout}${shared ? ` (shared: ${shared})` : ''}`);
      return { worktree, warning };
    });
  }

  /**
   * Publish a worktree's COMMITTED work onto its shared integration branch. Fast-forward push from
   * the checkout when possible; when a teammate advanced the shared branch first, merge their work
   * into the worktree and push again. On merge conflict the merge is left IN PROGRESS in the
   * checkout (a session's next turn resolves and commits it) and the conflicted paths are returned.
   */
  async publish(id: string): Promise<IntegrationResult> {
    return this.gitOps(async () => {
      const wt = this.requireShared(id);
      const shared = wt.sharedBranch!;
      await this.refuseMidMerge(wt.checkout);
      const dirty = !!(
        await this.git(['status', '--porcelain'], wt.checkout).catch(() => '')
      ).trim();
      const tryPush = () =>
        this.git(['push', '.', `HEAD:${shared}`], wt.checkout).then(
          () => true,
          () => false,
        );
      if (await tryPush()) return { integrated: true, sharedBranch: shared, dirty };
      // Rejected (non-fast-forward) → take teammates' work in, then push again.
      try {
        await this.git(['merge', '--no-edit', shared], wt.checkout);
      } catch (err) {
        // Conflict (merge in progress) vs git refusing outright (e.g. dirty tree it would
        // clobber — nothing in progress): only the former is the resolvable-by-session shape.
        if (await this.mergeInProgress(wt.checkout)) {
          return {
            integrated: false,
            sharedBranch: shared,
            files: await this.conflictedFiles(wt.checkout),
            dirty,
          };
        }
        throw err;
      }
      return { integrated: await tryPush(), sharedBranch: shared, dirty };
    });
  }

  /** Merge the shared integration branch into a worktree — take teammates' published work. Same
   * conflict shape as publish ("Already up to date" is a success). */
  async pull(id: string): Promise<IntegrationResult> {
    return this.gitOps(async () => {
      const wt = this.requireShared(id);
      const shared = wt.sharedBranch!;
      await this.refuseMidMerge(wt.checkout);
      try {
        await this.git(['merge', '--no-edit', shared], wt.checkout);
      } catch (err) {
        if (await this.mergeInProgress(wt.checkout)) {
          return {
            integrated: false,
            sharedBranch: shared,
            files: await this.conflictedFiles(wt.checkout),
          };
        }
        throw err;
      }
      return { integrated: true, sharedBranch: shared };
    });
  }

  private requireShared(id: string): Worktree {
    const wt = this.worktrees.get(id);
    if (!wt) throw new Error(`No worktree "${id}".`);
    if (!wt.sharedBranch) {
      throw new Error(
        `${id} is not on a shared branch — create it with the \`shared\` option to collaborate.`,
      );
    }
    return wt;
  }

  private async refuseMidMerge(checkout: string): Promise<void> {
    if (await this.mergeInProgress(checkout)) {
      throw new Error(
        'A merge is already in progress in this worktree — have a session resolve and commit it first.',
      );
    }
  }

  /** Remove a worktree's checkout. The branch (and its commits) survive — work is never lost here. */
  async remove(id: string): Promise<void> {
    await this.gitOps(async () => {
      const wt = this.worktrees.get(id);
      if (!wt) throw new Error(`No worktree "${id}".`);
      await this.git(['worktree', 'remove', '--force', wt.checkout]);
      this.worktrees.delete(id);
      this.logger.log(`${id} removed (branch ${wt.branch} kept)`);
    });
  }

  get(id: string): Worktree | undefined {
    return this.worktrees.get(id);
  }

  list(filter?: { ownerBot?: string }): Worktree[] {
    const all = [...this.worktrees.values()];
    return filter?.ownerBot ? all.filter((w) => w.ownerBot === filter.ownerBot) : all;
  }

  /**
   * Re-adopt surviving worktrees on boot — git is the durable store even though this registry (and
   * all sessions) are not. Only `.worktrees/wt-*` checkouts are ours; anything else under
   * `.worktrees/` (e.g. the playground's tickets/jobs trees) is left strictly alone. Nothing is
   * swept: lifecycle is employee-managed.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.adoptWorktrees().catch((err) =>
      this.logger.warn(`Worktree adoption skipped: ${err instanceof Error ? err.message : err}`),
    );
  }

  async adoptWorktrees(): Promise<void> {
    if (!this.env.get('WORKER_ROOT')) {
      this.logger.warn('WORKER_ROOT not set — no worktrees to adopt.');
      return;
    }
    await this.gitOps(async () => {
      const { subdir, worktreesDir } = await this.layout();
      await this.git(['worktree', 'prune']).catch(() => {});
      const out = await this.git(['worktree', 'list', '--porcelain']).catch(() => '');
      for (const block of out.split('\n\n')) {
        const lines = block.split('\n');
        const checkout = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
        if (!checkout || !checkout.startsWith(worktreesDir + '/')) continue;
        const dir = basename(checkout);
        const m = dir.match(/^(wt-\d+)-(.*)$/); // only our own checkouts
        if (!m) continue;
        const [, id, slug] = m;
        const branch =
          lines
            .find((l) => l.startsWith('branch '))
            ?.slice('branch '.length)
            .replace('refs/heads/', '') ?? '';
        const owner = branch.match(/^agent\/([^/]+)\//)?.[1] ?? '';
        const shared = branch ? await this.readSharedConfig(branch) : undefined;
        this.worktrees.set(id, {
          id,
          name: slug,
          branch,
          baseRef: '',
          path: withSubdir(checkout, subdir),
          checkout,
          ownerBot: owner,
          project: '',
          ...(shared ? { sharedBranch: shared } : {}),
        });
        // Keep the id counter clear of every adopted id so new creates can't collide.
        const n = Number(id.slice('wt-'.length));
        if (Number.isFinite(n) && n > this.counter) this.counter = n;
        this.logger.log(`adopted ${id} (${branch || 'detached'}) at ${checkout}`);
      }
    });
  }
}
