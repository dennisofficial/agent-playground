/**
 * The tool-call surface is the only checkpoint where the two SDKs must agree: a Claude turn and a
 * Codex turn that do the same work have to render byte-identically here. Hence pure and tested.
 */

import { type DiffHunk, diffStat, diffSummary, toolDiff } from './tool-diff.js';

type Input = Record<string, unknown>;

/** Exported for `tool-view.ts`, which reads the same stored `input` at DRAW time. */
export function asInput(input: unknown): Input {
  return input && typeof input === 'object' ? (input as Input) : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function relativise(path: string, cwd: string): string {
  if (!cwd || !path.startsWith(cwd)) return path;
  return path.slice(cwd.length).replace(/^\//, '') || path;
}

/** What goes inside the parens: `Read(backend/src/host/turn-dispatcher.service.ts)`. Undefined for
 *  tools whose call is self-describing without an argument. */
export function toolTarget(name: string, input: unknown, cwd = ''): string | undefined {
  const it = asInput(input);
  const path = str(it.file_path) ?? str(it.path) ?? str(it.notebook_path);
  if (path) return relativise(path, cwd);

  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return str(it.command);
    case 'Grep':
      return str(it.pattern);
    case 'Glob':
      return str(it.pattern);
    case 'WebFetch':
      return str(it.url);
    case 'WebSearch':
      return str(it.query);
    case 'Task':
    case 'Agent':
      return str(it.description);
    case 'Skill':
      return str(it.skill);
    default:
      return str(it.query) ?? str(it.pattern) ?? str(it.command) ?? str(it.description);
  }
}

export type ResultSummary = {
  summary: string;
  detail: string[];
  /** Present only for a tool that changed a file, and only when the engine reported how. */
  diff?: DiffHunk[];
};

/**
 * The headline is a claim about what happened rather than the first line of output — "Read 210
 * lines" beats echoing the file's first line back at the reader.
 *
 * `raw` is the engine's own account of what the tool did (`tool_use_result`), which for an edit is
 * the only place the patch exists — the tool's textual result is a one-line confirmation that says
 * nothing about what changed.
 */
export function summariseToolResult(args: {
  name: string;
  input: unknown;
  lines: string[];
  ok: boolean;
  raw?: unknown;
}): ResultSummary {
  const { name, input, lines, ok, raw } = args;
  const meaningful = lines.filter((l) => l.trim().length > 0);

  if (!ok) {
    return { summary: meaningful[0] ?? 'Failed', detail: lines.slice(1) };
  }

  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      return { summary: `Read ${countLines(lines)} lines`, detail: lines };
    }
    case 'Write': {
      const diff = toolDiff({ name, raw });
      // The written file, not the confirmation: `lines` here is "File created successfully at …",
      // so counting it reported `Wrote 1 lines` for every file the agent has ever written.
      const written = diffStat(diff).additions;
      const summary = written > 0 ? `Wrote ${written} line${written === 1 ? '' : 's'}` : 'Wrote file';
      return { summary, detail: lines, ...(diff.length > 0 ? { diff } : {}) };
    }
    case 'Edit':
    case 'Update':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const diff = toolDiff({ name, raw });
      if (diff.length > 0) {
        return { summary: diffSummary(diffStat(diff)), detail: lines, diff };
      }
      // No patch reported — an engine that does not send one, or a shape this build cannot read.
      // The old scrape stays as the fallback so the block still says something true.
      const patch = editSummary(meaningful);
      return { summary: patch ?? 'Updated file', detail: lines };
    }
    case 'Grep':
    case 'Glob': {
      const n = countLines(lines);
      return { summary: `Found ${n} ${n === 1 ? 'match' : 'matches'}`, detail: lines };
    }
    case 'TodoWrite':
      return { summary: 'Updated todo list', detail: lines };
    default: {
      return { summary: meaningful[0] ?? 'Done', detail: dropFirst(lines, meaningful[0]) };
    }
  }
}

/**
 * A trailing newline yields a final empty element that is not a line of content.
 *
 * Exported because `tool-view.ts` re-counts a stored result at draw time and has to arrive at the
 * SAME number this produced at ingest — a row that says `156 l` under a summary that says
 * `Read 157 lines` is a bug the reader can see.
 */
export function countLines(lines: readonly string[]): number {
  const last = lines.at(-1);
  return last !== undefined && last.length === 0 ? lines.length - 1 : lines.length;
}

function editSummary(lines: string[]): string | null {
  for (const line of lines) {
    const match = /(\d+)\s+addition[s]?\s+and\s+(\d+)\s+removal[s]?/.exec(line);
    if (match) return `Updated with ${match[1]} additions and ${match[2]} removals`;
  }
  return null;
}

function dropFirst(lines: string[], first: string | undefined): string[] {
  if (first === undefined) return lines;
  const index = lines.indexOf(first);
  return index === -1 ? lines : lines.slice(index + 1);
}
