/**
 * A file edit, as something to LOOK at rather than a sentence about a file.
 *
 * **Nothing here computes a diff.** The SDK already applied the edit and reports the hunks it
 * produced on `tool_use_result.structuredPatch`, carrying the file's REAL line numbers. A patch
 * recomputed from `old_string`/`new_string` could only ever be a worse copy of that: the harness
 * never had the file in hand, so it could say what changed but not where. This module parses what
 * the engine already knows and lays it out; when the engine says nothing, the block stays a
 * sentence rather than becoming a guess.
 *
 * The shape mirrors the legacy web renderer's (`web/.../tool-calls/diff-rows.ts`) on purpose —
 * same source field, same row model, so the two surfaces cannot drift into disagreeing about what
 * an edit did.
 */

export type DiffHunk = {
  /** First line of the hunk in the file BEFORE the edit. */
  oldStart: number;
  /** First line of the hunk in the file AFTER it. */
  newStart: number;
  /** Unified-diff lines, sign-prefixed: `+` added, `-` removed, leading space for context. */
  lines: string[];
};

export enum EDiffLineKind {
  context = 'context',
  added = 'added',
  removed = 'removed',
  /** The elided stretch between two hunks — no number, no content, just "there is a gap here". */
  gap = 'gap',
}

export type DiffRow = {
  kind: EDiffLineKind;
  /**
   * Where the line lives in the file the reader would open: the NEW number for context and
   * additions, the OLD one for a removal, which is the only file that still has it.
   */
  lineNo: number | null;
  /** The line itself, sign stripped — the sign is rendered as a gutter, not as content. */
  text: string;
};

export type DiffStat = { additions: number; removals: number };

/** The tools whose result is a change to a file, and so has a diff worth drawing. */
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Update',
  'MultiEdit',
  'Write',
  'NotebookEdit',
]);

export function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `tool_use_result.structuredPatch` → hunks, or nothing.
 *
 * Tolerant on purpose: this is the one field in the whole harness that is read off an SDK payload
 * without a declared type (`tool_use_result` is `unknown` in the SDK's own d.ts). A shape change
 * upstream has to cost the diff, not the transcript.
 */
export function parseHunks(value: unknown): DiffHunk[] {
  if (!Array.isArray(value)) return [];
  const hunks: DiffHunk[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const { oldStart, newStart, lines } = raw;
    if (typeof oldStart !== 'number' || typeof newStart !== 'number') continue;
    if (!Array.isArray(lines)) continue;
    const text = lines.filter((line): line is string => typeof line === 'string');
    if (text.length === 0) continue;
    hunks.push({ oldStart, newStart, lines: text });
  }
  return hunks;
}

/**
 * The hunks for one tool result, from whichever field the engine put them in.
 *
 * A file that did not exist has nothing to diff against, so the SDK sends an EMPTY patch and the
 * whole `content` instead. Written out as additions, a new file reads in the transcript exactly the
 * way a change to an old one does — one grammar for "what landed on disk", not two.
 */
export function toolDiff(args: { name: string; raw: unknown }): DiffHunk[] {
  if (!isFileEditTool(args.name)) return [];
  const raw = isRecord(args.raw) ? args.raw : {};

  const hunks = parseHunks(raw.structuredPatch);
  if (hunks.length > 0) return hunks;

  const created = typeof raw.content === 'string' ? raw.content : null;
  if (created === null) return [];
  return [{ oldStart: 0, newStart: 1, lines: splitLines(created).map((line) => `+${line}`) }];
}

/** A trailing newline ends the last line; it does not begin an empty one. */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

export function diffStat(hunks: DiffHunk[]): DiffStat {
  let additions = 0;
  let removals = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) removals += 1;
    }
  }
  return { additions, removals };
}

/** `Updated with 6 additions and 1 removal` — the headline over the hunks. */
export function diffSummary(stat: DiffStat): string {
  const additions = `${stat.additions} addition${stat.additions === 1 ? '' : 's'}`;
  const removals = `${stat.removals} removal${stat.removals === 1 ? '' : 's'}`;
  if (stat.removals === 0) return `Updated with ${additions}`;
  if (stat.additions === 0) return `Updated with ${removals}`;
  return `Updated with ${additions} and ${removals}`;
}

/**
 * Hunks → the rows a renderer paints, numbered as the file numbers them.
 *
 * Each counter advances only through the file it belongs to: a removed line moves the OLD cursor
 * and an added line the NEW one, which is what makes a run of `-` followed by `+` show the same
 * number twice rather than drifting a replacement out of line with what it replaced.
 */
export function diffRows(hunks: DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of hunks) {
    // Between hunks the file continues without us; say so rather than butting two distant line
    // numbers against each other and letting the reader assume they are adjacent.
    if (rows.length > 0) rows.push({ kind: EDiffLineKind.gap, lineNo: null, text: '' });

    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const line of hunk.lines) {
      const sign = line.slice(0, 1);
      const text = line.slice(1);
      // `\ No newline at end of file` is a note about the patch, not a line of the file.
      if (sign === '\\') continue;
      if (sign === '+') {
        rows.push({ kind: EDiffLineKind.added, lineNo: newNo, text });
        newNo += 1;
      } else if (sign === '-') {
        rows.push({ kind: EDiffLineKind.removed, lineNo: oldNo, text });
        oldNo += 1;
      } else {
        rows.push({ kind: EDiffLineKind.context, lineNo: newNo, text });
        oldNo += 1;
        newNo += 1;
      }
    }
  }
  return rows;
}

/** Wide enough for the largest number in the block, so the code column does not step in and out. */
export function gutterWidth(rows: DiffRow[]): number {
  return rows.reduce(
    (width, row) => Math.max(width, row.lineNo === null ? 0 : String(row.lineNo).length),
    1,
  );
}

/** The sign column: one character, and a space where a context line would put one. */
export function diffSign(kind: EDiffLineKind): string {
  if (kind === EDiffLineKind.added) return '+';
  if (kind === EDiffLineKind.removed) return '-';
  return ' ';
}
