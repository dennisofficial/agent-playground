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

/**
 * Idempotent `ALTER TABLE … ADD COLUMN` — SQLite has no `ADD COLUMN IF NOT EXISTS`, so we check
 * `PRAGMA table_info` first. Lets migrations evolve a table additively across restarts without a
 * version table. `decl` is the column definition minus the name (e.g. "TEXT NOT NULL DEFAULT ''").
 */
export function addColumnIfMissing(
  d: Database.Database,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id             INTEGER PRIMARY KEY,
      fact           TEXT NOT NULL,
      embedding      TEXT NOT NULL,                 -- JSON float[] (text-embedding-3-small, 1536d)
      scope          TEXT NOT NULL,                 -- access tier: team:<id> | project:<id> | bot:<id> | pair:<bot>:<human>
      asserted_by    TEXT,                          -- who stated it (provenance)
      source_surface TEXT,                          -- where it was stated (provenance)
      confidence     REAL NOT NULL DEFAULT 1.0,
      embed_model    TEXT,                          -- which embedding model produced the vector (re-embed detection)
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      deleted_at     TEXT                           -- soft-delete tombstone (never hard-delete human facts)
    );
    CREATE INDEX IF NOT EXISTS facts_scope ON facts(scope);

    CREATE TABLE IF NOT EXISTS worklog (
      id           INTEGER PRIMARY KEY,
      owner_bot    TEXT NOT NULL,                 -- which bot did the work
      project      TEXT NOT NULL,                 -- the project/workspace it belongs to (isolation)
      task         TEXT NOT NULL,
      summary      TEXT NOT NULL,                 -- the worker's report digest
      completed_at TEXT NOT NULL                  -- ISO timestamp (the "when" a standup asks for)
    );
    CREATE INDEX IF NOT EXISTS worklog_lookup ON worklog(project, owner_bot, completed_at);

    -- Per-employee REMINDERS (the "plate"): a commitment made in passing ("got it, I'll do that after I
    -- finish this") that a long, rolling-summarized work session would otherwise drop. Each reminder sits
    -- on exactly ONE employee's plate (owner NOT NULL — no unassigned reminders; unassigned IDEAS live on
    -- the Jira board, not here). Sibling to the worklog ("what got done"). Project-scoped, plain SQL.
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY,
      project     TEXT NOT NULL,                  -- workspace isolation (multi-project)
      description TEXT NOT NULL,                  -- "Wire the tracking hooks once the API is up"
      norm        TEXT NOT NULL,                  -- normalized description (lowercased, ws-collapsed) — dedup key
      owner       TEXT NOT NULL DEFAULT '',       -- whose plate (bot/human id); '' only as a transient pre-backfill default
      assignee    TEXT,                           -- legacy/compat column (superseded by owner); unused
      created_by  TEXT,                           -- who raised it (self-commitment: == owner; handoff: the raiser)
      status      TEXT NOT NULL DEFAULT 'open',   -- open | done | dropped
      source      TEXT,                           -- provenance (surface/turn)
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `);

  // Additive column migrations for DBs created before a column existed (no-op on fresh DBs, which
  // already have these from the CREATE TABLE above).
  addColumnIfMissing(d, 'facts', 'embed_model', 'TEXT');

  // worklog company→project rename was missing a migration. RENAME (not ADD COLUMN) preserves
  // historical row values. SQLite auto-updates the worklog_lookup index. No-op on fresh/already-migrated DBs.
  const worklogCols = (d.prepare(`PRAGMA table_info(worklog)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (worklogCols.includes('company') && !worklogCols.includes('project')) {
    d.exec(`ALTER TABLE worklog RENAME COLUMN company TO project`);
  }

  // Reminders evolve the legacy `tasks` board into a per-employee plate. Be ROBUST on any prior shape:
  // a fresh table (already `project` + `owner`), a pre-rename table (`company`), or a partially-migrated
  // one — never throw here, or a stale DB crashes startup.
  const taskCols = (d.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  // Align a pre-rename table with the project model (the company→project rename shipped no data migration).
  if (taskCols.includes('company') && !taskCols.includes('project')) {
    d.exec(`ALTER TABLE tasks RENAME COLUMN company TO project`);
  }
  // Per-employee `owner` (adds with a '' default on an existing table; backfill from legacy assignee/created_by).
  addColumnIfMissing(d, 'tasks', 'owner', "TEXT NOT NULL DEFAULT ''");
  d.exec(`
    UPDATE tasks SET owner = COALESCE(NULLIF(assignee, ''), NULLIF(created_by, ''), 'unassigned')
      WHERE owner IS NULL OR owner = '';
    -- Open-dedup is now PER-OWNER (project, owner, norm): the old (project, norm) index wrongly collapsed
    -- two people's identical-sounding reminders into one. owner is NOT NULL, so there's no NULL-distinct hole.
    DROP INDEX IF EXISTS tasks_open_uniq;
    DROP INDEX IF EXISTS tasks_lookup;
    CREATE INDEX IF NOT EXISTS tasks_lookup ON tasks(project, status, owner);
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_plate_open_uniq ON tasks(project, owner, norm) WHERE status = 'open';
  `);
}
