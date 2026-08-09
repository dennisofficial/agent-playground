/**
 * The tool-call surface is the only checkpoint where the two SDKs must agree: a Claude turn and a
 * Codex turn that do the same work have to render byte-identically here. Hence pure and tested.
 */

type Input = Record<string, unknown>;

function asInput(input: unknown): Input {
  return input && typeof input === 'object' ? (input as Input) : {};
}

function str(value: unknown): string | undefined {
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

export type ResultSummary = { summary: string; detail: string[] };

/**
 * The headline is a claim about what happened rather than the first line of output — "Read 210
 * lines" beats echoing the file's first line back at the reader.
 */
export function summariseToolResult(args: {
  name: string;
  input: unknown;
  lines: string[];
  ok: boolean;
}): ResultSummary {
  const { name, input, lines, ok } = args;
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
      const path = str(asInput(input).file_path);
      return { summary: path ? `Wrote ${countLines(lines)} lines` : 'Wrote file', detail: lines };
    }
    case 'Edit':
    case 'Update':
    case 'MultiEdit':
    case 'NotebookEdit': {
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

function countLines(lines: string[]): number {
  // A trailing newline yields a final empty element that is not a line of content.
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
