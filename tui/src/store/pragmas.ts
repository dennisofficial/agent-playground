import type { Database } from 'bun:sqlite';

/**
 * Several TUIs open at once is NORMAL, not an edge case.
 *
 * `journal_mode = WAL` is persistent — it lives in the database file header, so setting it once at
 * migration time covers every later connection, including Prisma's.
 *
 * `busy_timeout` is per-CONNECTION and is the one that is easy to forget. Without it a concurrent
 * writer throws SQLITE_BUSY immediately, which shows up as intermittent, hard-to-reproduce failures
 * under exactly the conditions that are hardest to reproduce. Prisma's adapter takes it as the
 * `timeout` option (see prisma.service.ts); this helper covers the raw connections.
 *
 * `bun:sqlite` has no `pragma()` helper the way better-sqlite3 did, so these go through `exec`.
 * Same statements, same persistence semantics.
 */
export const BUSY_TIMEOUT_MS = 5000;

export function applyPragmas(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // Prisma models relations with real FKs; SQLite leaves enforcement off unless asked.
  db.exec('PRAGMA foreign_keys = ON');
}
