import { parsePatch } from 'diff';

export type JobDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export type JobDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type JobDiffFile = {
  path: string;
  oldPath?: string;
  status: JobDiffStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: JobDiffHunk[];
};

export type JobDiff = { files: JobDiffFile[]; truncated: boolean };

export type JobDiffNumstatEntry = {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type JobDiffNameStatusEntry = {
  path: string;
  oldPath?: string;
  status: JobDiffStatus;
};

export type JobDiffSummaryFile = JobDiffNumstatEntry &
  Pick<JobDiffNameStatusEntry, 'status' | 'oldPath'>;

export type JobDiffSummary = { files: JobDiffSummaryFile[] };

export function buildDiffSummary(
  numstat: JobDiffNumstatEntry[],
  nameStatus: JobDiffNameStatusEntry[] = [],
): JobDiffSummary {
  const statusByPath = new Map(nameStatus.map((entry) => [entry.path, entry]));
  return {
    files: numstat.map((entry) => {
      const status = statusByPath.get(entry.path);
      return {
        ...entry,
        ...(status?.oldPath ? { oldPath: status.oldPath } : {}),
        status: status?.status ?? 'modified',
      };
    }),
  };
}

function stripDiffPrefix(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (name.startsWith('a/') || name.startsWith('b/')) return name.slice(2);
  return name;
}

function countSignLines(hunks: { lines: string[] }[]): {
  additions: number;
  deletions: number;
} {
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

export function parseGitDiff(
  raw: string,
  numstat: JobDiffNumstatEntry[],
  opts: { maxBytes: number },
): JobDiff {
  const numstatByPath = new Map(numstat.map((entry) => [entry.path, entry]));
  const truncated = raw.length > opts.maxBytes;

  const files: JobDiffFile[] = parsePatch(raw).map((patch) => {
    const strippedOld = stripDiffPrefix(patch.oldFileName);
    const strippedNew = stripDiffPrefix(patch.newFileName);
    const isAdded = strippedOld === undefined || strippedOld === '/dev/null';
    const isDeleted = strippedNew === undefined || strippedNew === '/dev/null';
    const isRenamed = !isAdded && !isDeleted && strippedOld !== strippedNew;
    const status: JobDiffStatus = isAdded
      ? 'added'
      : isDeleted
        ? 'deleted'
        : isRenamed
          ? 'renamed'
          : 'modified';
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
