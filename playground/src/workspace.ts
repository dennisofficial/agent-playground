import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './engines/guard.js';
import { listJobs, type Job } from './jobs.js';
import { logBus } from './logbus.js';

const execFileAsync = promisify(execFile);

/**
 * Per-worker git isolation. Two flavours:
 *
 * - **Per-job worktrees** (Stage 0) — a non-ticket EXECUTE job (the human `/approve` path,
 *   `executeApprovedPlan`) gets a throwaway `.worktrees/jobs/<jobId>` checkout, released when the job
 *   ends. Job-scoped; vanishes with the job.
 *
 * - **Ticket worktrees** — the team-of-coworkers model. A ticket has ONE shared integration branch
 *   `ticket/<TKT>` (the convergence point; never checked out, so it can be pushed to). Each discipline
 *   gets its OWN worktree on its OWN branch `agent/<owner>/<TKT>` cut from the shared branch, under
 *   `.worktrees/tickets/<TKT>-<owner>`. Disciplines collaborate like coworkers: "push" = fast-forward
 *   `ticket/<TKT>` to their work (`git push . HEAD:ticket/<TKT>`), "pull" = `git merge ticket/<TKT>`.
 *   The worktree OUTLIVES individual jobs (it's the discipline's desk for the ticket) and is re-adopted
 *   on restart from `git worktree list` — git is the durable store.
 *
 * NOT isolated here: ports/processes/services (still share the host — needs containers). A fresh
 * worktree has no node_modules/.data (gitignored): editing/commit/push works, running the test suite
 * needs a `pnpm install` (or shared store) first — follow-up.
 */

export interface Workspace {
  /** The branch checked out in this worktree. */
  branch: string;
  /** The worker's working directory (checkout root + the monorepo subdir the app runs from). Engine cwd. */
  path: string;
  /** The worktree's checkout root (a full-repo checkout). What `git worktree remove` targets. */
  checkout: string;
  /** The commit/ref this branch was based on (audit; '' for a re-adopted worktree). */
  baseRef: string;
  /** Set for a per-job (non-ticket) worktree. */
  jobId?: string;
  /** Set for a ticket worktree: the ticket, its discipline owner, and the shared integration branch. */
  ticketId?: string;
  owner?: string;
  sharedBranch?: string;
}

async function git(args: string[], cwd = ROOT): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/**
 * Repo layout, resolved once. A worktree is a FULL-repo checkout, so when the app runs from a
 * subdirectory (this monorepo runs from `playground/`), the worker operates at the same subpath inside
 * the worktree. `.worktrees/` sits at the repo root (gitignored), split into `tickets/` (durable,
 * re-adopted) and `jobs/` (ephemeral, swept on restart).
 */
let layoutPromise: Promise<{ subdir: string; ticketsDir: string; jobsDir: string }> | undefined;
function getLayout() {
  return (layoutPromise ??= (async () => {
    const repoRoot = await git(['rev-parse', '--show-toplevel']);
    const worktreesDir = join(repoRoot, '.worktrees');
    return {
      subdir: relative(repoRoot, ROOT),
      ticketsDir: join(worktreesDir, 'tickets'),
      jobsDir: join(worktreesDir, 'jobs'),
    };
  })());
}

const withSubdir = (checkout: string, subdir: string) =>
  subdir ? join(checkout, subdir) : checkout;

/** Warn (don't block) if the checkout base has uncommitted tracked changes — worktrees branch from
 * committed HEAD by design, so uncommitted scratch on the main checkout simply won't appear in them. */
async function warnIfDirtyBase(): Promise<void> {
  const dirty = await git(['status', '--porcelain', '--untracked-files=no']).catch(() => '');
  if (dirty.trim())
    logBus.publish({
      kind: 'workspace',
      text:
        `uncommitted tracked changes on the main checkout won't appear in new worktrees ` +
        `(they branch from committed HEAD). Commit them first if a worker needs them.`,
    });
}

/** Turn text into a short, branch-safe slug. */
function slugify(task: string): string {
  return (
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'task'
  );
}

// ── Per-job worktrees (Stage 0; non-ticket execute jobs) ──────────────────────────────────────────

/** Create a throwaway worktree+branch for a non-ticket execute job, cut from trunk HEAD. */
export async function acquireWorkspace(job: Job): Promise<Workspace> {
  const { subdir, jobsDir } = await getLayout();
  await warnIfDirtyBase();
  const branch = `agent/${job.ownerBot}/${job.id}-${slugify(job.task)}`;
  const checkout = join(jobsDir, job.id);
  await mkdir(jobsDir, { recursive: true });
  const baseRef = await git(['rev-parse', 'HEAD']);
  await git(['worktree', 'add', '-b', branch, checkout, baseRef]);
  return { jobId: job.id, branch, path: withSubdir(checkout, subdir), checkout, baseRef };
}

/** Tear down a per-job worktree once its job is terminal; keep the branch by default. */
export async function releaseWorkspace(
  ws: Workspace,
  { keepBranch = true }: { keepBranch?: boolean } = {},
): Promise<void> {
  await git(['worktree', 'remove', '--force', ws.checkout]).catch(() => {});
  if (!keepBranch && ws.branch) await git(['branch', '-D', ws.branch]).catch(() => {});
}

// ── Ticket worktrees + shared-branch collaboration ────────────────────────────────────────────────

/** Live ticket worktrees, keyed `<ticketId>:<owner>`. The durable registry `fetch`/`adopt` query. */
const ticketWorkspaces = new Map<string, Workspace>();
const wsKey = (ticketId: string, owner: string) => `${ticketId}:${owner}`;
const sharedBranchFor = (ticketId: string) => `ticket/${ticketId}`;

// Per-ticket promise memoization so concurrent first-builders don't race to create the shared branch.
const ensuring = new Map<string, Promise<void>>();

/** Create the shared `ticket/<TKT>` integration branch from trunk HEAD if absent. Concurrency-safe
 * (serialized per ticket; "already exists" is treated as success). Never checked out. */
export function ensureTicketBranch(ticketId: string): Promise<void> {
  let p = ensuring.get(ticketId);
  if (!p) {
    p = (async () => {
      const shared = sharedBranchFor(ticketId);
      const baseRef = await git(['rev-parse', 'HEAD']);
      await git(['branch', shared, baseRef]).catch((e) => {
        if (!/already exists/i.test(String(e))) throw e; // racing first-builder won the create
      });
    })();
    ensuring.set(ticketId, p);
  }
  return p;
}

/** Get (idempotent) this discipline's worktree for a ticket: reuse if live, else create `agent/<owner>/<TKT>`
 * cut from the shared branch (re-attaching with no `-b` when reopening a previously-closed discipline). */
export async function acquireTicketWorkspace(ticketId: string, owner: string): Promise<Workspace> {
  const existing = ticketWorkspaces.get(wsKey(ticketId, owner));
  if (existing) return existing;
  const { subdir, ticketsDir } = await getLayout();
  await warnIfDirtyBase();
  await ensureTicketBranch(ticketId);
  const shared = sharedBranchFor(ticketId);
  const branch = `agent/${owner}/${ticketId}`;
  const checkout = join(ticketsDir, `${ticketId}-${owner}`);
  await mkdir(ticketsDir, { recursive: true });
  const baseRef = await git(['rev-parse', shared]);
  const branchExists = await git(['rev-parse', '--verify', '--quiet', branch])
    .then(() => true)
    .catch(() => false);
  if (branchExists) await git(['worktree', 'add', checkout, branch]);
  else await git(['worktree', 'add', '-b', branch, checkout, shared]);
  const ws: Workspace = {
    ticketId,
    owner,
    branch,
    sharedBranch: shared,
    path: withSubdir(checkout, subdir),
    checkout,
    baseRef,
  };
  ticketWorkspaces.set(wsKey(ticketId, owner), ws);
  return ws;
}

/**
 * Publish a discipline's work onto the shared `ticket/<TKT>` branch — the integration guarantee behind
 * "done = integrated". Fast-forward push first; if a teammate advanced the branch, pull (merge) then
 * push. On merge conflict, leave the conflicted merge IN PROGRESS in the worktree (so the worker's
 * resolve turn can fix it) and report which files conflicted.
 */
export async function publishToTicketBranch(
  ws: Workspace,
): Promise<{ integrated: boolean; files?: string[] }> {
  if (!ws.sharedBranch) return { integrated: true }; // non-ticket worktree — nothing to publish
  const shared = ws.sharedBranch;
  const tryPush = () =>
    git(['push', '.', `HEAD:${shared}`], ws.checkout).then(
      () => true,
      () => false,
    );
  if (await tryPush()) return { integrated: true };
  // Rejected (non-fast-forward) → pull teammates' work in, then push again.
  try {
    await git(['merge', '--no-edit', shared], ws.checkout);
  } catch {
    const files = await git(['diff', '--name-only', '--diff-filter=U'], ws.checkout)
      .then((s) => s.split('\n').filter(Boolean))
      .catch(() => [] as string[]);
    return { integrated: false, files };
  }
  return { integrated: await tryPush() };
}

/** Tear down a discipline's ticket worktree (e.g. its work is done); keep both branches by default. */
export async function closeTicketWorkspace(
  ticketId: string,
  owner: string,
  { keepBranch = true }: { keepBranch?: boolean } = {},
): Promise<void> {
  const ws = ticketWorkspaces.get(wsKey(ticketId, owner));
  ticketWorkspaces.delete(wsKey(ticketId, owner));
  if (ws) await git(['worktree', 'remove', '--force', ws.checkout]).catch(() => {});
  if (!keepBranch && ws?.branch) await git(['branch', '-D', ws.branch]).catch(() => {});
}

export function getTicketWorkspace(ticketId: string, owner: string): Workspace | undefined {
  return ticketWorkspaces.get(wsKey(ticketId, owner));
}

export function listTicketWorkspaces(owner?: string): Workspace[] {
  const all = [...ticketWorkspaces.values()];
  return owner ? all.filter((w) => w.owner === owner) : all;
}

/** How many workers are live on a ticket (optionally one discipline) — running or awaiting jobs. */
export function activeTicketWorkers(ticketId: string, owner?: string): number {
  return listJobs().filter(
    (j) =>
      j.ticketId === ticketId &&
      (!owner || j.ownerBot === owner) &&
      (j.status === 'running' || j.status === 'awaiting'),
  ).length;
}

// ── Startup re-adoption ───────────────────────────────────────────────────────────────────────────

/**
 * Rebuild the ticket-worktree registry from git on startup — worktrees + branches survive a restart
 * (git is the durable store) even though the in-memory job registry does not. Re-register every
 * `.worktrees/tickets/*` (a re-adopted workspace comes back with zero active workers; `execute_ticket`
 * re-attaches to it). Sweep orphaned `.worktrees/jobs/*` (their jobs vanished on restart). Replaces
 * Stage 0's wipe-everything `reconcileWorkspaces`.
 */
export async function adoptWorkspaces(): Promise<void> {
  const { ticketsDir, jobsDir, subdir } = await getLayout();
  await git(['worktree', 'prune']).catch(() => {});
  const out = await git(['worktree', 'list', '--porcelain']).catch(() => '');
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!wt) continue;
    if (wt.startsWith(ticketsDir + '/')) {
      const branch =
        lines
          .find((l) => l.startsWith('branch '))
          ?.slice('branch '.length)
          .replace('refs/heads/', '') ?? '';
      const m = branch.match(/^agent\/([^/]+)\/(.+)$/); // agent/<owner>/<TKT>
      if (!m) continue;
      const [, owner, ticketId] = m;
      ticketWorkspaces.set(wsKey(ticketId, owner), {
        ticketId,
        owner,
        branch,
        sharedBranch: sharedBranchFor(ticketId),
        path: withSubdir(wt, subdir),
        checkout: wt,
        baseRef: '',
      });
    } else if (wt.startsWith(jobsDir + '/')) {
      await git(['worktree', 'remove', '--force', wt]).catch(() => {});
      await rm(wt, { recursive: true, force: true }).catch(() => {});
    }
  }
}
