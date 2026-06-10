import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { access, appendFile, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { createMutex } from '../domain/async';
import { gitAuthEnv, sameGitUrl } from '../projects/git-auth';
import { GithubTokenStore } from '../projects/github-token-store';
import { ProjectStore } from '../projects/project-store';
import type { ProjectRecord } from '../projects/project.types';
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

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** The repo a project's worktrees live in. */
interface RepoLayout {
  repoRoot: string;
  /** WORKER_ROOT's repo-subdir ('' for managed clones, whose cwd is the repo root). */
  subdir: string;
  worktreesDir: string;
}

/**
 * Employee-managed git worktrees, per project. An UNREGISTERED project (local dev) cuts worktrees
 * off the repo at WORKER_ROOT exactly as before; a project registered in the ProjectStore gets its
 * GitHub repo cloned on first use to `<REPOS_ROOT>/<projectId>` and worktrees cut there. Checkouts
 * live at `<repoRoot>/.worktrees/<id>-<slug>`; the unique id prefixes the directory AND the default
 * branch, so duplicate names and concurrent creates can't collide. All mutating git ops serialize
 * through one mutex (clone-on-first-use included — the first worktree on a big repo blocks worktree
 * ops for the clone duration; accepted v0).
 *
 * Lifecycle is fully employee-managed (no reaping). The registry itself is in-memory, but git is
 * the durable store: on boot, existing `.worktrees/wt-*` checkouts are re-adopted from every known
 * repo root. The service is git-only on remove/publish/pull — session-aware policy (no open
 * sessions on remove, no mid-turn merges) lives in the tools, which can see the session registry
 * without a module cycle.
 *
 * Multi-employee feature work converges on a SHARED INTEGRATION BRANCH (`shared/<slug>`, never
 * checked out): each employee's personal branch is cut FROM it, `publish()` pushes committed work
 * onto it (merging teammates' work in first when needed), `pull()` takes it. When the project has
 * a registered repo, publish also syncs the shared branch to ORIGIN — gated by an identity check
 * (the worktree's repo origin must BE the registered repo; a worktree created before its project
 * was registered must be recreated, never silently pushed with the project's token).
 * (Layout/adoption/integration ported from playground/src/workspace.ts.)
 */
@Injectable()
export class WorktreeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorktreeService.name);
  private readonly worktrees = new Map<string, Worktree>();
  private readonly gitOps = createMutex();
  private counter = 0;
  /** Per-repo layout cache (clone/realpath are the expensive parts). Registry RECORDS are read
   * fresh on every use — only the repo on disk is cached. Failed builds are evicted (retryable). */
  private readonly layouts = new Map<string, Promise<RepoLayout>>();

  constructor(
    private readonly env: EnvService,
    private readonly projects: ProjectStore,
    private readonly tokens: GithubTokenStore,
  ) {}

  /**
   * The repo unregistered-project worktrees are cut from. Required at use time (not boot) so a
   * missing value fails the employee's tool call loudly instead of failing the whole app.
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

  /** Where registered projects' repos are cloned. */
  reposRoot(): string {
    return this.env.get('REPOS_ROOT') ?? join(homedir(), '.agent-playground', 'repos');
  }

  private async git(
    args: string[],
    cwd: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 1024 * 1024,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    return stdout.trim();
  }

  /** The decrypted token for a project (named override → default), or undefined (tokenless). */
  private async tokenFor(rec: ProjectRecord): Promise<string | undefined> {
    return (await this.tokens.resolve(rec.tokenName).catch(() => undefined))?.token;
  }

  private cachedLayout(key: string, build: () => Promise<RepoLayout>): Promise<RepoLayout> {
    let p = this.layouts.get(key);
    if (!p) {
      p = build();
      this.layouts.set(key, p);
      p.catch(() => this.layouts.delete(key)); // a failed clone must be retryable
    }
    return p;
  }

  /** WORKER_ROOT's repo. A worktree is a FULL-repo checkout, so when WORKER_ROOT is a subdirectory
   * of its repo (a monorepo app dir), sessions operate at the same subpath inside the worktree. */
  private workerRootLayout(): Promise<RepoLayout> {
    return this.cachedLayout('worker-root', async () => {
      const repoRoot = await this.git(['rev-parse', '--show-toplevel'], this.workerRoot());
      // git reports the SYMLINK-RESOLVED toplevel; resolve WORKER_ROOT the same way or the
      // subdir computation breaks under a symlinked root (e.g. macOS /var → /private/var).
      const workerRoot = await realpath(this.workerRoot());
      return {
        repoRoot,
        subdir: relative(repoRoot, workerRoot),
        worktreesDir: join(repoRoot, '.worktrees'),
      };
    });
  }

  /** A registered project's managed clone, created on first use. */
  private cloneLayout(rec: ProjectRecord): Promise<RepoLayout> {
    return this.cachedLayout(`proj:${rec.projectId}`, async () => {
      const root = join(this.reposRoot(), rec.projectId);
      if (!(await exists(join(root, '.git')))) {
        await mkdir(this.reposRoot(), { recursive: true });
        const auth = gitAuthEnv(rec.gitUrl, await this.tokenFor(rec));
        this.logger.log(`cloning ${rec.gitUrl} → ${root} (project ${rec.projectId})`);
        await this.git(['clone', rec.gitUrl, root], this.reposRoot(), auth);
        // Keep worktree checkouts out of `git status` noise without touching the repo's own files.
        await appendFile(join(root, '.git', 'info', 'exclude'), '\n.worktrees/\n').catch(() => {});
      }
      const repoRoot = await realpath(root);
      return { repoRoot, subdir: '', worktreesDir: join(repoRoot, '.worktrees') };
    });
  }

  /**
   * The repo a project's worktrees live in. Registered → the managed clone (with origin-URL drift
   * repair: a PATCHed git_url must take effect, not silently keep pushing to the old repo — repair
   * applies ONLY to managed clones, never WORKER_ROOT). Unregistered / '' → WORKER_ROOT.
   */
  private async resolveLayout(project: string): Promise<RepoLayout> {
    const rec = project ? await this.projects.get(project) : undefined;
    if (!rec) return this.workerRootLayout();
    const layout = await this.cloneLayout(rec);
    const origin = await this.git(['remote', 'get-url', 'origin'], layout.repoRoot).catch(() => '');
    if (origin && !sameGitUrl(origin, rec.gitUrl)) {
      this.logger.warn(`project ${rec.projectId}: origin drifted (${origin}) — repointing to ${rec.gitUrl}`);
      await this.git(['remote', 'set-url', 'origin', rec.gitUrl], layout.repoRoot);
    }
    return layout;
  }

  private nextId(): string {
    return `wt-${(++this.counter).toString().padStart(3, '0')}`;
  }

  /** Warn (don't block) when the base checkout has uncommitted tracked changes — worktrees branch
   * from committed HEAD, so uncommitted scratch simply won't appear in them. */
  private async dirtyBaseWarning(repoRoot: string): Promise<string | undefined> {
    const dirty = await this.git(
      ['status', '--porcelain', '--untracked-files=no'],
      repoRoot,
    ).catch(() => '');
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
  private async ensureSharedBranch(shared: string, repoRoot: string): Promise<void> {
    await this.git(['branch', shared, 'HEAD'], repoRoot).catch((e) => {
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

  private async readSharedConfig(branch: string, repoRoot: string): Promise<string | undefined> {
    return this.git(['config', '--get', `branch.${branch}.${SHARED_CONFIG_KEY}`], repoRoot).then(
      (v) => v || undefined,
      () => undefined,
    );
  }

  /**
   * Create a worktree in its project's repo. No `branch` → cut a fresh `agent/<owner>/<id>-<slug>`
   * from the shared integration branch when `shared` is given (everyone on a feature starts from
   * the same base), else from the repo's committed HEAD. With `branch`: attach to it if it exists
   * (git itself refuses a branch already checked out elsewhere — the error surfaces to the caller),
   * else create it; a recorded shared association is restored from branch config on attach.
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
      const { repoRoot, subdir, worktreesDir } = await this.resolveLayout(input.project);
      const id = this.nextId();
      const slug = slugify(input.name);
      const checkout = join(worktreesDir, `${id}-${slug}`);
      await mkdir(worktreesDir, { recursive: true });
      let warning = await this.dirtyBaseWarning(repoRoot);
      // A project registered AFTER worktrees were cut for it on WORKER_ROOT: those old trees stay
      // on the old repo (their shared branches don't span repos) — surface it once, at create.
      const strays = [...this.worktrees.values()].filter(
        (w) => w.project === input.project && w.repoRoot !== repoRoot,
      );
      if (strays.length) {
        warning =
          `${warning ? `${warning} ` : ''}Note: ${strays.map((w) => w.id).join(', ')} for this project ` +
          `live in a different repo (created before its registration changed) — their branches don't span repos.`;
      }

      let shared = input.shared ? this.sharedBranchName(input.shared) : undefined;
      if (shared) await this.ensureSharedBranch(shared, repoRoot);

      let branch: string;
      let baseRef: string;
      if (!input.branch) {
        branch = `agent/${input.ownerBot}/${id}-${slug}`;
        baseRef = await this.git(['rev-parse', shared ?? 'HEAD'], repoRoot);
        await this.git(['worktree', 'add', '-b', branch, checkout, baseRef], repoRoot);
      } else {
        branch = input.branch;
        const branchExists = await this.git(
          ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
          repoRoot,
        ).then(
          () => true,
          () => false,
        );
        if (branchExists) {
          // Re-attach: a recorded association is the truth — without this, a removed-then-reopened
          // worktree would silently lose publish/pull.
          const recorded = await this.readSharedConfig(branch, repoRoot);
          if (recorded && shared && recorded !== shared) {
            throw new Error(
              `Branch ${branch} already publishes to ${recorded} — it can't join ${shared}.`,
            );
          }
          shared = recorded ?? shared;
          baseRef = await this.git(['rev-parse', branch], repoRoot);
          await this.git(['worktree', 'add', checkout, branch], repoRoot);
        } else {
          baseRef = await this.git(['rev-parse', shared ?? 'HEAD'], repoRoot);
          await this.git(['worktree', 'add', '-b', branch, checkout, baseRef], repoRoot);
        }
      }
      if (shared) {
        await this.git(['config', `branch.${branch}.${SHARED_CONFIG_KEY}`, shared], repoRoot);
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
        repoRoot,
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
   * When the project has a registered repo (and the identity guard passes), the shared branch is
   * also pushed to ORIGIN — reported via `remote` without ever obscuring the local result.
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
      let local: IntegrationResult | undefined;
      if (await tryPush()) {
        local = { integrated: true, sharedBranch: shared, dirty };
      } else {
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
        local = { integrated: await tryPush(), sharedBranch: shared, dirty };
      }
      // Origin sync — computed AFTER the local result is fixed, so a remote failure can never
      // lose or obscure it.
      if (local.integrated) {
        const remote = await this.syncSharedToOrigin(wt, shared);
        if (remote) local = { ...local, remote };
      }
      return local;
    });
  }

  /** Merge the shared integration branch into a worktree — take teammates' published work. Same
   * conflict shape as publish ("Already up to date" is a success). Local-only v0 (no origin fetch). */
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

  /**
   * Push a worktree's shared branch to its project's registered repo (for open_pr — also the
   * publish sync's engine). Throws when the project is unregistered or the identity guard fails.
   * Pushes the shared REF (not HEAD), so a mid-merge worktree state doesn't matter.
   */
  async pushSharedToOrigin(id: string): Promise<{ sharedBranch: string; gitUrl: string }> {
    return this.gitOps(async () => {
      const wt = this.requireShared(id);
      const shared = wt.sharedBranch!;
      const rec = wt.project ? await this.projects.get(wt.project) : undefined;
      if (!rec) {
        throw new Error(
          `Project "${wt.project || '(none)'}" has no registered GitHub repo — Dennis can register it via the admin API.`,
        );
      }
      const guard = await this.originGuard(wt, rec);
      if (guard) throw new Error(guard);
      await this.git(
        ['push', 'origin', shared],
        wt.repoRoot,
        gitAuthEnv(rec.gitUrl, await this.tokenFor(rec)),
      );
      return { sharedBranch: shared, gitUrl: rec.gitUrl };
    });
  }

  /** Publish's origin sync: undefined when the project is unregistered (local-only is correct),
   * else the push outcome — never a throw. Runs inside the publish mutex. */
  private async syncSharedToOrigin(
    wt: Worktree,
    shared: string,
  ): Promise<IntegrationResult['remote'] | undefined> {
    // Fresh registry read every time — an admin-API edit takes effect immediately.
    const rec = wt.project ? await this.projects.get(wt.project).catch(() => undefined) : undefined;
    if (!rec) return undefined;
    const guard = await this.originGuard(wt, rec);
    if (guard) return { pushed: false, detail: guard };
    try {
      await this.git(
        ['push', 'origin', shared],
        wt.repoRoot,
        gitAuthEnv(rec.gitUrl, await this.tokenFor(rec)),
      );
      return { pushed: true };
    } catch (err) {
      return { pushed: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * The remote-op identity guard: the worktree's repo origin must BE the project's registered repo.
   * A worktree created before its project was registered carries another repo's root — pushing from
   * it with the project's token would publish the wrong branch to the wrong remote. Returns a
   * refusal message, or undefined when the push is safe.
   */
  private async originGuard(wt: Worktree, rec: ProjectRecord): Promise<string | undefined> {
    const origin = await this.git(['remote', 'get-url', 'origin'], wt.repoRoot).catch(() => '');
    if (!origin) {
      return `This worktree's repo has no origin remote — recreate the worktree to work against the project's registered repo (${rec.gitUrl}).`;
    }
    if (!sameGitUrl(origin, rec.gitUrl)) {
      return `This worktree's repo origin (${origin}) isn't the project's registered repo (${rec.gitUrl}) — recreate the worktree to work against it.`;
    }
    return undefined;
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
      await this.git(['worktree', 'remove', '--force', wt.checkout], wt.repoRoot);
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
   * Re-adopt surviving worktrees on boot from EVERY known repo root: WORKER_ROOT (when set) and
   * each registered project whose managed clone exists on disk. Git is the durable store even
   * though this registry (and all sessions) are not. Only `.worktrees/wt-*` checkouts are ours;
   * anything else under `.worktrees/` (e.g. the playground's tickets/jobs trees) is left strictly
   * alone. Nothing is swept: lifecycle is employee-managed.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.adoptWorktrees().catch((err) =>
      this.logger.warn(`Worktree adoption skipped: ${err instanceof Error ? err.message : err}`),
    );
  }

  async adoptWorktrees(): Promise<void> {
    await this.gitOps(async () => {
      if (this.env.get('WORKER_ROOT')) {
        await this.adoptFromRepo(await this.workerRootLayout(), '');
      } else {
        this.logger.warn('WORKER_ROOT not set — skipping local-repo adoption.');
      }
      for (const rec of await this.projects.list().catch(() => [])) {
        if (await exists(join(this.reposRoot(), rec.projectId, '.git'))) {
          await this.adoptFromRepo(await this.cloneLayout(rec), rec.projectId).catch((err) =>
            this.logger.warn(`adoption failed for project ${rec.projectId}: ${err}`),
          );
        }
      }
    });
  }

  private async adoptFromRepo(layout: RepoLayout, project: string): Promise<void> {
    const { repoRoot, subdir, worktreesDir } = layout;
    await this.git(['worktree', 'prune'], repoRoot).catch(() => {});
    const out = await this.git(['worktree', 'list', '--porcelain'], repoRoot).catch(() => '');
    for (const block of out.split('\n\n')) {
      const lines = block.split('\n');
      const checkout = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      if (!checkout || !checkout.startsWith(worktreesDir + '/')) continue;
      const dir = basename(checkout);
      const m = dir.match(/^(wt-\d+)-(.*)$/); // only our own checkouts
      if (!m) continue;
      const [, id, slug] = m;
      // Ids are process-unique at create time, but two repos can hold the same wt-NNN from
      // separate process histories — first adoption wins, the duplicate is surfaced, not clobbered.
      if (this.worktrees.has(id)) {
        this.logger.warn(
          `adoption: ${id} at ${checkout} collides with ${this.worktrees.get(id)?.checkout} — skipped (remove one checkout manually).`,
        );
        continue;
      }
      const branch =
        lines
          .find((l) => l.startsWith('branch '))
          ?.slice('branch '.length)
          .replace('refs/heads/', '') ?? '';
      const owner = branch.match(/^agent\/([^/]+)\//)?.[1] ?? '';
      const shared = branch ? await this.readSharedConfig(branch, repoRoot) : undefined;
      this.worktrees.set(id, {
        id,
        name: slug,
        branch,
        baseRef: '',
        path: withSubdir(checkout, subdir),
        checkout,
        ownerBot: owner,
        project,
        repoRoot,
        ...(shared ? { sharedBranch: shared } : {}),
      });
      // Keep the id counter clear of every adopted id so new creates can't collide.
      const n = Number(id.slice('wt-'.length));
      if (Number.isFinite(n) && n > this.counter) this.counter = n;
      this.logger.log(`adopted ${id} (${branch || 'detached'}) at ${checkout}`);
    }
  }
}
