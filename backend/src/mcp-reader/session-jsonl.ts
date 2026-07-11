import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { resolveJailed } from './path-jail';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Locate a job's sandbox home dir on the host — `<agentHomeRoot>/sandboxes/<sandboxDir>` — by the same
 * `-thread-<suffix>` glob `SandboxManager.findSandboxHomeDir` uses container-side: the container name is
 * `atlas-sbx-…-thread-<jobId>` with the jobId tail possibly truncated to 40 chars by the container-name
 * cap, so we match a dir whose `-thread-` suffix is a PREFIX of the jobId (not equality).
 */
export function findSandboxDir(
  agentHomeRoot: string,
  jobId: string,
): string | null {
  const sandboxesRoot = join(agentHomeRoot, 'sandboxes');
  let dirs: string[];
  try {
    dirs = readdirSync(sandboxesRoot);
  } catch {
    return null;
  }
  const candidates = dirs
    .map((d) => {
      const i = d.lastIndexOf('-thread-');
      if (i < 0) return null;
      const suffix = d.slice(i + '-thread-'.length);
      return suffix.length > 0 && jobId.startsWith(suffix)
        ? { dir: d, suffix }
        : null;
    })
    .filter((d): d is { dir: string; suffix: string } => d !== null)
    .sort((a, b) => b.suffix.length - a.suffix.length);

  for (const candidate of candidates) {
    const full = join(sandboxesRoot, candidate.dir);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory() && !st.isSymbolicLink()) return full;
  }
  return null;
}

/** Recursively collect every `.jsonl` file under `dir` that sits under a `claude/projects/<slug>` dir
 *  (mirrors atlas-tx's `find -path '*` + `/claude/projects/*.jsonl'`). Skips unreadable subtrees silently. */
function walkJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      out.push(...walkJsonlFiles(full));
    } else if (
      entry.endsWith('.jsonl') &&
      full.includes(`${sep}claude${sep}projects${sep}`)
    ) {
      out.push(full);
    }
  }
  return out;
}

export interface SessionFile {
  sessionId: string;
  path: string;
}

/** Every session JSONL discovered under a job's sandbox dir, path-jailed to it. */
export function listSessionFiles(sandboxDir: string): SessionFile[] {
  return walkJsonlFiles(sandboxDir).map((path) => ({
    sessionId: path.slice(0, -'.jsonl'.length).split(sep).pop() as string,
    path: resolveJailed(sandboxDir, path.slice(sandboxDir.length + 1)),
  }));
}

/** Resolve one session id to its jailed JSONL path, or null if not found / invalid id. */
export function resolveSessionFile(
  sandboxDir: string,
  sessionId: string,
): string | null {
  if (!isValidSessionId(sessionId)) return null;
  const match = listSessionFiles(sandboxDir).find(
    (f) => f.sessionId === sessionId,
  );
  return match?.path ?? null;
}

/** Read a session file's raw lines (already path-jailed by the caller via {@link resolveSessionFile} /
 *  {@link listSessionFiles}). */
export function readRawLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n');
}

export interface ShowOptions {
  role?: 'user' | 'assistant';
  since?: string;
  thinking?: boolean;
  text?: boolean;
  tools?: boolean;
  errors?: boolean;
  tail?: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface TranscriptRecord {
  type?: string;
  timestamp?: string;
  message?: { content?: ContentBlock[] | string };
}

function compact(body: string): string {
  return body.replace(/[\n\r\t]+/g, ' ').replace(/ +/g, ' ');
}

function flattenToolResultContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => (c as { text?: string })?.text ?? String(c))
      .join(' ');
  }
  if (typeof content === 'string') return content;
  return String(content ?? '');
}

function expandBlocks(record: TranscriptRecord): ContentBlock[] {
  const content = record.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

/** Render one JSONL file's lines per atlas-tx `show` semantics (see the module doc). Unparseable lines are
 *  skipped, matching the shell tool's `jq` behavior of erroring only on a truly malformed record. */
export function renderShow(rawLines: string[], opts: ShowOptions): string[] {
  const wantText = opts.text ?? false;
  const wantThinking = opts.thinking ?? false;
  const wantTools = opts.tools ?? false;
  const wantErrors = opts.errors ?? false;
  const defaultToText = !wantText && !wantThinking && !wantTools && !wantErrors;

  const rendered: string[] = [];
  for (const raw of rawLines) {
    if (!raw.trim()) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(raw) as TranscriptRecord;
    } catch {
      continue;
    }
    if (opts.role && record.type !== opts.role) continue;
    if (opts.since && (record.timestamp ?? '') < opts.since) continue;

    const ts = record.timestamp ?? '';
    const role = record.type ?? '';
    for (const block of expandBlocks(record)) {
      if (block.type === 'text' && (wantText || defaultToText)) {
        rendered.push(
          `[${ts}] ${role}/text: ${compact(String(block.text ?? ''))}`,
        );
      } else if (block.type === 'thinking' && wantThinking) {
        rendered.push(
          `[${ts}] ${role}/thinking: ${compact(String(block.thinking ?? ''))}`,
        );
      } else if (block.type === 'tool_use' && wantTools) {
        rendered.push(
          `[${ts}] ${role}/tool_use: ${compact(`${block.name ?? ''} ${JSON.stringify(block.input)}`)}`,
        );
      } else if (
        block.type === 'tool_result' &&
        wantErrors &&
        block.is_error === true
      ) {
        const body = `${block.tool_use_id ?? ''} ${flattenToolResultContent(block.content)}`;
        rendered.push(`[${ts}] ${role}/tool_result[error]: ${compact(body)}`);
      }
    }
  }
  const tail = opts.tail ?? 80;
  return tail > 0 ? rendered.slice(-tail) : rendered;
}

export interface GrepHit {
  path: string;
  sessionId: string;
  line: string;
}

/** Raw regex grep across the raw (not JSON-parsed) JSONL text of each file — mirrors atlas-tx `grep`. */
export function grepFiles(files: SessionFile[], pattern: RegExp): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const file of files) {
    for (const line of readRawLines(file.path)) {
      if (!line) continue;
      if (pattern.test(line))
        hits.push({ path: file.path, sessionId: file.sessionId, line });
      pattern.lastIndex = 0; // global-flag regexes carry state across .test() calls — reset every line
    }
  }
  return hits;
}
