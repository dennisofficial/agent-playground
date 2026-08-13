/**
 * The words and numbers a tool block is written in.
 *
 * Split out because `tool-view.ts` and `tool-presenters.ts` both need them and neither can own them:
 * a presenter phrases its own clause, and the heading that joins those clauses adds up their rows.
 */

/** `mcp__atlas__advance_phase` → `advance_phase`. The bridge prefix is noise in a transcript. */
export function displayToolName(name: string): string {
  const parts = name.split('__');
  return parts.length > 1 ? (parts.at(-1) ?? name) : name;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `1,247` — a count is a sense of scale, and four unseparated digits is not one. */
export function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

/** ` · 1,247 lines`, or nothing when no row reported a measure. */
export function total(
  rows: readonly { metric?: number }[],
  singular: string,
  pluralForm = `${singular}s`,
): string {
  const sum = rows.reduce((running, row) => running + (row.metric ?? 0), 0);
  return sum > 0 ? ` · ${plural(sum, singular, pluralForm)}` : '';
}

/** A failure inside a group has to reach the heading — its row may be six lines down and dim. */
export function failures(rows: readonly { ok: boolean }[]): string {
  const failed = rows.filter((row) => !row.ok).length;
  return failed > 0 ? ` · ${failed} failed` : '';
}
