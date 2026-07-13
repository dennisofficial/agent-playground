import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  JobEntity,
  JobSandboxEntity,
  ThreadEntity,
} from '../persistence/entities';
import type { ThreadTerminalRecord } from '../persistence/entities/thread.entity';
import { QUERY_FORMATS, renderRows, type QueryFormat } from './format';
import { resolveJailed } from './path-jail';
import { introspectSchema, runReadOnlyQuery } from './query';
import { redactSecrets } from './redact';
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
  audit: { orgId?: string; sql?: string; rowCount?: number };
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseQueryFormat(value: unknown): QueryFormat {
  if (value === undefined) return 'json';
  if (
    typeof value === 'string' &&
    QUERY_FORMATS.includes(value as QueryFormat)
  ) {
    return value as QueryFormat;
  }
  throw new Error(`format must be one of: ${QUERY_FORMATS.join(', ')}`);
}

function parseQueryLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('limit must be a finite number');
  }
  return Math.floor(value);
}

async function loadJob(ctx: ToolCtx, jobId: unknown): Promise<JobEntity> {
  const id = requireNonEmptyString(jobId, 'jobId');
  const job = await ctx.ds.getRepository(JobEntity).findOne({ where: { id } });
  if (!job) throw new Error(`job ${id} not found`);
  ctx.audit.orgId = job.org_id;
  return job;
}

async function loadSandbox(
  ctx: ToolCtx,
  jobId: string,
): Promise<JobSandboxEntity> {
  const sandbox = await ctx.ds
    .getRepository(JobSandboxEntity)
    .findOne({ where: { job_id: jobId } });
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

// ── atlas_query / atlas_schema ────────────────────────────────────────────────────────────────────────

async function atlasQuery(
  ctx: ToolCtx,
  args: {
    sql: string;
    params?: unknown[];
    format?: unknown;
    limit?: unknown;
  },
): Promise<unknown> {
  const sql = requireNonEmptyString(args.sql, 'sql');
  // Stamp the SQL BEFORE running so a guard rejection / timeout / permission error still lands the SQL in
  // main.ts's failed-query audit line.
  ctx.audit.sql = sql;
  const format = parseQueryFormat(args.format);
  const limit = parseQueryLimit(args.limit);
  const params = Array.isArray(args.params) ? args.params : [];
  const { rows, rowCount, truncated } = await runReadOnlyQuery(
    ctx.ds,
    sql,
    params,
    limit,
  );
  ctx.audit.rowCount = rowCount;
  if (format === 'json') return { format, rowCount, truncated, rows };
  // Redact the row OBJECTS before flattening to text. redact.ts's key-name masking (SECRET_KEY_PATTERN)
  // blanks opaque values in secret-named columns (e.g. `access_token`, `password`), but that key context
  // is lost once rows are rendered to csv/tsv — the header and value land on separate lines, so the
  // string-pattern scan main.ts runs on the flattened text can't recover it. Redacting here preserves the
  // key-name masking for all rendered formats.
  const redactedRows = redactSecrets(
    rows as Record<string, unknown>[],
  ) as Record<string, unknown>[];
  return {
    format,
    rowCount,
    truncated,
    text: renderRows(redactedRows, format),
  };
}

async function atlasSchema(ctx: ToolCtx): Promise<unknown> {
  return introspectSchema(ctx.ds);
}

// ── atlas_job_overview ────────────────────────────────────────────────────────────────────────────────

async function jobOverview(
  ctx: ToolCtx,
  args: { jobId: string },
): Promise<unknown> {
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

// ── atlas_session_raw ─────────────────────────────────────────────────────────────────────────────────

interface SessionRawArgs {
  jobId: string;
  sessionId?: string;
  raw?: boolean;
  role?: 'user' | 'assistant';
  thinking?: boolean;
  text?: boolean;
  tools?: boolean;
  errors?: boolean;
  tail?: number;
  since?: string;
  grep?: string;
}

async function sessionRaw(
  ctx: ToolCtx,
  args: SessionRawArgs,
): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const sandboxDir = findSandboxDir(ctx.roots.agentHome, job.id);
  if (!sandboxDir)
    throw new Error(`no sandbox transcripts found on disk for job ${job.id}`);

  if (args.grep) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(args.grep);
    } catch (err) {
      throw new Error(`invalid grep pattern: ${String(err)}`);
    }
    const files = args.sessionId
      ? [requireSessionFile(sandboxDir, args.sessionId)]
      : listSessionFiles(sandboxDir);
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
  if (args.raw) {
    return { sessionId: args.sessionId, path, content: readFileCapped(path) };
  }
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

function requireSessionFile(
  sandboxDir: string,
  sessionId: string,
): { sessionId: string; path: string } {
  if (!isValidSessionId(sessionId))
    throw new Error(`invalid session id '${sessionId}'`);
  const path = resolveSessionFile(sandboxDir, sessionId);
  if (!path) throw new Error(`session '${sessionId}' not found`);
  return { sessionId, path };
}

// ── filesystem tree helper (shared by atlas_context_read / atlas_worktree_tree) ─────────────────────────

interface TreeEntry {
  path: string;
  type: 'file' | 'dir';
}

/** Recursively list `absRoot`, capped at {@link MAX_TREE_ENTRIES} entries / {@link MAX_TREE_DEPTH} deep so
 *  a huge worktree/context dir can't blow up a tool response. Silently stops descending past the caps
 *  rather than failing the whole listing. */
function listTree(
  absRoot: string,
  skipDirs: ReadonlySet<string> = new Set(),
): TreeEntry[] {
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
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      // Don't follow symlinks: a symlink planted inside the jail could point outside it, so
      // enumerating its target would leak names outside the jail. Skip them entirely.
      if (st.isSymbolicLink()) continue;
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
    throw new Error(
      `file too large to read (${st.size} bytes, cap is ${MAX_FILE_BYTES})`,
    );
  }
  return readFileSync(path, 'utf8');
}

// ── atlas_context_read ────────────────────────────────────────────────────────────────────────────────

const CONTEXT_SUBDIRS = ['specs', 'generated', 'artifacts', 'evidence'];

async function contextRead(
  ctx: ToolCtx,
  args: { jobId: string; path?: string },
): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const root = join(ctx.roots.agentHome, 'contexts', job.org_id, job.id);

  if (!args.path) {
    const tree: TreeEntry[] = [];
    for (const sub of CONTEXT_SUBDIRS) {
      const subRoot = join(root, sub);
      if (!existsSync(subRoot)) continue;
      tree.push(
        ...listTree(subRoot).map((e) => ({
          path: `${sub}/${e.path}`,
          type: e.type,
        })),
      );
    }
    return { root, tree };
  }

  const resolved = resolveJailed(root, args.path);
  if (!existsSync(resolved))
    throw new Error(`${args.path} not found under context root`);
  const st = statSync(resolved);
  if (st.isDirectory()) {
    return { root, path: args.path, tree: listTree(resolved) };
  }
  return { root, path: args.path, content: readFileCapped(resolved) };
}

// ── atlas_worktree_tree / atlas_worktree_file ────────────────────────────────────────────────────────

const WORKTREE_SKIP_DIRS = new Set(['.git', 'node_modules']);

async function worktreeTree(
  ctx: ToolCtx,
  args: { jobId: string; subpath?: string },
): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const sandbox = await loadSandbox(ctx, job.id);
  const target = resolveJailed(sandbox.worktree_path, args.subpath ?? '.');
  if (!existsSync(target))
    throw new Error(`${args.subpath ?? '.'} not found under worktree`);
  return {
    root: sandbox.worktree_path,
    subpath: args.subpath ?? null,
    tree: listTree(target, WORKTREE_SKIP_DIRS),
  };
}

async function worktreeFile(
  ctx: ToolCtx,
  args: { jobId: string; path: string },
): Promise<unknown> {
  const job = await loadJob(ctx, args.jobId);
  const sandbox = await loadSandbox(ctx, job.id);
  const filePath = requireNonEmptyString(args.path, 'path');
  const target = resolveJailed(sandbox.worktree_path, filePath);
  if (!existsSync(target))
    throw new Error(`${filePath} not found under worktree`);
  const st = statSync(target);
  if (!st.isFile()) throw new Error(`${filePath} is not a file`);
  return {
    root: sandbox.worktree_path,
    path: filePath,
    content: readFileCapped(target),
  };
}

// ── registry ──────────────────────────────────────────────────────────────────────────────────────────

export const TOOL_DEFS: Tool[] = [
  {
    name: 'atlas_query',
    description:
      'Run ONE read-only SQL query (single SELECT/WITH only) against the production database and get the rows back. Multi-statement/DDL/DML are rejected; results default to a 1000-row cap (raise with `limit`, up to a 50000-row ceiling), run under a 10s statement timeout, and are passed through secret redaction. Call atlas_schema first to discover tables/columns. Optional positional bind params map to $1..$n. `format` selects the response shape: json (default, rows array), jsonl, csv, or tsv (rendered text). Large results are auto-written to a file in /playground (you get back a path + preview) — use jsonl/csv for grep/jq/python/duckdb.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'a single read-only SELECT or WITH query',
        },
        params: {
          type: 'array',
          description: 'optional positional bind params ($1..$n)',
        },
        format: {
          type: 'string',
          enum: ['json', 'jsonl', 'csv', 'tsv'],
          description: 'output format; default json',
        },
        limit: {
          type: 'number',
          description: 'max rows (default 1000, ceiling 50000)',
        },
      },
      required: ['sql'],
    },
  },
  {
    name: 'atlas_schema',
    description:
      'List every public table and its columns (name, data type, nullability) from information_schema — the map for writing atlas_query SQL.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'atlas_job_overview',
    description:
      "A job's core status fields plus its thread list (with a one-line failure summary per thread).",
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
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
        raw: {
          type: 'boolean',
          description: 'when true with sessionId, returns the raw JSONL text',
        },
        role: { type: 'string', enum: ['user', 'assistant'] },
        thinking: { type: 'boolean' },
        text: { type: 'boolean' },
        tools: { type: 'boolean' },
        errors: { type: 'boolean' },
        tail: { type: 'number', description: 'default 80' },
        since: { type: 'string', description: 'ISO-8601 timestamp' },
        grep: {
          type: 'string',
          description: 'regex; scans raw JSONL lines, not JSON-aware',
        },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'atlas_context_read',
    description:
      "A job's durable /context dir (specs/generated/artifacts/evidence) — a tree listing when path is omitted, else a file's contents or a subdir's tree.",
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

export type ToolHandler = (
  ctx: ToolCtx,
  args: Record<string, unknown>,
) => Promise<unknown>;

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  atlas_query: (ctx, args) =>
    atlasQuery(
      ctx,
      args as unknown as {
        sql: string;
        params?: unknown[];
        format?: unknown;
        limit?: unknown;
      },
    ),
  atlas_schema: (ctx) => atlasSchema(ctx),
  atlas_job_overview: (ctx, args) =>
    jobOverview(ctx, args as { jobId: string }),
  atlas_session_raw: (ctx, args) =>
    sessionRaw(ctx, args as unknown as SessionRawArgs),
  atlas_context_read: (ctx, args) =>
    contextRead(ctx, args as { jobId: string; path?: string }),
  atlas_worktree_tree: (ctx, args) =>
    worktreeTree(ctx, args as { jobId: string; subpath?: string }),
  atlas_worktree_file: (ctx, args) =>
    worktreeFile(ctx, args as { jobId: string; path: string }),
};
