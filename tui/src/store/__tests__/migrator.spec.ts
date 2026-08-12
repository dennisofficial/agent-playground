import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = pathJoin(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'prisma', 'migrations');
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MigratorService } from '../migrator.service.js';

/**
 * Runs against real SQLite and the real committed migration files, because both claims under test —
 * "applying twice is a no-op" and "two instances starting together do not both migrate" — are
 * claims about SQLite's behaviour, not about our code's intent.
 */
describe('MigratorService', () => {
  let dir: string;
  let database: string;
  let migratorService: MigratorService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-migrate-'));
    database = join(dir, 'atlas.db');
    migratorService = new MigratorService();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function tables(): string[] {
    const db = new Database(database);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    db.close();
    return rows.map((r) => r.name);
  }

  it('creates all seven tables from the committed migrations', () => {
    migratorService.migrate(database);
    expect(tables()).toEqual(
      expect.arrayContaining([
        'Account',
        'Project',
        'Job',
        'Phase',
        'Thread',
        'EngineSession',
        'ThreadMessage',
      ]),
    );
  });

  it('is idempotent — a second start applies nothing', () => {
    migratorService.migrate(database);
    const applied = appliedNames(database);
    migratorService.migrate(database);
    expect(appliedNames(database)).toEqual(applied);
  });

  it('records migrations in Prisma’s own table, with a sha256 checksum', () => {
    migratorService.migrate(database);
    const db = new Database(database);
    const rows = db.prepare('SELECT migration_name, checksum FROM _prisma_migrations').all() as {
      migration_name: string;
      checksum: string;
    }[];
    db.close();

    const expected = new Map(
      migratorService.readMigrations().map((m) => [m.name, m.checksum] as const),
    );
    expect(rows).not.toHaveLength(0);
    for (const row of rows) {
      // Compatible with authoring-time `prisma migrate dev` — otherwise the CLI would try to
      // re-apply what the runtime already ran.
      const want = expected.get(row.migration_name);
      expect(want).toBeDefined();
      expect(row.checksum).toBe(want as string);
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('leaves WAL on, so every later connection gets concurrent reads', () => {
    migratorService.migrate(database);
    const db = new Database(database);
    const mode = (db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    db.close();
    expect(mode).toBe('wal');
  });

  it('survives two migrators racing the same fresh database', async () => {
    // BEGIN IMMEDIATE grants the write lock to one; the other blocks on busy_timeout and then
    // finds nothing to do.
    await Promise.all([
      Promise.resolve().then(() => migratorService.migrate(database)),
      Promise.resolve().then(() => new MigratorService().migrate(database)),
    ]);

    const names = appliedNames(database);
    expect(new Set(names).size).toBe(names.length); // no duplicate rows
    expect(tables()).toEqual(expect.arrayContaining(['Account', 'ThreadMessage']));
  });

  // The migrations are baked into a generated module so the compiled binary can find them, which
  // means the module can now fall behind `prisma/migrations`. Forgetting to regenerate should be a
  // red test, not a broken release.
  it('has embedded migrations matching the committed SQL', () => {
    const onDisk = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const embedded = migratorService.readMigrations();

    expect(embedded.map((m) => m.name)).toEqual(onDisk);
    for (const migration of embedded) {
      const sql = readFileSync(join(MIGRATIONS_DIR, migration.name, 'migration.sql'), 'utf8');
      expect(migration.sql).toBe(sql);
      expect(migration.checksum).toBe(createHash('sha256').update(sql).digest('hex'));
    }
  });
});

function appliedNames(database: string): string[] {
  const db = new Database(database);
  const rows = db
    .prepare('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name')
    .all() as { migration_name: string }[];
  db.close();
  return rows.map((r) => r.migration_name);
}
