import { diffLines } from 'diff';
import { asRecord, str } from './util';

/**
 * Added/removed line counts for a file-edit tool call.
 *
 * `removed` is `null` when it can't be known (a `Write` to a file we never saw the prior contents of —
 * we know how many lines went in, not how many were replaced).
 */
export interface DiffStat {
  added: number;
  removed: number | null;
}

const isEditName = (n: string) => ['edit', 'multiedit'].includes(n.toLowerCase());
const isWriteName = (n: string) => ['write', 'notebookedit'].includes(n.toLowerCase());

function diffPair(oldStr: string, newStr: string): DiffStat {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldStr, newStr)) {
    const n = part.count ?? part.value.split('\n').length;
    if (part.added) added += n;
    else if (part.removed) removed += n;
  }
  return { added, removed };
}

/**
 * The exact diffstat if the tool RESULT carries one (Claude Code's Edit/Write results can include a
 * `structuredPatch` or unified `gitDiff`), else `null` so the caller computes from the input.
 */
function statFromResult(result: unknown): DiffStat | null {
  const rec = asRecord(result);

  // structuredPatch: { hunks: [{ lines: ['+a', '-b', ' c'] }] }
  const hunks =
    (rec.structuredPatch as { hunks?: Array<{ lines?: string[] }> } | undefined)?.hunks ??
    rec.hunks;
  if (Array.isArray(hunks)) {
    let added = 0;
    let removed = 0;
    for (const h of hunks as Array<{ lines?: string[] }>) {
      for (const line of h.lines ?? []) {
        if (line.startsWith('+')) added += 1;
        else if (line.startsWith('-')) removed += 1;
      }
    }
    return { added, removed };
  }

  // gitDiff: a unified-diff string.
  const gitDiff = typeof rec.gitDiff === 'string' ? rec.gitDiff : null;
  if (gitDiff) {
    let added = 0;
    let removed = 0;
    for (const line of gitDiff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
    }
    return { added, removed };
  }

  return null;
}

/**
 * Compute the +/- line counts for an edit-family tool call. Prefers an exact patch on the result;
 * otherwise diffs the input (`old_string`→`new_string`, summed across MultiEdit `edits`). Returns
 * `null` for non-edit tools.
 */
export function editDiffstat(name: string, input: unknown, result?: unknown): DiffStat | null {
  if (!isEditName(name) && !isWriteName(name)) return null;

  const fromResult = statFromResult(result);
  if (fromResult) return fromResult;

  const inp = asRecord(input);

  if (isWriteName(name)) {
    // We have the new content but not the prior file — count added lines, leave removed unknown.
    const content = str(inp.content ?? inp.new_string);
    if (!content) return null;
    return {
      added: content.replace(/\n$/, '').split('\n').length,
      removed: null,
    };
  }

  // MultiEdit: sum over each edit. Edit: a single old → new pair.
  const edits = Array.isArray(inp.edits)
    ? (inp.edits as unknown[])
    : [{ old_string: inp.old_string, new_string: inp.new_string }];

  let added = 0;
  let removed = 0;
  let sawAny = false;
  for (const e of edits) {
    const rec = asRecord(e);
    const oldStr = str(rec.old_string);
    const newStr = str(rec.new_string);
    if (!oldStr && !newStr) continue;
    sawAny = true;
    const s = diffPair(oldStr, newStr);
    added += s.added;
    removed += s.removed ?? 0;
  }
  return sawAny ? { added, removed } : null;
}
