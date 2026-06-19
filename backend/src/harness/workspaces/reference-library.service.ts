import { EnvService } from '@core/config/env/env.service';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitAuthEnv, parseGithubRepo, sameGitUrl } from '../projects/git-auth';
import { GithubTokenStore } from '../projects/github-token-store';
import { ProjectStore } from '../projects/project-store';

const execFileAsync = promisify(execFile);
const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Filesystem-safe slug for a team id or `owner-repo` (the on-disk dir + the `/refs/<slug>` mount). */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'ref'
  );
}

/** Where the team's reference library is bind-mounted (read-only) inside every sandbox. */
export const REFS_MOUNT = '/refs';
/** Background warm cadence — how often `refreshAll` re-fetches every cloned reference. */
const REFRESH_INTERVAL_MS = 15 * 60_000;
/** GC: drop a reference clone not referenced in this long (best-effort). */
const PRUNE_AGE_MS = 14 * 24 * 60 * 60_000;

/** The outcome of resolving + materializing one reference. */
export type EnsureReferenceResult =
  | { ok: true; slug: string; mountPath: string; gitUrl: string }
  | {
      ok: false;
      reason: 'not-registered' | 'catalog-unavailable' | 'clone-failed';
      detail?: string;
    };

interface ResolvedTarget {
  slug: string;
  gitUrl: string;
  tokenName?: string | null;
  /** The branch to track (catalog `defaultBranch`), or 'HEAD' for a raw URL's default branch. */
  ref: string;
}

/**
 * The host-maintained READ-ONLY reference library — one shallow clone per registered project, under
 * `<REFS_ROOT>/<team>/<slug>`, bind-mounted read-only into every sandbox at `/refs/<slug>` by
 * `ContainerManagerService`. It recreates the "all my projects sit in ~/Developer, always readable"
 * model for the agents: deduped to ONE copy per project (shared across all of a team's
 * sandboxes/branches) and credentialed correctly.
 *
 * Why it lives on the HOST (not the daemon): cloning a DIFFERENT project needs THAT project's own
 * token via `GithubTokenStore.resolve`, but the daemon only ever holds the workstation's single
 * token. The host also owns the directory the sandboxes mount. It mirrors `SkillLoaderService`'s
 * host-git pattern (execFile git + per-dir serialization), and is harness-only (it owns a background
 * timer), so it lives in `WorkspacesModule`, not the slim `ProjectsModule`.
 */
@Injectable()
export class ReferenceLibraryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ReferenceLibraryService.name);
  /** Per-clone-dir serialization: `ensureReference` and the background refresher share ONE lock per
   * dir so concurrent git ops never hit a shared working tree at once (the `SkillLoaderService`
   * pattern, as a chained queue — callers may do different things, so serialize rather than dedup). */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** When each clone dir was last referenced — drives GC. Seeded from dir mtime so age survives a
   * restart (the in-memory map is empty after boot). */
  private readonly lastUsedAt = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly env: EnvService,
    private readonly projects: ProjectStore,
    private readonly tokens: GithubTokenStore,
  ) {}

  // ── lifecycle: background warm + GC sweep ────────────────────────────────────────────────────────
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.refreshAllTeams().catch((err) =>
        this.logger.warn(`reference refresh sweep failed: ${msg(err)}`),
      );
    }, REFRESH_INTERVAL_MS);
    // Don't keep the process alive just for the sweep.
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── paths ────────────────────────────────────────────────────────────────────────────────────────
  private root(): string {
    return (
      this.env.get('REFS_ROOT') ?? join(homedir(), '.agent-playground', 'refs')
    );
  }
  private teamDir(team: string): string {
    return join(this.root(), slugify(team));
  }
  private cloneDir(team: string, slug: string): string {
    return join(this.teamDir(team), slug);
  }

  /** The HOST path to bind-mount read-only into a team's sandbox at `/refs`. Ensures it exists first
   * (Docker would otherwise auto-create the bind source as root). Called by `ContainerManagerService`
   * before container create. */
  async ensureTeamMountSource(team: string): Promise<string> {
    const dir = this.teamDir(team);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  // ── public: ensure a reference is present + fresh (fetch-on-reference) ───────────────────────────
  async ensureReference(
    team: string,
    target: { projectId?: string; gitUrl?: string },
  ): Promise<EnsureReferenceResult> {
    let resolved: ResolvedTarget | null;
    try {
      resolved = await this.resolveTarget(team, target);
    } catch (err) {
      // A ProjectStore lookup failed (DB hiccup) — distinct from a genuine miss.
      return { ok: false, reason: 'catalog-unavailable', detail: msg(err) };
    }
    if (!resolved) return { ok: false, reason: 'not-registered' };

    const dir = this.cloneDir(team, resolved.slug);
    try {
      await this.withLock(dir, () => this.syncOnce(team, dir, resolved!));
    } catch (err) {
      return { ok: false, reason: 'clone-failed', detail: msg(err) };
    }
    this.lastUsedAt.set(dir, Date.now());
    return {
      ok: true,
      slug: resolved.slug,
      mountPath: `${REFS_MOUNT}/${resolved.slug}`,
      gitUrl: resolved.gitUrl,
    };
  }

  /** Top-level + README head for a reference clone — read straight from the host clone (replaces the
   * daemon's `referenceOrientation` RPC). Undefined when the clone isn't present. */
  async orientation(team: string, slug: string): Promise<string | undefined> {
    const dir = this.cloneDir(team, slug);
    if (!(await exists(join(dir, '.git')))) return undefined;
    const tree = await this.git(['ls-tree', '--name-only', 'HEAD'], dir).catch(
      () => '',
    );
    const top = tree.split('\n').filter(Boolean).slice(0, 40).join(', ');
    let readme = '';
    for (const name of ['README.md', 'README.MD', 'readme.md', 'README']) {
      const r = await readFile(join(dir, name), 'utf8').catch(() => undefined);
      if (r) {
        readme = r.slice(0, 1200);
        break;
      }
    }
    return [
      `Top level: ${top || '(empty)'}`,
      ...(readme ? ['', 'README (head):', readme] : []),
    ].join('\n');
  }

  // ── background warm + GC ─────────────────────────────────────────────────────────────────────────
  private async refreshAllTeams(): Promise<void> {
    const all = await this.projects.listAll().catch(() => []);
    const teams = [...new Set(all.map((p) => p.teamId))];
    for (const team of teams) await this.refreshAll(team);
  }

  /** Warm (re-fetch) every cloned catalog project for a team and prune stale clones. Lazy add (via
   * `ensureReference`) + this background warm = the hybrid population model. */
  async refreshAll(team: string): Promise<void> {
    const dir = this.teamDir(team);
    if (!(await exists(dir))) return;
    const catalog = await this.projects.list(team).catch(() => undefined);
    if (!catalog) return; // catalog unavailable this round — skip, don't prune blind
    const byId = new Map(catalog.map((p) => [slugify(p.projectId), p]));
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const slug = e.name;
      const cloneDir = join(dir, slug);
      const used =
        this.lastUsedAt.get(cloneDir) ??
        (await stat(cloneDir)
          .then((s) => s.mtimeMs)
          .catch(() => Date.now()));
      this.lastUsedAt.set(cloneDir, used);
      if (Date.now() - used > PRUNE_AGE_MS) {
        await this.withLock(cloneDir, () =>
          rm(cloneDir, { recursive: true, force: true }),
        );
        this.lastUsedAt.delete(cloneDir);
        continue;
      }
      const proj = byId.get(slug);
      if (!proj) continue; // url-only ref / deleted project — not warmed; pruned when stale above
      await this.withLock(cloneDir, () =>
        this.syncOnce(team, cloneDir, {
          slug,
          gitUrl: proj.gitUrl,
          tokenName: proj.tokenName,
          ref: proj.defaultBranch,
        }).catch((err) =>
          this.logger.warn(`reference refresh ${slug} failed: ${msg(err)}`),
        ),
      );
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────
  private async resolveTarget(
    team: string,
    target: { projectId?: string; gitUrl?: string },
  ): Promise<ResolvedTarget | null> {
    if (target.projectId) {
      const rec = await this.projects.get(team, target.projectId);
      if (!rec) return null;
      return {
        slug: slugify(rec.projectId),
        gitUrl: rec.gitUrl,
        tokenName: rec.tokenName,
        ref: rec.defaultBranch,
      };
    }
    const gitUrl = (target.gitUrl ?? '').trim();
    const { owner, repo } = parseGithubRepo(gitUrl); // throws on a non-GitHub URL
    return {
      slug: slugify(`${owner}-${repo}`),
      gitUrl,
      tokenName: undefined, // default token
      ref: 'HEAD',
    };
  }

  /** Clone (if absent), re-clone on origin drift, else fetch + hard-reset. Runs under the per-dir lock. */
  private async syncOnce(
    team: string,
    dir: string,
    t: ResolvedTarget,
  ): Promise<void> {
    const token = (await this.tokens.resolve(team, t.tokenName))?.token;
    const auth = gitAuthEnv(t.gitUrl, token);
    const parent = this.teamDir(team);
    const branchArgs = t.ref && t.ref !== 'HEAD' ? ['--branch', t.ref] : [];
    const clone = async (): Promise<void> => {
      await mkdir(parent, { recursive: true });
      await this.git(
        ['clone', '--depth', '1', ...branchArgs, t.gitUrl, dir],
        parent,
        auth,
      );
    };
    if (!(await exists(join(dir, '.git')))) {
      await clone();
      return;
    }
    // Origin-identity guard: ProjectStore.update can change a project's git_url, so a stable slug must
    // never silently keep serving the old repo. Re-clone on drift.
    const origin = await this.git(['remote', 'get-url', 'origin'], dir).catch(
      () => '',
    );
    if (!sameGitUrl(origin, t.gitUrl)) {
      this.logger.warn(
        `reference ${dir}: origin drifted (${origin || 'unknown'} → ${t.gitUrl}); re-cloning`,
      );
      await rm(dir, { recursive: true, force: true });
      await clone();
      return;
    }
    // Fetch-on-reference: keep it current.
    const ref = t.ref && t.ref !== 'HEAD' ? t.ref : 'HEAD';
    await this.git(['fetch', '--depth', '1', 'origin', ref], dir, auth);
    await this.git(['reset', '--hard', 'FETCH_HEAD'], dir);
  }

  /** Serialize `fn` per `key` (chained queue): it runs after the previous op on that key settles,
   * success or failure. The stored promise swallows errors so one failure doesn't break the chain. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
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
}
