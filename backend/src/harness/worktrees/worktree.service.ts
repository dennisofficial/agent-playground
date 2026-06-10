import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { createMutex } from '../domain/async';
import type { NewWorktree, Worktree } from './worktree.types';

const execFileAsync = promisify(execFile);

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
 * The service is git-only on remove — the "no open sessions" policy lives in the remove_worktree
 * tool, which can see the session registry without a module cycle.
 * (Layout/adoption ported from playground/src/workspace.ts; the ticket/shared-branch machinery
 * deliberately not.)
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

  /**
   * Create a worktree. No `branch` → cut a fresh `agent/<owner>/<id>-<slug>` from WORKER_ROOT's
   * committed HEAD (the default "work off the base branch" case). With `branch`: attach to it if it
   * exists (git itself refuses a branch already checked out elsewhere — the error surfaces to the
   * caller), else create it from HEAD.
   */
  async create(input: NewWorktree): Promise<{ worktree: Worktree; warning?: string }> {
    return this.gitOps(async () => {
      const { subdir, worktreesDir } = await this.layout();
      const id = this.nextId();
      const slug = slugify(input.name);
      const checkout = join(worktreesDir, `${id}-${slug}`);
      await mkdir(worktreesDir, { recursive: true });
      const warning = await this.dirtyBaseWarning();

      let branch: string;
      let baseRef: string;
      if (!input.branch) {
        branch = `agent/${input.ownerBot}/${id}-${slug}`;
        baseRef = await this.git(['rev-parse', 'HEAD']);
        await this.git(['worktree', 'add', '-b', branch, checkout, baseRef]);
      } else {
        branch = input.branch;
        const exists = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(
          () => true,
          () => false,
        );
        if (exists) {
          baseRef = await this.git(['rev-parse', branch]);
          await this.git(['worktree', 'add', checkout, branch]);
        } else {
          baseRef = await this.git(['rev-parse', 'HEAD']);
          await this.git(['worktree', 'add', '-b', branch, checkout, 'HEAD']);
        }
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
      };
      this.worktrees.set(id, worktree);
      this.logger.log(`${id} created: ${branch} at ${checkout}`);
      return { worktree, warning };
    });
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
        this.worktrees.set(id, {
          id,
          name: slug,
          branch,
          baseRef: '',
          path: withSubdir(checkout, subdir),
          checkout,
          ownerBot: owner,
          project: '',
        });
        // Keep the id counter clear of every adopted id so new creates can't collide.
        const n = Number(id.slice('wt-'.length));
        if (Number.isFinite(n) && n > this.counter) this.counter = n;
        this.logger.log(`adopted ${id} (${branch || 'detached'}) at ${checkout}`);
      }
    });
  }
}
