import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { access, appendFile, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { createMutex } from '../domain/async';
import { DEFAULT_TEAM } from '../domain/identity';
import { gitAuthEnv, sameGitUrl } from '../projects/git-auth';
import { GithubTokenStore } from '../projects/github-token-store';
import { ProjectStore } from '../projects/project-store';
import type { ProjectRecord } from '../projects/project.types';
import type {
  BaseRefreshResult,
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
    return (
      this.env.get('REPOS_ROOT') ??
      join(homedir(), '.agent-playground', 'repos')
    );
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
    return (
      await this.tokens
        .resolve(rec.teamId, rec.tokenName)
        .catch(() => undefined)
    )?.token;
  }

  /**
   * The project record a worktree's remote ops run against. `wt.project` when it resolves; else
   * RECOVERED from git, the durable store: a repo whose origin IS a registered project's repo
   * belongs to that project (`sameGitUrl`, the originGuard's own identity rule). Recovery
   * backfills `wt.project`, so a tree re-adopted from WORKER_ROOT with no project after a restart
   * — or created before its project was registered — heals on first use instead of failing as
   * "(none)". Registry records are read fresh (an admin-API edit takes effect immediately).
   */
  async projectRecordFor(
    worktreeId: string,
  ): Promise<ProjectRecord | undefined> {
    const wt = this.worktrees.get(worktreeId);
    if (!wt) return undefined;
    if (wt.project) {
      const rec = await this.projects
        .get(wt.team, wt.project)
        .catch(() => undefined);
      if (rec) return rec;
    }
    const origin = await this.git(
      ['remote', 'get-url', 'origin'],
      wt.repoRoot,
    ).catch(() => '');
    if (!origin) return undefined;
    const rec = (await this.projects.list(wt.team).catch(() => [])).find((r) =>
      sameGitUrl(origin, r.gitUrl),
    );
    if (rec && wt.project !== rec.projectId) {
      this.logger.log(
        `${wt.id}: recovered project ${rec.projectId} from origin ${origin}`,
      );
      wt.project = rec.projectId;
    }
    return rec;
  }

  private cachedLayout(
    key: string,
    build: () => Promise<RepoLayout>,
  ): Promise<RepoLayout> {
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
      const repoRoot = await this.git(
        ['rev-parse', '--show-toplevel'],
        this.workerRoot(),
      );
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

  /** A registered project's managed clone, created on first use. Per-tenant path: repos live under
   * `<REPOS_ROOT>/<teamId>/<projectId>` so two workspaces' same-slug projects never collide. */
  private cloneLayout(rec: ProjectRecord): Promise<RepoLayout> {
    return this.cachedLayout(
      `proj:${rec.teamId}:${rec.projectId}`,
      async () => {
        const root = join(this.reposRoot(), rec.teamId, rec.projectId);
        const teamRoot = join(this.reposRoot(), rec.teamId);
        if (!(await exists(join(root, '.git')))) {
          await mkdir(teamRoot, { recursive: true });
          const auth = gitAuthEnv(rec.gitUrl, await this.tokenFor(rec));
          this.logger.log(
            `cloning ${rec.gitUrl} → ${root} (team ${rec.teamId}, project ${rec.projectId})`,
          );
          await this.git(['clone', rec.gitUrl, root], teamRoot, auth);
          // Keep worktree checkouts out of `git status` noise without touching the repo's own files.
          await appendFile(
            join(root, '.git', 'info', 'exclude'),
            '\n.worktrees/\n',
          ).catch(() => {});
        }
        const repoRoot = await realpath(root);
        return {
          repoRoot,
          subdir: '',
          worktreesDir: join(repoRoot, '.worktrees'),
        };
      },
    );
  }

  /**
   * The repo a project's worktrees live in. Registered → the managed clone (with origin-URL drift
   * repair: a PATCHed git_url must take effect, not silently keep pushing to the old repo — repair
   * applies ONLY to managed clones, never WORKER_ROOT). Unregistered / '' → WORKER_ROOT.
   */
  private async resolveLayout(
    team: string,
    project: string,
  ): Promise<RepoLayout> {
    const rec = project ? await this.projects.get(team, project) : undefined;
    if (!rec) return this.workerRootLayout();
    const layout = await this.cloneLayout(rec);
    const origin = await this.git(
      ['remote', 'get-url', 'origin'],
      layout.repoRoot,
    ).catch(() => '');
    if (origin && !sameGitUrl(origin, rec.gitUrl)) {
      this.logger.warn(
        `project ${rec.projectId}: origin drifted (${origin}) — repointing to ${rec.gitUrl}`,
      );
      await this.git(
        ['remote', 'set-url', 'origin', rec.gitUrl],
        layout.repoRoot,
      );
    }
    return layout;
  }

  private nextId(): string {
    return `wt-${(++this.counter).toString().padStart(3, '0')}`;
  }

  /** Warn (don't block) when the base checkout has uncommitted tracked changes — worktrees branch
   * from committed HEAD, so uncommitted scratch simply won't appear in them. */
  private async dirtyBaseWarning(
    repoRoot: string,
  ): Promise<string | undefined> {
    const dirty = await this.git(
      ['status', '--porcelain', '--untracked-files=no'],
      repoRoot,
    ).catch(() => '');
    return dirty.trim()
      ? 'Note: the base checkout has uncommitted tracked changes — they will NOT appear in this worktree (it branches from committed HEAD).'
      : undefined;
  }

  /**
   * Commits made inside a worktree are authored as the OWNING EMPLOYEE, not the host machine's
   * global git identity. Per-worktree config (`extensions.worktreeConfig`) is the seam: it covers
   * every engine (SDK, codex subprocess, langgraph bash) and the service's own publish/pull merge
   * commits, and it survives restarts in `.git/worktrees/<id>/config.worktree`. Enabling the
   * extension is safe for normal checkouts (the documented relocation caveat only concerns
   * `core.bare`/`core.worktree`, which plain clones don't set). Ownerless adopted trees are
   * skipped. Best-effort: attribution must never fail a create/adopt.
   */
  private async setWorktreeIdentity(
    checkout: string,
    repoRoot: string,
    ownerBot: string,
  ): Promise<void> {
    if (!ownerBot) return;
    try {
      await this.git(['config', 'extensions.worktreeConfig', 'true'], repoRoot);
      const name = ownerBot.charAt(0).toUpperCase() + ownerBot.slice(1);
      await this.git(['config', '--worktree', 'user.name', name], checkout);
      await this.git(
        ['config', '--worktree', 'user.email', `${ownerBot}@agents.noreply`],
        checkout,
      );
    } catch (err) {
      this.logger.warn(
        `could not set git identity for ${ownerBot} at ${checkout}: ${err}`,
      );
    }
  }

  /** Normalize an employee-supplied shared name to `shared/<slug>` (a leading `shared/` is allowed
   * and stripped first, so passing a full branch name back in can't double-prefix). */
  private sharedBranchName(input: string): string {
    return `shared/${slugify(input.replace(/^shared\//, ''))}`;
  }

  /** Create the shared integration branch from `startPoint` (the freshly-fetched base ref, so a
   * first-time shared branch starts from the latest base — see `freshBaseRef`) if absent. "Already
   * exists" is success — the branch can pre-exist from a prior process or a teammate's earlier
   * create, and is NEVER re-based onto the new base (it advances via publish). (Only called inside
   * the gitOps mutex, so no extra memoization is needed.) */
  private async ensureSharedBranch(
    shared: string,
    repoRoot: string,
    startPoint: string,
  ): Promise<void> {
    await this.git(['branch', shared, startPoint], repoRoot).catch((e) => {
      if (!/already exists/i.test(String(e))) throw e;
    });
  }

  /**
   * The start point for a FRESH cut: the project's base branch (`defaultBranch`) fetched from
   * origin, so new worktrees and first-time shared branches begin from the latest base instead of
   * the managed clone's frozen HEAD (the clone is made once and never pulled). Returns a resolved
   * commit sha (the worktree-add calls take a sha). Cutting from the remote-tracking ref
   * `origin/<base>` sidesteps git's refusal to fetch into the clone's checked-out branch.
   *
   * Unregistered projects (WORKER_ROOT — no record, no token, ambiguous base) keep cutting from
   * local HEAD. A fetch failure (origin missing the branch, auth/network) falls back to HEAD with a
   * warning rather than failing the create.
   */
  private async freshBaseRef(
    team: string,
    project: string,
    repoRoot: string,
  ): Promise<{ ref: string; warning?: string }> {
    const rec = project
      ? await this.projects.get(team, project).catch(() => undefined)
      : undefined;
    if (!rec) return { ref: await this.git(['rev-parse', 'HEAD'], repoRoot) };
    const base = rec.defaultBranch;
    try {
      await this.git(
        ['fetch', 'origin', base],
        repoRoot,
        gitAuthEnv(rec.gitUrl, await this.tokenFor(rec)),
      );
      return {
        ref: await this.git(['rev-parse', `origin/${base}`], repoRoot),
      };
    } catch (err) {
      this.logger.warn(
        `couldn't refresh base ${base} from origin for ${rec.projectId} — cutting from local state: ${err}`,
      );
      return {
        ref: await this.git(['rev-parse', 'HEAD'], repoRoot),
        warning: `Note: couldn't refresh base ${base} from origin — this worktree was cut from local state and may be behind.`,
      };
    }
  }

  /** True when the checkout has a merge in progress (MERGE_HEAD present). Both publish and pull
   * must refuse then: HEAD is still the pre-merge commit, so a push would publish stale work and
   * the next merge would die with "unfinished merge". */
  private async mergeInProgress(checkout: string): Promise<boolean> {
    return this.git(
      ['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
      checkout,
    ).then(
      () => true,
      () => false,
    );
  }

  private async conflictedFiles(checkout: string): Promise<string[]> {
    return this.git(['diff', '--name-only', '--diff-filter=U'], checkout)
      .then((s) => s.split('\n').filter(Boolean))
      .catch(() => []);
  }

  /** Read-only: whether a merge is in progress in this worktree (MERGE_HEAD present), and the
   * conflicted paths if so. The session-approval gate uses this to let an UNLINKED execute session
   * through purely to finish a merge the harness itself left behind (publish/pull/refresh). Read-only
   * git (rev-parse/diff), so it needs no gitOps mutex; an unknown worktree reads as no merge. */
  async mergeState(
    worktreeId: string,
  ): Promise<{ inProgress: boolean; files: string[] }> {
    const wt = this.worktrees.get(worktreeId);
    if (!wt) return { inProgress: false, files: [] };
    const inProgress = await this.mergeInProgress(wt.checkout);
    return {
      inProgress,
      files: inProgress ? await this.conflictedFiles(wt.checkout) : [],
    };
  }

  private async readSharedConfig(
    branch: string,
    repoRoot: string,
  ): Promise<string | undefined> {
    return this.git(
      ['config', '--get', `branch.${branch}.${SHARED_CONFIG_KEY}`],
      repoRoot,
    ).then(
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
  async create(
    input: NewWorktree,
  ): Promise<{ worktree: Worktree; warning?: string }> {
    return this.gitOps(async () => {
      // A checked-out shared branch would make every teammate's publish fail forever with git's
      // "refusing to update checked out branch" — the shared branch is a ref, never a checkout.
      if (input.branch?.startsWith('shared/')) {
        throw new Error(
          'Shared branches are never checked out — pass `shared` instead of `branch` to join one.',
        );
      }
      const { repoRoot, subdir, worktreesDir } = await this.resolveLayout(
        input.team,
        input.project,
      );
      const id = this.nextId();
      const slug = slugify(input.name);
      const checkout = join(worktreesDir, `${id}-${slug}`);
      await mkdir(worktreesDir, { recursive: true });
      let warning = await this.dirtyBaseWarning(repoRoot);
      // A project registered AFTER worktrees were cut for it on WORKER_ROOT: those old trees stay
      // on the old repo (their shared branches don't span repos) — surface it once, at create.
      const strays = [...this.worktrees.values()].filter(
        (w) =>
          w.team === input.team &&
          w.project === input.project &&
          w.repoRoot !== repoRoot,
      );
      if (strays.length) {
        warning =
          `${warning ? `${warning} ` : ''}Note: ${strays.map((w) => w.id).join(', ')} for this project ` +
          `live in a different repo (created before its registration changed) — their branches don't span repos.`;
      }

      // Cut fresh from the project's base branch fetched from origin (not the managed clone's
      // frozen HEAD) so new worktrees — and first-time shared branches — start current.
      const { ref: freshBase, warning: baseWarning } = await this.freshBaseRef(
        input.team,
        input.project,
        repoRoot,
      );
      if (baseWarning)
        warning = warning ? `${warning} ${baseWarning}` : baseWarning;

      let shared = input.shared
        ? this.sharedBranchName(input.shared)
        : undefined;
      if (shared) await this.ensureSharedBranch(shared, repoRoot, freshBase);

      let branch: string;
      let baseRef: string;
      if (!input.branch) {
        branch = `agent/${input.ownerBot}/${id}-${slug}`;
        baseRef = shared
          ? await this.git(['rev-parse', shared], repoRoot)
          : freshBase;
        await this.git(
          ['worktree', 'add', '-b', branch, checkout, baseRef],
          repoRoot,
        );
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
          baseRef = shared
            ? await this.git(['rev-parse', shared], repoRoot)
            : freshBase;
          await this.git(
            ['worktree', 'add', '-b', branch, checkout, baseRef],
            repoRoot,
          );
        }
      }
      if (shared) {
        await this.git(
          ['config', `branch.${branch}.${SHARED_CONFIG_KEY}`, shared],
          repoRoot,
        );
      }
      await this.setWorktreeIdentity(checkout, repoRoot, input.ownerBot);
      // A repo with submodules needs them populated before the worktree builds (a fresh checkout
      // gets empty submodule dirs). Best-effort: a failure must never fail the create, but it must
      // be loud — a silent init failure produces empty submodule dirs which causes TS2307
      // "Cannot find module '@workspace/langfuse'" (and @workspace/auth) at install/typecheck time.
      if (await exists(join(checkout, '.gitmodules'))) {
        await this.git(
          ['submodule', 'update', '--init', '--recursive'],
          checkout,
        ).catch((err) => {
          const remediation = `cd ${checkout} && git submodule update --init --recursive`;
          this.logger.error(
            `${id}: submodule init failed — workspace packages (e.g. @workspace/langfuse, ` +
              `@workspace/auth) will be unresolved until you run: ${remediation}. Error: ${err}`,
          );
          const initMsg =
            `Submodule init failed: workspace packages (@workspace/langfuse, @workspace/auth) ` +
            `will be unresolved. Run: ${remediation}`;
          warning = warning ? `${warning} ${initMsg}` : initMsg;
        });
      }

      const worktree: Worktree = {
        id,
        name: input.name,
        branch,
        baseRef,
        path: withSubdir(checkout, subdir),
        checkout,
        ownerBot: input.ownerBot,
        team: input.team,
        project: input.project,
        repoRoot,
        ...(shared ? { sharedBranch: shared } : {}),
      };
      this.worktrees.set(id, worktree);
      this.logger.log(
        `${id} created: ${branch} at ${checkout}${shared ? ` (shared: ${shared})` : ''}`,
      );
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
      // Take origin's shared state in FIRST, so a branch advanced on GitHub merges into this
      // publish instead of rejecting the origin push at the end.
      await this.fetchSharedFromOrigin(wt, shared);
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
        local = { ...local, remote: await this.syncSharedToOrigin(wt, shared) };
      }
      return local;
    });
  }

  /** Best-effort authenticated fast-forward of the local shared ref from origin. True when the
   * fetch landed (or was already current); false when no registered repo matches, the identity
   * guard refuses, or the fetch fails (origin missing the branch, local ahead, divergence). */
  private async fetchSharedFromOrigin(
    wt: Worktree,
    shared: string,
  ): Promise<boolean> {
    const rec = await this.projectRecordFor(wt.id);
    if (!rec || (await this.originGuard(wt, rec))) return false;
    return this.git(
      ['fetch', 'origin', `${shared}:${shared}`],
      wt.repoRoot,
      gitAuthEnv(rec.gitUrl, await this.tokenFor(rec)),
    ).then(
      () => true,
      () => false,
    );
  }

  /** Merge the shared integration branch into a worktree — take teammates' published work,
   * syncing the shared ref from origin first when the project has a registered repo. Same
   * conflict shape as publish ("Already up to date" is a success). */
  async pull(id: string): Promise<IntegrationResult> {
    return this.gitOps(async () => {
      const wt = this.requireShared(id);
      const shared = wt.sharedBranch!;
      await this.refuseMidMerge(wt.checkout);
      const originFetched = await this.fetchSharedFromOrigin(wt, shared);
      try {
        await this.git(['merge', '--no-edit', shared], wt.checkout);
      } catch (err) {
        if (await this.mergeInProgress(wt.checkout)) {
          return {
            integrated: false,
            sharedBranch: shared,
            files: await this.conflictedFiles(wt.checkout),
            originFetched,
          };
        }
        throw err;
      }
      return { integrated: true, sharedBranch: shared, originFetched };
    });
  }

  /**
   * Bring a worktree's branch up to date with its project's BASE branch: fetch `origin/<defaultBranch>`
   * and merge it into the checkout. This is the "keep the worktree current" primitive — a worktree
   * cut during stand-up planning is stale by the time it executes (base moved). Same conflict shape
   * as publish/pull (the merge is left IN PROGRESS for a session's turn to resolve). Unregistered
   * projects, an origin-guard refusal, a DIRTY working tree (git would refuse the merge), or a fetch
   * miss are no-ops (`refreshed:false` + detail), never errors — execution proceeds on local state
   * rather than being blocked. The caller surfaces non-clean outcomes to the owner.
   */
  async refreshFromBase(id: string): Promise<BaseRefreshResult> {
    return this.gitOps(async () => {
      const wt = this.worktrees.get(id);
      if (!wt) throw new Error(`No worktree "${id}".`);
      await this.refuseMidMerge(wt.checkout);
      const rec = await this.projectRecordFor(id);
      if (!rec) {
        return {
          refreshed: false,
          detail:
            'no registered GitHub repo matches this worktree — base refresh skipped (working on local state).',
        };
      }
      const guard = await this.originGuard(wt, rec);
      if (guard) return { refreshed: false, detail: guard };
      const base = rec.defaultBranch;
      // Uncommitted tracked changes make `git merge` refuse outright (it would clobber them) — return
      // a structured result, not a thrown error, so the caller can tell the owner to commit + refresh.
      const dirty = !!(
        await this.git(
          ['status', '--porcelain', '--untracked-files=no'],
          wt.checkout,
        ).catch(() => '')
      ).trim();
      if (dirty) {
        return {
          refreshed: false,
          dirty: true,
          baseBranch: base,
          detail: `the worktree has uncommitted changes — commit them, then refresh against ${base}`,
        };
      }
      const auth = gitAuthEnv(rec.gitUrl, await this.tokenFor(rec));
      try {
        await this.git(['fetch', 'origin', base], wt.repoRoot, auth);
      } catch (err) {
        return {
          refreshed: false,
          baseBranch: base,
          detail: `couldn't fetch ${base} from origin: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      try {
        await this.git(['merge', '--no-edit', `origin/${base}`], wt.checkout);
      } catch (err) {
        if (await this.mergeInProgress(wt.checkout)) {
          return {
            refreshed: false,
            conflicted: true,
            baseBranch: base,
            files: await this.conflictedFiles(wt.checkout),
          };
        }
        throw err;
      }
      return { refreshed: true, baseBranch: base };
    });
  }

  /**
   * Push a worktree's shared branch to its project's registered repo (for open_pr — also the
   * publish sync's engine). Throws when the project is unregistered or the identity guard fails.
   * Pushes the shared REF (not HEAD), so a mid-merge worktree state doesn't matter.
   */
  async pushSharedToOrigin(
    id: string,
  ): Promise<{ sharedBranch: string; gitUrl: string }> {
    return this.gitOps(async () => {
      const wt = this.requireShared(id);
      const shared = wt.sharedBranch!;
      const rec = await this.projectRecordFor(id);
      if (!rec) {
        const origin = await this.git(
          ['remote', 'get-url', 'origin'],
          wt.repoRoot,
        ).catch(() => '');
        throw new Error(
          `No registered GitHub repo matches this worktree (project "${wt.project || '(none)'}", repo origin ${origin || '(none)'}) — Dennis can register it via the admin API.`,
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

  /** Publish's origin sync: ALWAYS the push outcome, never a throw — a shared branch that didn't
   * reach GitHub must say so (`pushed: false` + detail), not look like a clean publish. Runs
   * inside the publish mutex. */
  private async syncSharedToOrigin(
    wt: Worktree,
    shared: string,
  ): Promise<NonNullable<IntegrationResult['remote']>> {
    const rec = await this.projectRecordFor(wt.id);
    if (!rec) {
      const origin = await this.git(
        ['remote', 'get-url', 'origin'],
        wt.repoRoot,
      ).catch(() => '');
      return {
        pushed: false,
        detail: `no registered GitHub repo matches this worktree (repo origin ${origin || '(none)'}) — the shared branch is LOCAL ONLY until Dennis registers it via the admin API`,
      };
    }
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
      return {
        pushed: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * The remote-op identity guard: the worktree's repo origin must BE the project's registered repo.
   * A worktree created before its project was registered carries another repo's root — pushing from
   * it with the project's token would publish the wrong branch to the wrong remote. Returns a
   * refusal message, or undefined when the push is safe.
   */
  private async originGuard(
    wt: Worktree,
    rec: ProjectRecord,
  ): Promise<string | undefined> {
    const origin = await this.git(
      ['remote', 'get-url', 'origin'],
      wt.repoRoot,
    ).catch(() => '');
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

  /**
   * Promote a worktree to a shared integration branch if it isn't on one already — so the review
   * pipeline always has a `shared/<slug>` to publish + open/ready the PR through, for SOLO work as
   * well as multi-employee. Without this, a solo engineer's personal-branch work can't be readied by
   * the harness (mark_pr_ready / the pipeline only reach shared branches). Idempotent: a worktree that
   * already joined a shared branch (explicit multi-employee work) keeps it. The caller derives `name`
   * from the TICKET at execute-session start, so every owner of a ticket converges on the SAME shared
   * branch with no name coordination. Returns the shared branch name, or undefined for an unknown
   * worktree. Cuts the shared branch from the worktree's current branch tip (refreshed from base at
   * execute start, so ≈ origin/base) — a later publish fast-forwards / merges the personal work in.
   */
  async ensureShared(
    id: string,
    name: string,
    startPoint?: string,
  ): Promise<string | undefined> {
    return this.gitOps(async () => {
      const wt = this.worktrees.get(id);
      if (!wt) return undefined;
      if (wt.sharedBranch) return wt.sharedBranch; // already shared — respect it
      const shared = this.sharedBranchName(name);
      // Default start point is the branch tip (fresh-worktree case ≈ origin/base). A caller can pass
      // an explicit start point (see `ensureSharedAtBase`) to cut the shared branch elsewhere.
      const start =
        startPoint ?? (await this.git(['rev-parse', wt.branch], wt.repoRoot));
      await this.ensureSharedBranch(shared, wt.repoRoot, start);
      // Record the personal branch's association so it survives restarts (re-adopted like create()).
      await this.git(
        ['config', `branch.${wt.branch}.${SHARED_CONFIG_KEY}`, shared],
        wt.repoRoot,
      );
      wt.sharedBranch = shared;
      this.logger.log(
        `${id}: promoted ${wt.branch} to shared branch ${shared}`,
      );
      return shared;
    });
  }

  /**
   * Retroactively promote a worktree that ALREADY has owner commits to a shared branch, cut at the
   * branch's DIVERGENCE POINT from the base (`merge-base`), not its tip. The review pipeline uses this
   * to self-heal a worktree that never joined a shared branch at execute start: cutting at the tip
   * (plain `ensureShared`) would make the owner's self-review range `<sharedRef>...<branch>` empty, so
   * their real code would never be reviewed. The merge-base start point yields exactly the owner's own
   * commits — any execute-start base-refresh merge sits BELOW it and is excluded. Works for adopted
   * worktrees too (no stored `baseRef` needed). Returns a typed failure (rather than throwing) when the
   * worktree is gone, unregistered (can't open a PR anyway), the origin guard refuses, or the base
   * divergence point can't be resolved — the pipeline surfaces these loud upstream.
   */
  async ensureSharedAtBase(
    id: string,
    name: string,
  ): Promise<
    { ok: true; sharedBranch: string } | { ok: false; reason: string }
  > {
    const wt = this.worktrees.get(id);
    if (!wt) return { ok: false, reason: `worktree ${id} no longer exists` };
    if (wt.sharedBranch) return { ok: true, sharedBranch: wt.sharedBranch };
    const rec = await this.projectRecordFor(id);
    if (!rec)
      return {
        ok: false,
        reason: `no registered GitHub repo matches worktree ${id} — it can't open a PR`,
      };
    // Mirror the remote-op identity guard BEFORE any authenticated network op: projectRecordFor's
    // `wt.project` fast-path returns a record without verifying the actual remote, so a stale or
    // misregistered worktree could otherwise fetch the wrong origin with the project's token.
    const guard = await this.originGuard(wt, rec);
    if (guard) return { ok: false, reason: guard };
    const base = rec.defaultBranch;
    // Best-effort: refresh origin/<base> so the merge-base is against the latest base. A miss still
    // lets us fall back to whatever origin/<base> we already have locally.
    await this.git(
      ['fetch', 'origin', base],
      wt.repoRoot,
      gitAuthEnv(rec.gitUrl, await this.tokenFor(rec)),
    ).catch(() => undefined);
    const startPoint = (
      await this.git(
        ['merge-base', wt.branch, `origin/${base}`],
        wt.repoRoot,
      ).catch(() => '')
    ).trim();
    if (!startPoint)
      return {
        ok: false,
        reason: `couldn't resolve the base divergence point (merge-base ${wt.branch}..origin/${base}) to cut a shared branch`,
      };
    const shared = await this.ensureShared(id, name, startPoint);
    if (!shared)
      return {
        ok: false,
        reason: `couldn't promote worktree ${id} to a shared branch`,
      };
    return { ok: true, sharedBranch: shared };
  }

  /**
   * The current tip sha of a worktree's shared integration branch — captured by the review pipeline
   * BEFORE publish, so an owner's self-review can diff `<sharedRef>...<ownerBranch>` (three-dot:
   * changes on the owner's branch since it diverged from shared) and never re-review a prior owner's
   * already-integrated work. Undefined if the worktree has no shared branch.
   */
  async sharedRef(id: string): Promise<string | undefined> {
    const wt = this.worktrees.get(id);
    if (!wt?.sharedBranch) return undefined;
    return this.git(['rev-parse', wt.sharedBranch], wt.repoRoot).catch(
      () => undefined,
    );
  }

  /**
   * The git range that isolates an owner's own contribution for self-review: changed files in
   * `<sinceRef>...<ownerBranch>`. Returns the range string + the changed file list (empty when the
   * owner added nothing since `sinceRef`). The review engine runs git itself in the checkout; the
   * file list is for the pipeline's own "nothing to review" short-circuit and logging.
   */
  async ownerDiff(
    id: string,
    sinceRef: string,
  ): Promise<{ range: string; files: string[] }> {
    const wt = this.worktrees.get(id);
    if (!wt) throw new Error(`No worktree "${id}".`);
    const range = `${sinceRef}...${wt.branch}`;
    const out = await this.git(
      ['diff', '--name-only', range],
      wt.checkout,
    ).catch(() => '');
    const files = out
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    return { range, files };
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
      await this.git(
        ['worktree', 'remove', '--force', wt.checkout],
        wt.repoRoot,
      );
      this.worktrees.delete(id);
      this.logger.log(`${id} removed (branch ${wt.branch} kept)`);
    });
  }

  get(id: string): Worktree | undefined {
    return this.worktrees.get(id);
  }

  /**
   * Git-derived shared-branch status for list_worktrees: is this worktree's branch merged into the
   * shared branch (i.e. has it published), and how many shared commits origin doesn't have yet.
   * `aheadOfOrigin` is undefined when origin's ref is unknown locally (never pushed/fetched).
   * Read-only — safe outside the mutex.
   */
  async sharedStatus(
    id: string,
  ): Promise<{ published: boolean; aheadOfOrigin?: number } | undefined> {
    const wt = this.worktrees.get(id);
    if (!wt?.sharedBranch) return undefined;
    const shared = wt.sharedBranch;
    const published = await this.git(
      ['merge-base', '--is-ancestor', wt.branch, shared],
      wt.repoRoot,
    ).then(
      () => true,
      () => false,
    );
    const ahead = await this.git(
      ['rev-list', '--count', `origin/${shared}..${shared}`],
      wt.repoRoot,
    ).then(
      (s) => Number(s),
      () => undefined,
    );
    return {
      published,
      ...(ahead !== undefined ? { aheadOfOrigin: ahead } : {}),
    };
  }

  list(filter?: { ownerBot?: string }): Worktree[] {
    const all = [...this.worktrees.values()];
    return filter?.ownerBot
      ? all.filter((w) => w.ownerBot === filter.ownerBot)
      : all;
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
      this.logger.warn(
        `Worktree adoption skipped: ${err instanceof Error ? err.message : err}`,
      ),
    );
  }

  async adoptWorktrees(): Promise<void> {
    await this.gitOps(async () => {
      if (this.env.get('WORKER_ROOT')) {
        // WORKER_ROOT is the dev single-repo — its adopted trees belong to the default team.
        await this.adoptFromRepo(
          await this.workerRootLayout(),
          DEFAULT_TEAM,
          '',
        );
      } else {
        this.logger.warn('WORKER_ROOT not set — skipping local-repo adoption.');
      }
      // Cross-tenant: re-adopt every workspace's managed clones.
      for (const rec of await this.projects.listAll().catch(() => [])) {
        if (
          await exists(
            join(this.reposRoot(), rec.teamId, rec.projectId, '.git'),
          )
        ) {
          await this.adoptFromRepo(
            await this.cloneLayout(rec),
            rec.teamId,
            rec.projectId,
          ).catch((err) =>
            this.logger.warn(
              `adoption failed for project ${rec.teamId}/${rec.projectId}: ${err}`,
            ),
          );
        }
      }
      await this.recoverAdoptedProjects();
    });
  }

  /**
   * Heal project associations the WORKER_ROOT pass adopts as '' (a restart used to demote every
   * such worktree to "(none)" until Dennis "re-registered" a repo that was registered all along):
   * a repo whose origin IS a registered project's repo belongs to that project.
   */
  private async recoverAdoptedProjects(): Promise<void> {
    const orphans = [...this.worktrees.values()].filter((w) => !w.project);
    if (!orphans.length) return;
    const recs = await this.projects.listAll().catch(() => []);
    if (!recs.length) return;
    const byRepo = new Map<string, { project: string; team: string }>();
    for (const wt of orphans) {
      let hit = byRepo.get(wt.repoRoot);
      if (hit === undefined) {
        const origin = await this.git(
          ['remote', 'get-url', 'origin'],
          wt.repoRoot,
        ).catch(() => '');
        const rec = origin
          ? recs.find((r) => sameGitUrl(origin, r.gitUrl))
          : undefined;
        hit = { project: rec?.projectId ?? '', team: rec?.teamId ?? wt.team };
        byRepo.set(wt.repoRoot, hit);
      }
      if (hit.project) {
        wt.project = hit.project;
        wt.team = hit.team;
        this.logger.log(
          `adoption: ${wt.id} recovered project ${hit.team}/${hit.project} from origin`,
        );
      }
    }
  }

  private async adoptFromRepo(
    layout: RepoLayout,
    team: string,
    project: string,
  ): Promise<void> {
    const { repoRoot, subdir, worktreesDir } = layout;
    await this.git(['worktree', 'prune'], repoRoot).catch(() => {});
    const out = await this.git(
      ['worktree', 'list', '--porcelain'],
      repoRoot,
    ).catch(() => '');
    for (const block of out.split('\n\n')) {
      const lines = block.split('\n');
      const checkout = lines
        .find((l) => l.startsWith('worktree '))
        ?.slice('worktree '.length);
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
      const shared = branch
        ? await this.readSharedConfig(branch, repoRoot)
        : undefined;
      // Backfill employee authorship onto trees from before identity existed (idempotent).
      await this.setWorktreeIdentity(checkout, repoRoot, owner);
      this.worktrees.set(id, {
        id,
        name: slug,
        branch,
        baseRef: '',
        path: withSubdir(checkout, subdir),
        checkout,
        ownerBot: owner,
        team,
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
