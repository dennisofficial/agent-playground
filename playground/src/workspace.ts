import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './engines/guard.js';
import type { Job } from './jobs.js';

const execFileAsync = promisify(execFile);

/**
 * Per-worker isolation, Stage 0: each EXECUTE job gets its own git worktree + branch, so an employee
 * can run several workers at once on different branches without them sharing (and clobbering) one
 * directory. The Workspace is the DURABLE half of the worker model — the branch and its commits
 * survive the disposable compute that produced them (today an in-process run; later a container). It
 * also survives the plan→approve→execute gate and any awaiting→resume hop within a job.
 *
 * NOT isolated here: ports, processes, services (a worker's dev server / Postgres / Redis still share
 * the host). That needs container/network isolation — the deferred next stage. Also note a fresh
 * worktree has NO node_modules / .data (both gitignored, not checked out): a worker can edit, commit,
 * push, and open PRs, but running the build/test suite needs a `pnpm install` (or a shared store) in
 * the worktree first. Wiring that in is follow-up; this layer gives filesystem + branch isolation.
 */

export interface Workspace {
  /** The job this workspace was created for. */
  jobId: string;
  /** The git branch checked out in this worktree — the durable artifact (outlives the worktree dir). */
  branch: string;
  /** The worker's working directory: the worktree's checkout root, plus the same subdir the app runs
   * from in the main checkout (this is a monorepo — the app lives under `playground/`). Engine `cwd`. */
  path: string;
  /** The worktree's checkout root (a full-repo checkout). What `git worktree remove` operates on. */
  checkout: string;
  /** The commit this branch was cut from (audit trail / PR base). */
  baseRef: string;
}

async function git(args: string[], cwd = ROOT): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/**
 * The repo layout, resolved once. A worktree is a FULL-repo checkout, so when the app runs from a
 * subdirectory (this monorepo runs from `playground/`), the worker must operate at the same subpath
 * inside the worktree — not at the worktree's checkout root. `.worktrees/` sits at the repo root
 * (gitignored there) so it never lands inside any checkout.
 */
let layoutPromise: Promise<{ subdir: string; worktreesDir: string }> | undefined;
function getLayout() {
  return (layoutPromise ??= (async () => {
    const repoRoot = await git(['rev-parse', '--show-toplevel']);
    return { subdir: relative(repoRoot, ROOT), worktreesDir: join(repoRoot, '.worktrees') };
  })());
}

/**
 * A short, branch-safe slug for the job. Execute jobs are seeded with a verbose "Execute this APPROVED
 * plan…" task that ends with "(Originating request: <X>)" (see executeApprovedPlan); prefer that
 * original request so branches read like `agent/alex/job-005-fix-checkout-crash`, not the boilerplate.
 */
function slugify(task: string): string {
  const original = task.match(/\(Originating request:\s*([\s\S]+?)\)\s*$/);
  return (
    (original ? original[1] : task)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'task'
  );
}

/**
 * Create an isolated worktree + branch for an execute job, cut from the current trunk tip (HEAD).
 * Returns the handle whose `path` becomes the engine's cwd. (Cutting from `origin/<trunk>` instead of
 * local HEAD is a later refinement — for a local repo HEAD is the trunk tip.)
 */
export async function acquireWorkspace(job: Job): Promise<Workspace> {
  const { subdir, worktreesDir } = await getLayout();
  const branch = `agent/${job.ownerBot}/${job.id}-${slugify(job.task)}`;
  const checkout = join(worktreesDir, job.id);
  await mkdir(worktreesDir, { recursive: true });
  const baseRef = await git(['rev-parse', 'HEAD']);
  await git(['worktree', 'add', '-b', branch, checkout, baseRef]);
  return {
    jobId: job.id,
    branch,
    path: subdir ? join(checkout, subdir) : checkout,
    checkout,
    baseRef,
  };
}

/**
 * Tear down a worktree directory once a job reaches a terminal state. Keeps the branch by default —
 * it holds the commits / the future PR; only the working directory is disposable. `--force` because
 * the worker may have left untracked build artifacts we still want gone.
 */
export async function releaseWorkspace(
  ws: Workspace,
  { keepBranch = true }: { keepBranch?: boolean } = {},
): Promise<void> {
  await git(['worktree', 'remove', '--force', ws.checkout]).catch(() => {});
  if (!keepBranch) await git(['branch', '-D', ws.branch]).catch(() => {});
}

/**
 * Startup cleanup. Worktrees are real filesystem state that outlives the IN-MEMORY job registry, so a
 * crash leaves orphans (and a dangling branch can't be re-created on the next run). Prune git's stale
 * worktree metadata, then remove any leftover dir under `.worktrees`. Safe to remove ALL of them today
 * because no job survives a restart; when the registry is persisted, this must spare still-live jobs.
 */
export async function reconcileWorkspaces(): Promise<void> {
  const { worktreesDir } = await getLayout();
  await git(['worktree', 'prune']).catch(() => {});
  const entries = await readdir(worktreesDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(worktreesDir, e.name);
    await git(['worktree', 'remove', '--force', p]).catch(() => {});
    await rm(p, { recursive: true, force: true }).catch(() => {});
  }
}
