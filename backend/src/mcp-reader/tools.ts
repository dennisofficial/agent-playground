import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { JobEntity, JobSandboxEntity, MessageEntity, ThreadEntity } from '../app/persistence/entities';
import type { ThreadTerminalRecord } from '../app/persistence/entities/thread.entity';
import { resolveJailed } from './path-jail';
import {
  findSandboxDir,
  grepFiles,
  isValidSessionId,
  listSessionFiles,
  readRawLines,
  renderShow,
  resolveSessionFile,
} from './session-jsonl';

/** A file this reader will not slurp into a tool response whole (keeps a runaway `atlas_worktree_file` /
 *  `atlas_context_read` call from blowing up the MCP response). */
const MAX_FILE_BYTES = 2_000_000;
/** Tree-listing caps — a worktree or context dir can be huge; these bound one `tree` response. */
const MAX_TREE_ENTRIES = 2_000;
const MAX_TREE_DEPTH = 10;

export interface ToolRoots {
  agentHome: string;
  repos: string;
}

/** Per-call context threaded into every handler. `audit` is a mutable out-param the handler stamps
 *  `orgId` onto the moment it resolves the job, so the caller (main.ts) can audit the org even when the
 *  call later fails deeper in the handler. */
export interface ToolCtx {
  ds: DataSource;
  roots: ToolRoots;
  audit: { orgId?: string };
}

async function loadJob(ctx: ToolCtx, jobId: string): Promise<JobEntity> {
  const job = await ctx.ds.getRepository(JobEntity).findOne({ where: { id: jobId } });
  if (!job) throw new Error(`job ${jobId} not found`);
  ctx.audit.orgId = job.org_id;
  return job;
}

async function loadSandbox(ctx: ToolCtx, jobId: string): Promise<JobSandboxEntity> {
  const sandbox = await ctx.ds.getRepository(JobSandboxEntity).findOne({ where: { job_id: jobId } });
  if (!sandbox) throw new Error(`no sandbox found for job ${jobId}`);
  return sandbox;
}

function deriveFailureSummary(tr: ThreadTerminalRecord | null): string | null {
  if (!tr) return null;
  if (tr.summary) return tr.summary;
  if (tr.blocked) return `blocked(${tr.blocked.reason}): ${tr.blocked.detail}`;
  if (tr.failure) {
    return `failure(${tr.failure.kind}): ${tr.failure.failingStep ?? tr.failure.command ?? ''} exit=${tr.failure.exitCode ?? ''}`;
  }
  return null;
}

// ── atlas_job_overview ────────────────────────────────────────────────────────────────────────────────

async function jobOverview(ctx: ToolCtx, args: { jobId: string }): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const threads = await ctx.ds
    .getRepository(ThreadEntity)
    .find({ where: { job_id: job.id }, order: { ordinal: 'ASC' } });

  return {
    job: {
      id: job.id,
      status: job.status,
      activity: job.activity,
      halt: job.halt,
      buildPath: job.build_path,
      prUrl: job.pr_url,
      prNumber: job.pr_number,
      prState: job.pr_state,
      prMergeable: job.pr_mergeable,
      ciStatus: job.ci_status,
      featureBranch: job.feature_branch,
      currentBranch: job.current_branch,
      baseBranch: job.base_branch,
      title: job.title,
      pendingDecisions: job.pending_decisions,
      decisionRecordId: job.decision_record_id,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    },
    threads: threads.map((t) => ({
      id: t.id,
      kind: t.kind,
      ordinal: t.ordinal,
      brief: t.brief,
      status: t.status,
      condition: t.condition,
      parentThreadId: t.parent_thread_id,
      failureSummary: deriveFailureSummary(t.terminal_record),
    })),
  };
}

// ── atlas_thread_failure ──────────────────────────────────────────────────────────────────────────────

async function threadFailure(ctx: ToolCtx, args: { jobId: string; threadId?: string }): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const repo = ctx.ds.getRepository(ThreadEntity);
  const threads = args.threadId
    ? await repo.find({ where: { job_id: job.id, id: args.threadId } })
    : await repo.find({ where: { job_id: job.id }, order: { ordinal: 'ASC' } });
  const scoped = args.threadId ? threads : threads.filter((t) => t.terminal_record != null);

  return {
    threads: scoped.map((t) => ({
      id: t.id,
      kind: t.kind,
      condition: t.condition,
      status: t.status,
      terminalRecord: t.terminal_record,
    })),
  };
}

// ── atlas_job_transcript ──────────────────────────────────────────────────────────────────────────────

function mapMessageSource(stored: unknown, isAtlas: boolean): string {
  if (stored === 'system_operator') return 'system_operator';
  if (stored === 'system_shared') return 'system_shared';
  if (stored === 'system_event') return 'system_event';
  if (stored === 'system_notice') return 'system_notice';
  if (stored === 'system_reminder') return 'system_reminder';
  if (stored === 'untrusted') return 'untrusted';
  return isAtlas ? 'atlas' : 'operator';
}

interface JobTranscriptArgs {
  jobId: string;
  kind?: string | string[];
  source?: string;
  tail?: number;
  since?: string;
}

async function jobTranscript(ctx: ToolCtx, args: JobTranscriptArgs): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const rows = await ctx.ds
    .getRepository(MessageEntity)
    .find({ where: { job_id: job.id }, order: { created_at: 'ASC' } });

  const kinds = args.kind === undefined ? undefined : Array.isArray(args.kind) ? args.kind : [args.kind];
  const sinceDate = args.since ? new Date(args.since) : undefined;

  let mapped = rows
    .filter((m) => !kinds || kinds.includes(m.kind))
    .filter((m) => !sinceDate || m.created_at >= sinceDate)
    .map((m) => ({
      id: m.id,
      ts: m.ts,
      author: m.author,
      authorId: m.author_id,
      isAtlas: m.author_bot_id != null,
      source: mapMessageSource((m.meta as { source?: unknown } | null)?.source, m.author_bot_id != null),
      text: m.text,
      kind: m.kind,
      card: m.card,
      meta: m.meta,
      postedAt: m.created_at,
    }));

  if (args.source) mapped = mapped.filter((m) => m.source === args.source);
  if (args.tail && args.tail > 0) mapped = mapped.slice(-args.tail);

  return { messages: mapped };
}

// ── atlas_session_raw ─────────────────────────────────────────────────────────────────────────────────

interface SessionRawArgs {
  jobId: string;
  sessionId?: string;
  role?: 'user' | 'assistant';
  thinking?: boolean;
  text?: boolean;
  tools?: boolean;
  errors?: boolean;
  tail?: number;
  since?: string;
  grep?: string;
}

async function sessionRaw(ctx: ToolCtx, args: SessionRawArgs): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const sandboxDir = findSandboxDir(ctx.roots.agentHome, job.id);
  if (!sandboxDir) throw new Error(`no sandbox transcripts found on disk for job ${job.id}`);

  if (args.grep) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(args.grep);
    } catch (err) {
      throw new Error(`invalid grep pattern: ${String(err)}`);
    }
    const files = args.sessionId ? [requireSessionFile(sandboxDir, args.sessionId)] : listSessionFiles(sandboxDir);
    return { hits: grepFiles(files, pattern) };
  }

  if (!args.sessionId) {
    const files = listSessionFiles(sandboxDir);
    return {
      sessions: files.map((f) => ({
        sessionId: f.sessionId,
        path: f.path,
        lineCount: readRawLines(f.path).filter((l) => l.trim()).length,
      })),
    };
  }

  const path = requireSessionFile(sandboxDir, args.sessionId).path;
  const lines = renderShow(readRawLines(path), {
    role: args.role,
    since: args.since,
    thinking: args.thinking,
    text: args.text,
    tools: args.tools,
    errors: args.errors,
    tail: args.tail,
  });
  return { sessionId: args.sessionId, path, lines };
}

function requireSessionFile(sandboxDir: string, sessionId: string): { sessionId: string; path: string } {
  if (!isValidSessionId(sessionId)) throw new Error(`invalid session id '${sessionId}'`);
  const path = resolveSessionFile(sandboxDir, sessionId);
  if (!path) throw new Error(`session '${sessionId}' not found`);
  return { sessionId, path };
}

// ── atlas_list_jobs ───────────────────────────────────────────────────────────────────────────────────

interface ListJobsArgs {
  repoId?: string;
  orgId?: string;
  status?: string;
  limit?: number;
}

async function listJobs(ctx: ToolCtx, args: ListJobsArgs): Promise<unknown> {
  const where: Partial<Pick<JobEntity, 'repo_id' | 'org_id' | 'status'>> = {};
  if (args.repoId) where.repo_id = args.repoId;
  if (args.orgId) where.org_id = args.orgId;
  if (args.status) where.status = args.status;

  const jobs = await ctx.ds.getRepository(JobEntity).find({
    where,
    order: { created_at: 'DESC' },
    take: args.limit ?? 50,
  });

  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      orgId: j.org_id,
      repoId: j.repo_id,
      status: j.status,
      title: j.title,
      prUrl: j.pr_url,
      ciStatus: j.ci_status,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
    })),
  };
}

// ── filesystem tree helper (shared by atlas_context_read / atlas_worktree_tree) ─────────────────────────

interface TreeEntry {
  path: string;
  type: 'file' | 'dir';
}

/** Recursively list `absRoot`, capped at {@link MAX_TREE_ENTRIES} entries / {@link MAX_TREE_DEPTH} deep so
 *  a huge worktree/context dir can't blow up a tool response. Silently stops descending past the caps
 *  rather than failing the whole listing. */
function listTree(absRoot: string, skipDirs: ReadonlySet<string> = new Set()): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (out.length >= MAX_TREE_ENTRIES || depth > MAX_TREE_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of [...entries].sort()) {
      if (out.length >= MAX_TREE_ENTRIES) return;
      if (skipDirs.has(entry)) continue;
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        out.push({ path: relPath, type: 'dir' });
        walk(full, relPath, depth + 1);
      } else {
        out.push({ path: relPath, type: 'file' });
      }
    }
  };
  walk(absRoot, '', 0);
  return out;
}

function readFileCapped(path: string): string {
  const st = statSync(path);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`file too large to read (${st.size} bytes, cap is ${MAX_FILE_BYTES})`);
  }
  return readFileSync(path, 'utf8');
}

// ── atlas_context_read ────────────────────────────────────────────────────────────────────────────────

const CONTEXT_SUBDIRS = ['specs', 'generated', 'artifacts'];

async function contextRead(ctx: ToolCtx, args: { jobId: string; path?: string }): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const root = join(ctx.roots.agentHome, 'contexts', job.org_id, job.id);

  if (!args.path) {
    const tree: TreeEntry[] = [];
    for (const sub of CONTEXT_SUBDIRS) {
      const subRoot = join(root, sub);
      if (!existsSync(subRoot)) continue;
      tree.push(...listTree(subRoot).map((e) => ({ path: `${sub}/${e.path}`, type: e.type })));
    }
    return { root, tree };
  }

  const resolved = resolveJailed(root, args.path);
  if (!existsSync(resolved)) throw new Error(`${args.path} not found under context root`);
  const st = statSync(resolved);
  if (st.isDirectory()) {
    return { root, path: args.path, tree: listTree(resolved) };
  }
  return { root, path: args.path, content: readFileCapped(resolved) };
}

// ── atlas_worktree_tree / atlas_worktree_file ────────────────────────────────────────────────────────

const WORKTREE_SKIP_DIRS = new Set(['.git', 'node_modules']);

async function worktreeTree(ctx: ToolCtx, args: { jobId: string; subpath?: string }): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const sandbox = await loadSandbox(ctx, job.id);
  const target = resolveJailed(sandbox.worktree_path, args.subpath ?? '.');
  if (!existsSync(target)) throw new Error(`${args.subpath ?? '.'} not found under worktree`);
  return {
    root: sandbox.worktree_path,
    subpath: args.subpath ?? null,
    tree: listTree(target, WORKTREE_SKIP_DIRS),
  };
}

async function worktreeFile(ctx: ToolCtx, args: { jobId: string; path: string }): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const sandbox = await loadSandbox(ctx, job.id);
  const target = resolveJailed(sandbox.worktree_path, args.path);
  if (!existsSync(target)) throw new Error(`${args.path} not found under worktree`);
  const st = statSync(target);
  if (!st.isFile()) throw new Error(`${args.path} is not a file`);
  return { root: sandbox.worktree_path, path: args.path, content: readFileCapped(target) };
}

// ── registry ──────────────────────────────────────────────────────────────────────────────────────────

export const TOOL_DEFS: Tool[] = [
  {
    name: 'atlas_job_overview',
    description: "A job's core status fields plus its thread list (with a one-line failure summary per thread).",
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'atlas_thread_failure',
    description:
      "A thread's full typed terminal record (verification/failure/blocked detail), or every thread's on the job when threadId is omitted.",
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, threadId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'atlas_job_transcript',
    description: "A job's operator-facing message transcript, with kind/source/since/tail filters.",
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        kind: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        source: { type: 'string' },
        tail: { type: 'number' },
        since: { type: 'string', description: 'ISO-8601 timestamp' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'atlas_session_raw',
    description:
      'Raw Claude Code session JSONL for a job — list sessions, render a session (atlas-tx `show` semantics), or grep across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        sessionId: { type: 'string' },
        role: { type: 'string', enum: ['user', 'assistant'] },
        thinking: { type: 'boolean' },
        text: { type: 'boolean' },
        tools: { type: 'boolean' },
        errors: { type: 'boolean' },
        tail: { type: 'number', description: 'default 80' },
        since: { type: 'string', description: 'ISO-8601 timestamp' },
        grep: { type: 'string', description: 'regex; scans raw JSONL lines, not JSON-aware' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'atlas_list_jobs',
    description: 'List jobs across ALL orgs, optionally filtered by repoId/orgId/status.',
    inputSchema: {
      type: 'object',
      properties: {
        repoId: { type: 'string' },
        orgId: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'number', description: 'default 50' },
      },
    },
  },
  {
    name: 'atlas_context_read',
    description:
      "A job's durable /context dir (specs/generated/artifacts) — a tree listing when path is omitted, else a file's contents or a subdir's tree.",
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, path: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'atlas_worktree_tree',
    description: "A job's git worktree file tree (skips .git, node_modules).",
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, subpath: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'atlas_worktree_file',
    description: "One file's contents from a job's git worktree.",
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, path: { type: 'string' } },
      required: ['jobId', 'path'],
    },
  },
];

export type ToolHandler = (ctx: ToolCtx, args: Record<string, unknown>) => Promise<unknown>;

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  atlas_job_overview: (ctx, args) => jobOverview(ctx, args as { jobId: string }),
  atlas_thread_failure: (ctx, args) => threadFailure(ctx, args as { jobId: string; threadId?: string }),
  atlas_job_transcript: (ctx, args) => jobTranscript(ctx, args as unknown as JobTranscriptArgs),
  atlas_session_raw: (ctx, args) => sessionRaw(ctx, args as unknown as SessionRawArgs),
  atlas_list_jobs: (ctx, args) => listJobs(ctx, args as ListJobsArgs),
  atlas_context_read: (ctx, args) => contextRead(ctx, args as { jobId: string; path?: string }),
  atlas_worktree_tree: (ctx, args) => worktreeTree(ctx, args as { jobId: string; subpath?: string }),
  atlas_worktree_file: (ctx, args) => worktreeFile(ctx, args as { jobId: string; path: string }),
};
