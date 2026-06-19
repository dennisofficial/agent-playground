import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  GithubApiService,
  type PullRequestResult,
} from '@harness/projects/github-api.service';
import {
  gitAuthEnv,
  parseGithubRepo,
  sameGitUrl,
} from '@harness/projects/git-auth';
import {
  GIT_CREDENTIAL_PROVIDER,
  type GitCredentialProvider,
  type ResolvedGitCredential,
} from './git-credential.provider';

const execFileAsync = promisify(execFile);

// Branch-config keys recording the per-branch workstation's durable association — same shape the host
// `WorkspaceService` used for the shared branch (`branch.<b>.agent-shared`), but for the workstation model:
// the UPSTREAM the branch refreshes-from / PRs into, and the BASE REF the branch was cut from. Recorded on
// the checked-out branch so a re-adopted (restarted) daemon recovers them without the env.
const UPSTREAM_CONFIG_KEY = 'agent-upstream';
const BASE_CONFIG_KEY = 'agent-base';

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

/** The outcome of a publish (push the branch to origin) or a pull/refresh (merge the upstream in). Mirrors
 * the host `IntegrationResult` shape so the host adapter deserializes it unchanged — but the WORKSTATION
 * model has no shared integration branch: a feature IS one branch the whole team commits to and syncs via
 * origin. `branch` carries the workstation's branch; `upstream` the ref it integrates with. */
export interface DaemonIntegrationResult {
  integrated: boolean;
  /** The workstation's branch (what publish pushes / pull merges into). Named to match the host field. */
  sharedBranch: string;
  /** Conflicted paths when `integrated` is false — the merge is left IN PROGRESS in the checkout so a
   * session's next turn resolves and commits it. */
  files?: string[];
  /** Publish only: the checkout had uncommitted changes — those were NOT published (only commits do). */
  dirty?: boolean;
  /** Publish only: the push outcome to origin. */
  remote?: { pushed: boolean; detail?: string };
  /** Pull only: whether the upstream ref was first fetched from origin. */
  originFetched?: boolean;
}

/** The outcome of refreshing the workstation branch against its upstream. */
export interface DaemonBaseRefreshResult {
  refreshed: boolean;
  baseBranch?: string;
  conflicted?: boolean;
  dirty?: boolean;
  files?: string[];
  detail?: string;
}

/**
 * The DAEMON's single-repo git owner — the in-container counterpart to the host `WorkspaceService`.
 *
 * THE WORKSTATION MODEL. ONE container = ONE fresh clone of ONE repo (at `WORKSPACE_ROOT`) checked out
 * DIRECTLY on ONE branch (`WORKSPACE_BRANCH`). A feature is that ONE branch the whole team commits to
 * directly and syncs via origin — there are NO inner worktrees, NO personal branches, and NO local
 * `shared/<slug>` integration branch / merge-convergence. Every git op runs in the single clone root.
 *
 * The branch refreshes-from / opens its PR INTO its UPSTREAM (`WORKSPACE_UPSTREAM`, e.g. `dev`), and was
 * cut from its BASE REF (`WORKSPACE_BASE_REF`) when it didn't yet exist on origin. Both are recorded
 * durably in git config (`branch.<b>.agent-upstream` / `branch.<b>.agent-base`) so a restarted daemon
 * recovers them from the checkout (mirroring how the host stored the shared association).
 *
 * The host service is multi-project + registry-heavy (resolves a repo per `(team, project)`, clones
 * managed copies under REPOS_ROOT, re-adopts workspaces across many repos, runs an origin-IDENTITY guard
 * because a workspace may carry the wrong repo's origin). NONE of that exists here: the daemon's clone IS
 * the project, by construction. The origin-identity guard from the host is KEPT (`sameGitUrl`) as
 * defense-in-depth before any push: the clone origin should BE `gitUrl`, but we never push to a drifted
 * origin with the token.
 *
 * Credential resolution is behind `GitCredentialProvider` (PAT today, GitHub-App later) — `resolve()` is
 * called immediately before each authenticated op so a short-lived token is always current.
 *
 * NOT a Nest lifecycle hook: there's no boot adoption across repos (the container is created fresh;
 * `ensureClone` is the explicit entry point the readiness path / bootstrap calls). All git ops assume
 * single-threaded daemon use; the host's gitOps mutex is unnecessary because the Redis consumer loop
 * serializes commands per workspace.
 */
@Injectable()
export class DaemonGitService {
  private readonly logger = new Logger(DaemonGitService.name);
  /** Set once `ensureClone` runs — the cloned repo root + the checked-out branch + its upstream + origin URL.
   * `branch` is the single workstation branch every op runs against; `upstream` is what it refreshes-from /
   * PRs into; `baseRef` is what the branch was cut from. */
  private repo?: {
    root: string;
    branch: string;
    upstream: string;
    baseRef: string;
    gitUrl: string;
  };
  /** Resolves once the boot clone (`ensureClone`) has completed — the readiness gate and the turn path
   * await this so no git op runs against a not-yet-cloned repo. Settled by `markCloned`/`markCloneFailed`,
   * which `DaemonBootstrapService` calls. Undefined until `expectClone()` is told a clone is coming. */
  private cloneGate?: Promise<void>;
  private resolveCloneGate?: () => void;
  private rejectCloneGate?: (err: Error) => void;

  constructor(
    @Inject(GIT_CREDENTIAL_PROVIDER)
    private readonly credentials: GitCredentialProvider,
    private readonly github: GithubApiService,
  ) {}

  // ---- low-level git exec (mirrors the host's private git() helper) -------------------------------

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

  private requireRepo(): {
    root: string;
    branch: string;
    upstream: string;
    baseRef: string;
    gitUrl: string;
  } {
    if (!this.repo) {
      throw new Error(
        'No clone yet — call ensureClone(...) before any git op.',
      );
    }
    return this.repo;
  }

  /** The clone root — every engine turn's cwd and every git op runs here (the single checkout). */
  root(): string {
    return this.requireRepo().root;
  }

  /** The git auth env for one authenticated op against this clone's origin — token resolved JUST NOW
   * (so a GitHub-App impl mints a fresh short-lived token per call). TOLERANT of a missing credential:
   * a PUBLIC repo resolves no token, so fetch/clone carry no auth header (returns {}); a private op then
   * fails at git with a legible auth error rather than here. */
  private async authEnv(): Promise<Record<string, string>> {
    const cred = await this.credentials.resolve().catch(() => undefined);
    return gitAuthEnv(this.requireRepo().gitUrl, cred?.token);
  }

  /** The remote-op identity guard: the clone's origin must still BE the configured `gitUrl`. By
   * construction it is (we cloned it), but a drifted origin must never be pushed to with the token. */
  private async originGuard(): Promise<string | undefined> {
    const { root, gitUrl } = this.requireRepo();
    const origin = await this.git(
      ['remote', 'get-url', 'origin'],
      root,
    ).catch(() => '');
    if (!origin) return `This clone has no origin remote (expected ${gitUrl}).`;
    if (!sameGitUrl(origin, gitUrl)) {
      return `This clone's origin (${origin}) isn't the configured repo (${gitUrl}) — refusing to push.`;
    }
    return undefined;
  }

  // ---- clone lifecycle ---------------------------------------------------------------------------

  /**
   * The fresh clone the whole workstation is built around: clone `gitUrl` into `workspaceRoot` (idempotent
   * — skips when `.git` already exists), then check out the workstation BRANCH directly:
   *  - if `branch` already exists on origin → fetch it and check it out tracking `origin/<branch>`;
   *  - else create it from `baseRef` (fetch `baseRef`, `git checkout -b <branch> origin/<baseRef>`) and
   *    `git push -u origin <branch>` so the team converges on it.
   * Records `upstream` + `baseRef` durably in git config (recovered on a restart). Populates submodules.
   * Returns the cloned repo root.
   *
   * `branch`/`baseRef`/`upstream` default to `baseBranch` when unspecified (a base-branch workstation, or a
   * dev/standalone boot), so the single-arg legacy entry still produces a working checkout.
   */
  async ensureClone(
    workspaceRoot: string,
    gitUrl: string,
    baseBranch: string,
    opts: { branch?: string; baseRef?: string; upstream?: string } = {},
  ): Promise<string> {
    const branch = opts.branch?.trim() || baseBranch;
    const baseRef = opts.baseRef?.trim() || baseBranch;
    const upstream = opts.upstream?.trim() || baseBranch;

    if (!(await exists(join(workspaceRoot, '.git')))) {
      const parent = join(workspaceRoot, '..');
      await mkdir(parent, { recursive: true });
      // Resolve the credential, but TOLERATE its absence — a PUBLIC repo needs no token, so a
      // credential-resolution failure (host has no PAT for the project, or the cred channel refused)
      // must not block a public clone. `gitAuthEnv` already returns {} for an empty/undefined token, so
      // a no-token clone simply carries no auth header. A genuinely PRIVATE repo then fails at the clone
      // itself with git's own "Authentication failed", which is the correct, legible error.
      const cred = await this.credentials.resolve().catch((err) => {
        this.logger.warn(
          `no git credential resolved (${err instanceof Error ? err.message : String(err)}) — ` +
            `attempting an UNAUTHENTICATED clone (works for a public repo).`,
        );
        return undefined;
      });
      const auth = gitAuthEnv(gitUrl, cred?.token);
      this.logger.log(`cloning ${gitUrl} → ${workspaceRoot} (branch ${branch})`);
      // Clone WITHOUT a --branch pin: the workstation branch may not exist yet, so we clone the repo and
      // then realize the branch ourselves below. (`--no-checkout` would leave an empty tree; a plain clone
      // lands on the remote HEAD, which we immediately replace with the workstation branch.)
      await this.git(['clone', gitUrl, workspaceRoot], parent, auth);
      await this.checkoutWorkstationBranch(workspaceRoot, branch, baseRef, auth);
      // Submodules must be populated before any session builds (a fresh checkout gets empty submodule
      // dirs → TS2307 on workspace packages). Authenticated (private submodules) + recursive.
      await this.git(
        ['submodule', 'update', '--init', '--recursive'],
        workspaceRoot,
        auth,
      ).catch((err) =>
        this.logger.error(
          `submodule init failed in ${workspaceRoot} — workspace packages may be unresolved: ${err}`,
        ),
      );
    }
    const root = await realpath(workspaceRoot);
    const origin = await this.git(['remote', 'get-url', 'origin'], root).catch(
      () => gitUrl,
    );
    this.repo = { root, branch, upstream, baseRef, gitUrl: origin || gitUrl };
    // Record the durable association on the branch (mirrors the host's per-branch config) so a restarted
    // daemon over the SAME clone recovers the upstream/base even if the env drifts.
    await this.git(
      ['config', `branch.${branch}.${UPSTREAM_CONFIG_KEY}`, upstream],
      root,
    ).catch(() => {});
    await this.git(
      ['config', `branch.${branch}.${BASE_CONFIG_KEY}`, baseRef],
      root,
    ).catch(() => {});
    // Author identity for this checkout (best-effort) so the daemon's own merge commits + the engines are
    // attributed to the credential rather than the host git config.
    const cred = await this.credentials.resolve().catch(() => ({
      token: '',
      authorName: 'Agent',
      authorEmail: 'agent@agents.noreply',
    }));
    await this.setIdentity(root, cred);
    this.logger.log(
      `workstation ready at ${root} on branch ${branch} (upstream ${upstream})`,
    );
    return root;
  }

  /**
   * Realize the workstation branch in a fresh clone: check it out tracking `origin/<branch>` when it
   * already exists on origin, else create it from `origin/<baseRef>` and push it with `-u`. Runs against
   * the clone root BEFORE `this.repo` is set (so it takes its cwd explicitly).
   */
  private async checkoutWorkstationBranch(
    root: string,
    branch: string,
    baseRef: string,
    auth: Record<string, string>,
  ): Promise<void> {
    // Does the branch already exist on origin?
    const onOrigin = await this.git(
      ['ls-remote', '--heads', 'origin', branch],
      root,
      auth,
    ).then(
      (out) => out.trim().length > 0,
      () => false,
    );

    if (onOrigin) {
      await this.git(['fetch', 'origin', branch], root, auth);
      // Track origin/<branch>. `checkout -B` is idempotent whether or not a local <branch> exists from the
      // clone's default checkout.
      await this.git(
        ['checkout', '-B', branch, '--track', `origin/${branch}`],
        root,
      );
      this.logger.log(`checked out existing origin branch ${branch}`);
      return;
    }

    // Branch is new: cut it from the base ref and push it up so the team converges on it.
    await this.git(['fetch', 'origin', baseRef], root, auth).catch((err) =>
      this.logger.warn(
        `couldn't fetch base ref ${baseRef} from origin — cutting from local clone HEAD: ${err}`,
      ),
    );
    const startPoint = await this.git(
      ['rev-parse', '--verify', '--quiet', `origin/${baseRef}`],
      root,
    ).then(
      (sha) => sha || 'HEAD',
      () => 'HEAD',
    );
    await this.git(['checkout', '-B', branch, startPoint], root);
    await this.git(['push', '-u', 'origin', branch], root, auth).catch((err) =>
      this.logger.warn(
        `couldn't push new branch ${branch} to origin (will retry on publish): ${err}`,
      ),
    );
    this.logger.log(`created branch ${branch} from ${baseRef} and pushed it`);
  }

  // ---- clone-readiness gate ----------------------------------------------------------------------
  //
  // The boot clone (`DaemonBootstrapService`) runs asynchronously after the DI graph is up. The readiness
  // marker must not be written — and a turn must not run — until that clone has completed. These three
  // methods coordinate that: `expectClone()` arms the gate the moment the bootstrapper knows a clone is
  // coming, `markCloned`/`markCloneFailed` settle it, and `whenCloned()` is what readiness + the turn path
  // await. With NO clone expected (a dev/standalone daemon whose repo is already present, or a fixture),
  // the gate resolves immediately.

  /** Arm the clone gate — called by `DaemonBootstrapService` before it starts the boot clone, so any
   * early `whenCloned()` awaits the in-flight clone rather than resolving prematurely. Idempotent. */
  expectClone(): void {
    if (this.cloneGate) return;
    this.cloneGate = new Promise<void>((resolve, reject) => {
      this.resolveCloneGate = resolve;
      this.rejectCloneGate = reject;
    });
  }

  /** Settle the clone gate as successful (boot clone finished). No-op if not armed. */
  markCloned(): void {
    this.resolveCloneGate?.();
  }

  /** Settle the clone gate as failed (boot clone threw) — `whenCloned()` then rejects, so readiness
   * signals WITHOUT a clone and a turn fails loudly instead of running against a missing repo. */
  markCloneFailed(err: Error): void {
    this.rejectCloneGate?.(err);
  }

  /** Await the boot clone. Resolves immediately when no clone is expected (gate never armed); otherwise
   * settles when `markCloned`/`markCloneFailed` is called. The turn path + readiness gate await this. */
  async whenCloned(): Promise<void> {
    if (this.cloneGate) await this.cloneGate;
  }

  /** Set the checkout's author identity from the credential (best-effort — attribution must never fail an
   * op). Repo-local so it covers every engine (SDK, codex subprocess) + this service's own merge commits. */
  private async setIdentity(
    root: string,
    cred: ResolvedGitCredential,
  ): Promise<void> {
    try {
      await this.git(['config', 'user.name', cred.authorName], root);
      await this.git(['config', 'user.email', cred.authorEmail], root);
    } catch (err) {
      this.logger.warn(`could not set git identity at ${root}: ${err}`);
    }
  }

  // ---- the workstation's upstream (refresh-from / PR-into target) ---------------------------------

  /** The branch this workstation lives on. */
  branch(): string {
    return this.requireRepo().branch;
  }

  /** The ref the workstation branch refreshes-from / PRs into — the durable config value, falling back to
   * the env-derived upstream recorded at clone time. */
  private async upstream(): Promise<string> {
    const { root, branch, upstream } = this.requireRepo();
    const recorded = await this.git(
      ['config', '--get', `branch.${branch}.${UPSTREAM_CONFIG_KEY}`],
      root,
    ).then(
      (v) => v || undefined,
      () => undefined,
    );
    return recorded ?? upstream;
  }

  // ---- merge state / refresh ----------------------------------------------------------------------

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

  private async refuseMidMerge(checkout: string): Promise<void> {
    if (await this.mergeInProgress(checkout)) {
      throw new Error(
        'A merge is already in progress in this checkout — resolve and commit it first.',
      );
    }
  }

  /** Read-only: whether a merge is in progress in the workstation checkout, and the conflicted paths. */
  async mergeState(): Promise<{ inProgress: boolean; files: string[] }> {
    if (!this.repo) return { inProgress: false, files: [] };
    const { root } = this.repo;
    const inProgress = await this.mergeInProgress(root);
    return {
      inProgress,
      files: inProgress ? await this.conflictedFiles(root) : [],
    };
  }

  /**
   * Bring the workstation branch up to date with its UPSTREAM: fetch `origin/<upstream>` and merge it into
   * the checkout. A dirty tree (git would refuse), a fetch miss, or a conflict are structured no-ops
   * (`refreshed:false` + detail/conflicted), never throws — same shape as the host. The conflict is left
   * IN PROGRESS for the session's next turn to resolve.
   */
  async refreshFromBase(): Promise<DaemonBaseRefreshResult> {
    const { root } = this.requireRepo();
    await this.refuseMidMerge(root);
    const upstream = await this.upstream();
    const dirty = !!(
      await this.git(
        ['status', '--porcelain', '--untracked-files=no'],
        root,
      ).catch(() => '')
    ).trim();
    if (dirty) {
      return {
        refreshed: false,
        dirty: true,
        baseBranch: upstream,
        detail: `the checkout has uncommitted changes — commit them, then refresh against ${upstream}`,
      };
    }
    try {
      await this.git(['fetch', 'origin', upstream], root, await this.authEnv());
    } catch (err) {
      return {
        refreshed: false,
        baseBranch: upstream,
        detail: `couldn't fetch ${upstream} from origin: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      await this.git(['merge', '--no-edit', `origin/${upstream}`], root);
    } catch (err) {
      if (await this.mergeInProgress(root)) {
        return {
          refreshed: false,
          conflicted: true,
          baseBranch: upstream,
          files: await this.conflictedFiles(root),
        };
      }
      throw err;
    }
    return { refreshed: true, baseBranch: upstream };
  }

  // ---- review range / owner diff ------------------------------------------------------------------

  /** The git range isolating the workstation's contribution against a ref: changed files in
   * `<sinceRef>...<branch>`. */
  async ownerDiff(
    sinceRef: string,
  ): Promise<{ range: string; files: string[] }> {
    const { root, branch } = this.requireRepo();
    const range = `${sinceRef}...${branch}`;
    const out = await this.git(['diff', '--name-only', range], root).catch(
      () => '',
    );
    const files = out
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    return { range, files };
  }

  /**
   * The review diff-scope for the workstation — the in-sandbox counterpart to the host
   * `ReviewPipelineService.ticketRange`. The durable cut point is the MERGE-BASE of the workstation branch
   * against its upstream (`merge-base(<branch>, <upstream>)`): everything the branch has added on top of
   * where it diverged from `dev`. Fetches the upstream first so the merge-base reflects origin. Returns the
   * range + changed files + the upstream name (for the review prompt). Empty `files` ⇒ nothing to review.
   */
  async reviewRange(): Promise<{
    range: string;
    files: string[];
    baseBranch: string;
  }> {
    const { root, branch } = this.requireRepo();
    const upstream = await this.upstream();
    await this.git(['fetch', 'origin', upstream], root, await this.authEnv()).catch(
      () => undefined,
    );
    // The cut point: where the branch diverged from the upstream. Fall back to origin/<upstream> (then
    // the upstream itself) if the merge-base can't be resolved.
    const base =
      (
        await this.git(
          ['merge-base', branch, `origin/${upstream}`],
          root,
        ).catch(() => '')
      ).trim() ||
      (
        await this.git(['rev-parse', `origin/${upstream}`], root).catch(
          () => '',
        )
      ).trim() ||
      upstream;
    const { range, files } = await this.ownerDiff(base);
    return { range, files, baseBranch: upstream };
  }

  // ---- publish / pull -----------------------------------------------------------------------------

  /**
   * Publish the workstation's COMMITTED work: push the branch to origin (behind the origin-identity guard).
   * The whole team commits to ONE branch and syncs via origin, so publish is a plain push — no local
   * shared-branch merge. A push REJECTED because origin advanced (a teammate pushed first) reports
   * `integrated:false` with a detail telling the session to `pull` (refresh from upstream isn't enough — a
   * teammate's commits on the SAME branch arrive via a fetch+merge of `origin/<branch>`); we DON'T silently
   * force-push. Uncommitted changes are reported as `dirty` (only commits are pushed).
   */
  async publish(): Promise<DaemonIntegrationResult> {
    const { root, branch } = this.requireRepo();
    await this.refuseMidMerge(root);
    const dirty = !!(
      await this.git(['status', '--porcelain'], root).catch(() => '')
    ).trim();
    const guard = await this.originGuard();
    if (guard) {
      return {
        integrated: false,
        sharedBranch: branch,
        dirty,
        remote: { pushed: false, detail: guard },
      };
    }
    try {
      await this.git(['push', 'origin', branch], root, await this.authEnv());
      return {
        integrated: true,
        sharedBranch: branch,
        dirty,
        remote: { pushed: true },
      };
    } catch (err) {
      return {
        integrated: false,
        sharedBranch: branch,
        dirty,
        remote: {
          pushed: false,
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /**
   * Pull teammates' work into the workstation checkout: fetch `origin/<branch>` and merge it (the whole
   * team commits to ONE branch, so a teammate's pushes arrive via the SAME branch on origin). Same conflict
   * shape as publish — a conflict is left IN PROGRESS for the session's next turn. `originFetched` reflects
   * whether the fetch succeeded.
   */
  async pull(): Promise<DaemonIntegrationResult> {
    const { root, branch } = this.requireRepo();
    await this.refuseMidMerge(root);
    const originFetched = await this.git(
      ['fetch', 'origin', branch],
      root,
      await this.authEnv(),
    ).then(
      () => true,
      () => false,
    );
    try {
      await this.git(['merge', '--no-edit', `origin/${branch}`], root);
    } catch (err) {
      if (await this.mergeInProgress(root)) {
        return {
          integrated: false,
          sharedBranch: branch,
          files: await this.conflictedFiles(root),
          originFetched,
        };
      }
      throw err;
    }
    return { integrated: true, sharedBranch: branch, originFetched };
  }

  // ---- pull request (GithubApiService, verbatim) -------------------------------------------------

  /** Open (or find) the workstation's PR: the workstation branch → its UPSTREAM (not the repo default),
   * draft by default. */
  async openPr(args: {
    title: string;
    body?: string;
    draft?: boolean;
  }): Promise<PullRequestResult> {
    const { gitUrl, branch } = this.requireRepo();
    const upstream = await this.upstream();
    const { owner, repo } = parseGithubRepo(gitUrl);
    const { token } = await this.credentials.resolve();
    return this.github.openPullRequest(token, {
      owner,
      repo,
      head: branch,
      base: upstream,
      title: args.title,
      body: args.body,
      draft: args.draft ?? true,
    });
  }

  /** Flip the workstation's draft PR to ready-for-review. */
  async markReady(prNumber: number): Promise<{ isDraft: boolean }> {
    const { owner, repo } = parseGithubRepo(this.requireRepo().gitUrl);
    const { token } = await this.credentials.resolve();
    return this.github.markReadyForReview(token, { owner, repo, number: prNumber });
  }

  /** Post a comment on the workstation's PR (advisory self-review findings ride this). Reuses
   * `GithubApiService.commentOnPullRequest` verbatim; the daemon resolves its own repo coordinates + token,
   * so the host never needs them on the containerized ship path. */
  async commentPr(prNumber: number, body: string): Promise<void> {
    const { owner, repo } = parseGithubRepo(this.requireRepo().gitUrl);
    const { token } = await this.credentials.resolve();
    await this.github.commentOnPullRequest(token, {
      owner,
      repo,
      number: prNumber,
      body,
    });
  }

  // ---- design artifact (interim human-gate) ------------------------------------------------------

  /**
   * Write a design artifact (a base64-encoded zip the host sends over the git RPC) into the workstation
   * checkout's `design/` — the in-sandbox counterpart to the host pipeline's `attachDesign`. Writes to the
   * single checkout root (the engine sees it directly — there's no separate worktree). The base64 transfer
   * is the heaviest RPC payload but acceptable for v1. Returns a structured ok/message (never throws on an
   * unzip failure — the caller relays the message).
   */
  async attachDesign(
    artifactBase64: string,
  ): Promise<{ ok: boolean; message: string }> {
    const { root } = this.requireRepo();
    const designDir = join(root, 'design');
    let tmp: string | undefined;
    try {
      tmp = await mkdtemp(join(tmpdir(), 'daemon-design-'));
      const zipPath = join(tmp, 'design.zip');
      await writeFile(zipPath, Buffer.from(artifactBase64, 'base64'));
      await mkdir(designDir, { recursive: true });
      await execFileAsync('unzip', ['-o', zipPath, '-d', designDir]);
      return { ok: true, message: `design attached to ${designDir}` };
    } catch (err) {
      return {
        ok: false,
        message: `couldn't unzip the design artifact into the sandbox: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---- reference clones (read-only, for investigate) ---------------------------------------------

  /**
   * A READ-ONLY shallow clone of ANOTHER repo so a session can read it without it being the workstation's
   * main project. Lives under `<clone>/.refs/<slug>` (in-sandbox path the engine reads). Kept current on
   * each call. SIMPLIFIED from the host: no project registry / per-tenant `_refs` path / token naming — the
   * daemon resolves the credential the same way as its main repo (the env/Redis token), which works for
   * repos the token can see. Returns the in-sandbox path.
   */
  async ensureReferenceClone(target: {
    gitUrl: string;
  }): Promise<{ path: string; gitUrl: string }> {
    const { gitUrl } = target;
    const refsDir = join(this.requireRepo().root, '.refs');
    const slug = slugify(
      gitUrl.replace(/\.git$/, '').split('/').slice(-2).join('-'),
    );
    const root = join(refsDir, slug);
    const { token } = await this.credentials.resolve();
    const auth = gitAuthEnv(gitUrl, token);
    if (!(await exists(join(root, '.git')))) {
      await mkdir(refsDir, { recursive: true });
      this.logger.log(`reference clone ${gitUrl} → ${root}`);
      await this.git(['clone', '--depth', '1', gitUrl, root], refsDir, auth);
    } else {
      const branch = await this.git(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        root,
      ).catch(() => 'HEAD');
      await this.git(
        ['fetch', '--depth', '1', 'origin', branch],
        root,
        auth,
      ).catch(() => {});
      await this.git(['reset', '--hard', `origin/${branch}`], root).catch(
        () => {},
      );
    }
    return { path: await realpath(root), gitUrl };
  }

  /**
   * A quick at-a-glance orientation (top level + README head) for an in-sandbox reference-clone path — the
   * in-sandbox counterpart to the host `WorkspaceService.referenceOrientation`. Same shape/limits so the
   * chat-side peek reads identically whether the clone is host- or sandbox-resident.
   */
  async referenceOrientation(path: string): Promise<string> {
    const tree = await this.git(['ls-tree', '--name-only', 'HEAD'], path).catch(
      () => '',
    );
    const top = tree.split('\n').filter(Boolean).slice(0, 40).join(', ');
    let readme = '';
    for (const name of ['README.md', 'README.MD', 'readme.md', 'README']) {
      const r = await readFile(join(path, name), 'utf8').catch(() => undefined);
      if (r) {
        readme = r.slice(0, 1200);
        break;
      }
    }
    return [
      `Top level: ${top || '(empty)'}`,
      readme ? `README (head):\n${readme}` : '(no README found)',
    ].join('\n\n');
  }
}

/** Turn a name into a short, dir-safe slug (reference-clone dir names). */
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
