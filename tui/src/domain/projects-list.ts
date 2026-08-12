import { affords, elasticColumn } from './list-columns.js';

/**
 * `  ▸ ` + `● `, and the trailing state — `⚠ path missing` is the widest thing that can land there.
 * The dot arrived with the two attention channels, and costs the same two cells every list pays.
 */
export const GUTTER = 6;
const TAIL = 15;
const MARGIN = 2;
const NAME = { min: 12, max: 28 };
const PATH = { min: 16, max: 52 };

export type ProjectsLayout = { name: number; path: number };

export function projectsLayout(width: number): ProjectsLayout {
  const room = Math.max(0, width - GUTTER - TAIL - MARGIN);
  // The name grows only while the path can still keep its minimum; past that they share.
  const name = elasticColumn(room, PATH.min, NAME);
  if (!affords(room, name, PATH.min)) {
    return { name: elasticColumn(room, 0, { min: 8, max: 40 }), path: 0 };
  }
  return { name, path: elasticColumn(room, name, PATH) };
}

/** The confirm has to say what actually goes — and, just as importantly, what does not. */
export function removalCost(jobCount: number): string {
  const jobs =
    jobCount === 0 ? 'no jobs to lose' : `${jobLabel(jobCount)} and their transcripts go with it`;
  return `${jobs} · the folder on disk is untouched`;
}

export function jobLabel(count: number): string {
  if (count === 0) return '—';
  return count === 1 ? '1 job' : `${count} jobs`;
}

/**
 * `~/Developer/atlas`. `home` is passed in rather than read from the environment so the function
 * stays pure — a path column that changes shape with the ambient env is untestable, and the caller
 * already knows which home it means.
 */
export function shortenHome(args: { path: string; home: string }): string {
  const { path, home } = args;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
