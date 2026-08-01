/**
 * - `PER_THREAD` — a fresh copy per thread/worktree (isolated, writable).
 * - `SHARED_RO`  — one shared mount across threads, read-only (e.g. a model/cache dir).
 * - `SHARED_RW`  — one shared mount across threads, read-write (e.g. a package store).
 */
export enum EMountMode {
  PER_THREAD = 'per_thread',
  SHARED_RO = 'shared_ro',
  SHARED_RW = 'shared_rw',
}
