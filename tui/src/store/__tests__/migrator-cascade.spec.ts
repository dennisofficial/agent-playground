import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MigratorService, type PendingMigration } from '../migrator.service.js';

/**
 * The migration that ate every transcript in the database, as a test.
 *
 * Dropping one unused column from a parent table is written by Prisma as a table REBUILD, and the
 * `DROP TABLE` in the middle of it fires every `ON DELETE CASCADE` pointing at that table unless
 * foreign keys are off. `PRAGMA foreign_keys` is a no-op inside a transaction, so issuing it from
 * within the migration — which is exactly what Prisma's generated SQL does — silently does nothing.
 *
 * Nothing throws. The child rows are simply gone.
 */
const migration = (name: string, sql: string): PendingMigration => ({
  name,
  sql,
  checksum: createHash('sha256').update(sql).digest('hex'),
});

const SETUP = migration(
  '0001_init',
  `CREATE TABLE "Parent" ("id" TEXT PRIMARY KEY NOT NULL, "doomed" TEXT);
   CREATE TABLE "Child" (
     "id" TEXT PRIMARY KEY NOT NULL,
     "parentId" TEXT NOT NULL,
     CONSTRAINT "Child_parentId_fkey" FOREIGN KEY ("parentId")
       REFERENCES "Parent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
   );`,
);

/** Byte-for-byte the shape `prisma migrate dev` emits for a dropped column. */
const DROP_COLUMN = migration(
  '0002_drop_column',
  `PRAGMA defer_foreign_keys=ON;
   PRAGMA foreign_keys=OFF;
   CREATE TABLE "new_Parent" ("id" TEXT PRIMARY KEY NOT NULL);
   INSERT INTO "new_Parent" ("id") SELECT "id" FROM "Parent";
   DROP TABLE "Parent";
   ALTER TABLE "new_Parent" RENAME TO "Parent";
   PRAGMA foreign_keys=ON;
   PRAGMA defer_foreign_keys=OFF;`,
);

class Fake extends MigratorService {
  constructor(private readonly migrations: PendingMigration[]) {
    super();
  }
  override readMigrations(): PendingMigration[] {
    return this.migrations;
  }
}

const dirs: string[] = [];
const newDbFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-migrator-'));
  dirs.push(dir);
  return join(dir, 'atlas.db');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a table rebuild', () => {
  it('does not cascade-delete the children of the table it rebuilds', () => {
    const file = newDbFile();

    new Fake([SETUP]).migrate(file);
    const seed = new Database(file);
    seed.exec(`INSERT INTO "Parent" ("id", "doomed") VALUES ('p1', 'x');`);
    seed.exec(`INSERT INTO "Child" ("id", "parentId") VALUES ('c1', 'p1'), ('c2', 'p1');`);
    seed.close();

    new Fake([SETUP, DROP_COLUMN]).migrate(file);

    const db = new Database(file);
    const children = db.query('SELECT COUNT(*) c FROM "Child"').get() as { c: number };
    const parents = db.query('SELECT COUNT(*) c FROM "Parent"').get() as { c: number };
    db.close();

    expect(children.c).toBe(2);
    expect(parents.c).toBe(1);
  });

  it('leaves foreign keys enforced afterwards', () => {
    // Turning them off is a migration-time concession, not a new default — the app relies on
    // enforcement for every cascade it does mean.
    const file = newDbFile();
    new Fake([SETUP, DROP_COLUMN]).migrate(file);

    const db = new Database(file);
    db.exec('PRAGMA foreign_keys = ON');
    expect(() =>
      db.exec(`INSERT INTO "Child" ("id", "parentId") VALUES ('orphan', 'nobody');`),
    ).toThrow();
    db.close();
  });
});

describe('backups', () => {
  it('are only taken when there is something to apply', () => {
    // A no-op start must not copy the database. Atlas starts many times a day per terminal.
    const file = newDbFile();
    new Fake([SETUP]).migrate(file);
    expect(() => new Fake([SETUP]).migrate(file)).not.toThrow();
  });
});
