import { parsePatch } from 'diff';

export type JobDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export type JobDiffFile = {
  /** post-rename, repo-relative POSIX path (`a/`/`b/` prefixes stripped). */
  path: string;
  /** set only when the file was renamed. */
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  additions: number;
  deletions: number;
  /** [] for binary files or when the whole diff was too large to parse (see `truncated`). */
  hunks: JobDiffHunk[];
};

export type JobDiff = { files: JobDiffFile[]; truncated: boolean };

export type JobDiffNumstatEntry = { path: string; additions: number; deletions: number; binary: boolean };

export type JobDiffSummary = { files: JobDiffNumstatEntry[] };

/** Summary-only view (numstat, no hunks) for the sidebar's +/- totals. */
export function buildDiffSummary(numstat: JobDiffNumstatEntry[]): JobDiffSummary {
  return { files: numstat };
}

/** Strip a leading `a/` or `b/` diff prefix; `/dev/null` and undefined pass through unchanged. */
function stripDiffPrefix(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (name.startsWith('a/') || name.startsWith('b/')) return name.slice(2);
  return name;
}

function countSignLines(hunks: { lines: string[] }[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
  }
  return { additions, deletions };
}

/**
 * Parse a unified diff (as produced by `LocalGitService.diffFromMergeBase`) into the structured shape
 * the diff-viewer frontend consumes, joining in per-file counts/binary-ness from `git diff --numstat`
 * (the authoritative source — parsing `+`/`-` lines is only a fallback for entries numstat didn't cover,
 * e.g. a pure rename with no content change).
 */
export function parseGitDiff(raw: string, numstat: JobDiffNumstatEntry[], opts: { maxBytes: number }): JobDiff {
  const numstatByPath = new Map(numstat.map((entry) => [entry.path, entry]));
  // Simplest safe cap for v1: an oversized diff still reports every file's header/counts, just no hunks.
  const truncated = raw.length > opts.maxBytes;

  const files: JobDiffFile[] = parsePatch(raw).map((patch) => {
    const strippedOld = stripDiffPrefix(patch.oldFileName);
    const strippedNew = stripDiffPrefix(patch.newFileName);
    const isAdded = strippedOld === undefined || strippedOld === '/dev/null';
    const isDeleted = strippedNew === undefined || strippedNew === '/dev/null';
    const isRenamed = !isAdded && !isDeleted && strippedOld !== strippedNew;
    const status: JobDiffFile['status'] = isAdded ? 'added' : isDeleted ? 'deleted' : isRenamed ? 'renamed' : 'modified';
    const path = (status === 'deleted' ? strippedOld : strippedNew) ?? '';

    const numstatEntry = numstatByPath.get(path);
    const binary = numstatEntry?.binary ?? patch.isBinary ?? false;
    const { additions, deletions } = numstatEntry
      ? { additions: numstatEntry.additions, deletions: numstatEntry.deletions }
      : countSignLines(patch.hunks);

    const hunks: JobDiffHunk[] =
      binary || truncated
        ? []
        : patch.hunks.map((hunk) => ({
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            lines: [...hunk.lines],
          }));

    return {
      path,
      ...(status === 'renamed' ? { oldPath: strippedOld } : {}),
      status,
      binary,
      additions,
      deletions,
      hunks,
    };
  });

  return { files, truncated };
}
