/**
 * The per-tool treatments, and the registry that resolves one.
 *
 * Separated from `tool-view.ts` only for size: that file owns the vocabulary (`EToolShape`, `ToolRow`)
 * and the two questions callers ask, this one owns the answers. A tool's row and its heading still live
 * on ONE object here, which is the part that matters — two registries disagree the first time someone
 * edits one.
 */

import { asInput, countLines, relativise, str, toolTarget } from './tool-summary.js';
import { clip, displayToolName, formatCount, plural, total, failures } from './tool-text.js';
import { EElide, EToolShape, type ToolCall, type ToolRow, type ToolView } from './tool-shape.js';

export type ToolPresenter = {
  shape: EToolShape;
  view: (call: ToolCall) => Omit<ToolView, 'row' | 'shape'>;
  row: (call: ToolCall) => ToolRow;
  /** The heading when every call in the group is THIS tool. */
  heading: (rows: readonly ToolRow[]) => string;
  /**
   * This tool's clause in a MIXED heading — `read 6 files`, `ran 1 command`.
   *
   * Separate from `heading` because a clause is not a sentence: no capital, no measure and no failure
   * count, since the sentence it joins owns all three.
   */
  phrase: (count: number) => string;
};

/** How much of a command the header line carries before the rest goes below the fold. */
const COMMAND_MAX = 64;

// --- the presenters ------------------------------------------------------------------------------

export const READ: ToolPresenter = {
  shape: EToolShape.gathering,
  view: (call) => ({ name: call.name, target: filePath(call), command: [] }),
  row: (call) => ({
    label: filePath(call) ?? call.name,
    elide: EElide.head,
    ok: succeeded(call),
    ...measure(call, (n) => `${formatCount(n)} l`),
  }),
  heading: (rows) =>
    `Read ${plural(rows.length, 'file')}${total(rows, 'line')}${failures(rows)}`,
  phrase: (count) => `read ${plural(count, 'file')}`,
};

export const BASH: ToolPresenter = {
  shape: EToolShape.gathering,
  view: (call) => ({
    name: call.name,
    target: commandLabel(call),
    command: commandLines(call),
  }),
  row: (call) => ({
    label: commandLabel(call),
    elide: EElide.tail,
    ok: succeeded(call),
    ...measure(call, (n) => `${formatCount(n)} l`),
  }),
  // No line total: shell output is not a file read, so `6 commands · 812 lines` measures nothing a
  // reader acts on. How many ran, and whether any failed, is the whole story.
  heading: (rows) => `Ran ${plural(rows.length, 'command')}${failures(rows)}`,
  phrase: (count) => `ran ${plural(count, 'command')}`,
};

/**
 * Grep and Glob share a presenter but NOT a clause: a mixed heading counts by tool NAME, so a run of
 * both reads `searched 3 patterns, globbed 2 patterns` rather than merging into one wrong number.
 */
export const SEARCH: ToolPresenter = {
  shape: EToolShape.gathering,
  view: (call) => ({
    name: call.name,
    target: str(asInput(call.input).pattern),
    command: [],
  }),
  row: (call) => ({
    label: str(asInput(call.input).pattern) ?? call.name,
    elide: EElide.tail,
    ok: succeeded(call),
    ...measure(call, (n) => plural(n, 'match', 'matches')),
  }),
  heading: (rows) =>
    `Searched ${plural(rows.length, 'pattern')}${total(rows, 'match', 'matches')}${failures(rows)}`,
  phrase: (count) => `searched ${plural(count, 'pattern')}`,
};

export const WEB: ToolPresenter = {
  shape: EToolShape.gathering,
  view: (call) => ({ name: call.name, target: webTarget(call), command: [] }),
  row: (call) => ({
    label: webTarget(call) ?? call.name,
    elide: EElide.tail,
    ok: succeeded(call),
    ...measure(call, (n) => `${formatCount(n)} l`),
  }),
  heading: (rows) => `Fetched ${plural(rows.length, 'page')}${failures(rows)}`,
  phrase: (count) => `fetched ${plural(count, 'page')}`,
};

/**
 * Everything nobody wrote a presenter for. Standalone, because an unclassified tool is one nobody has
 * thought about, and absorbing it silently into a group is the wrong way to find that out.
 */
export const STANDALONE: ToolPresenter = {
  shape: EToolShape.standalone,
  view: (call) => ({
    name: displayToolName(call.name),
    target: toolTarget(call.name, call.input, call.cwd),
    command: [],
  }),
  row: (call) => ({
    label: toolTarget(call.name, call.input, call.cwd) ?? displayToolName(call.name),
    elide: EElide.tail,
    ok: succeeded(call),
    // No arithmetic to do, so the row borrows the summary the engine already wrote. Clipped hard:
    // this column is a glance, and `Updated with 6 additions and 1 removal` is a sentence.
    ...(call.result === undefined
      ? {}
      : { note: call.result.ok ? clip(call.result.summary, 22) : 'failed' }),
  }),
  heading: (rows) => plural(rows.length, 'call'),
  phrase: (count) => `made ${plural(count, 'call')}`,
};

/**
 * The rule, written out. Anything absent is `standalone` — including every `mcp__*` tool Atlas bridges
 * in, which are structural moves (`advance_phase`, `open_thread`) and each worth a block.
 *
 * The standalone entries below have no presenter of their own and could be omitted for the same
 * result. Naming them is the documentation that somebody DECIDED, rather than that nobody had heard
 * of them.
 */
export const PRESENTERS: ReadonlyMap<string, ToolPresenter> = new Map<string, ToolPresenter>([
  // gathering — these group with each other when adjacent
  ['Read', READ],
  ['NotebookRead', READ],
  ['Bash', BASH],
  ['Grep', SEARCH],
  ['Glob', SEARCH],
  ['WebFetch', WEB],
  ['WebSearch', WEB],
  // standalone — each keeps its own block and breaks the group around it
  ['Write', STANDALONE],
  ['Edit', STANDALONE],
  ['MultiEdit', STANDALONE],
  ['NotebookEdit', STANDALONE],
  ['Agent', STANDALONE],
  ['Task', STANDALONE],
  ['TodoWrite', STANDALONE],
  ['Skill', STANDALONE],
]);


function succeeded(call: ToolCall): boolean {
  // A call still running has not failed. Red until its result lands would flash every tool block
  // through an error state on the way to succeeding.
  return call.result?.ok ?? true;
}

function filePath(call: ToolCall): string | undefined {
  const input = asInput(call.input);
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  return path === undefined ? undefined : relativise(path, call.cwd);
}

function webTarget(call: ToolCall): string | undefined {
  const input = asInput(call.input);
  return str(input.url) ?? str(input.query);
}

function commandLabel(call: ToolCall): string {
  const input = asInput(call.input);
  // `BashInput.description` — the SDK asks the model for "a clear, concise description of what this
  // command does in active voice" on every Bash call, and it is the one field in the payload written
  // to be READ. Measured over a real transcript: 89 of 89 Bash calls carried one.
  const description = str(input.description);
  if (description !== undefined) return description;
  const command = str(input.command);
  if (command === undefined) return displayToolName(call.name);
  const first = command.split('\n')[0] ?? '';
  return clip(command.includes('\n') ? `${first} …` : first, COMMAND_MAX);
}

function commandLines(call: ToolCall): string[] {
  const command = str(asInput(call.input).command);
  if (command === undefined) return [];
  // Nothing is gained by repeating a one-line command the header already shows verbatim.
  if (command === commandLabel(call)) return [];
  return command.split('\n');
}

function measure(
  call: ToolCall,
  note: (count: number) => string,
): Pick<ToolRow, 'note' | 'metric'> {
  const result = call.result;
  if (result === undefined) return {};
  // A failed call has no measure worth reporting — `0 l` beside a path reads as "an empty file".
  if (!result.ok) return { note: 'failed' };
  const count = countLines(result.detail);
  return { note: note(count), metric: count };
}

