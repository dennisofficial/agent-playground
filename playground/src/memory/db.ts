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
      scope          TEXT NOT NULL,                 -- access tier: company:<id> | bot:<id> | pair:<bot>:<human>
      asserted_by    TEXT,                          -- who stated it (provenance)
      source_surface TEXT,                          -- where it was stated (provenance)
      confidence     REAL NOT NULL DEFAULT 1.0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      deleted_at     TEXT                           -- soft-delete tombstone (never hard-delete human facts)
    );
    CREATE INDEX IF NOT EXISTS facts_scope ON facts(scope);

    CREATE TABLE IF NOT EXISTS worklog (
      id           INTEGER PRIMARY KEY,
      owner_bot    TEXT NOT NULL,                 -- which bot did the work
      company      TEXT NOT NULL,                 -- the project/workspace it belongs to (isolation)
      task         TEXT NOT NULL,
      summary      TEXT NOT NULL,                 -- the worker's report digest
      completed_at TEXT NOT NULL                  -- ISO timestamp (the "when" a standup asks for)
    );
    CREATE INDEX IF NOT EXISTS worklog_lookup ON worklog(company, owner_bot, completed_at);

    -- The internal task board: open handoffs/todos the reflect pass captures, so a commitment made in
    -- passing ("you'll add tracking hooks once the API's up") doesn't get lost. Worklog is "what got
    -- done"; this is "what still needs doing". Company-scoped, plain SQL (no embeddings).
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY,
      company     TEXT NOT NULL,                  -- workspace isolation (multi-project)
      description TEXT NOT NULL,                  -- "Add analytics/tracking hooks to the API + worker"
      norm        TEXT NOT NULL,                  -- normalized description (lowercased, ws-collapsed) — dedup key
      assignee    TEXT,                           -- bot/human id the task is for; null = unassigned
      created_by  TEXT,                           -- who raised it (bot id)
      status      TEXT NOT NULL DEFAULT 'open',   -- open | done | dropped
      source      TEXT,                           -- provenance (surface/turn)
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_lookup ON tasks(company, status, assignee);
    -- DB-enforced dedup: at most one OPEN task per (company, normalized description), so two concurrent
    -- bots reflecting on the same handoff can't both insert it (INSERT … ON CONFLICT DO NOTHING).
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_open_uniq ON tasks(company, norm) WHERE status = 'open';
  `);
}
