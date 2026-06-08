import Database from 'better-sqlite3';
import { dataFile } from './paths.js';

/**
 * Zero's semantic-memory store: distilled facts about entities (people, teams, the company). Kept in
 * its own SQLite file, separate from the checkpointer's `checkpoints.db`, so a schema change in one
 * can't corrupt the other.
 *
 * v1 stores each fact's embedding as a JSON array in a TEXT column and ranks by cosine in JS — at
 * one-user scale that's instant and dependency-free. The `semantic.ts` interface is the abstraction
 * boundary, so a vector index (sqlite-vec) or Hindsight can drop in later without touching callers.
 */
let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;
  const handle = new Database(dataFile('zero.db'));
  handle.pragma('journal_mode = WAL');
  migrate(handle);
  db = handle;
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id             INTEGER PRIMARY KEY,
      fact           TEXT NOT NULL,
      embedding      TEXT NOT NULL,                 -- JSON float[] (text-embedding-3-small, 1536d)
      subject_scope  TEXT NOT NULL,                 -- WHO/WHAT it's about: person:<id> | team:<id> | company:<id> | global
      visibility     TEXT NOT NULL,                 -- WHO may surface it: 'private' | 'company'
      owner_agent    TEXT NOT NULL,                 -- which agent holds it
      asserted_by    TEXT,                          -- who stated it (provenance)
      source_surface TEXT,                          -- where it was stated (provenance, NOT a scope key)
      kind           TEXT NOT NULL DEFAULT 'work',  -- 'work' | 'personal'
      confidence     REAL NOT NULL DEFAULT 1.0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      deleted_at     TEXT                           -- soft-delete tombstone (never hard-delete human facts)
    );
    CREATE INDEX IF NOT EXISTS facts_subject ON facts(subject_scope);
  `);
}
