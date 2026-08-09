import { Injectable, Logger } from '@nestjs/common';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ATLAS_PATHS } from '../domain/paths.js';
import { EMBEDDED_MIGRATIONS } from './migrations.generated.js';
import { applyPragmas } from './pragmas.js';

/**
 * Applies pending migrations on EVERY start. The binary is self-installing — there is no manual
 * `db:migrate` step for the user.
 *
 * Prisma has no supported programmatic migrate API and shipping the Prisma CLI just to run
 * `migrate deploy` is a bad trade for a terminal app. So `prisma migrate dev` generates the SQL at
 * AUTHORING time, those files are committed, and this reads them back and applies the unapplied
 * ones through a raw `bun:sqlite` connection.
 *
 * It writes rows into Prisma's own `_prisma_migrations` table, with `checksum = sha256` of the
 * migration file — exactly what the CLI writes. That is what keeps authoring-time `migrate dev`
 * and runtime auto-migration from disagreeing about what has been applied.
 */

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                  TEXT PRIMARY KEY NOT NULL,
    "checksum"            TEXT NOT NULL,
    "finished_at"         DATETIME,
    "migration_name"      TEXT NOT NULL,
    "logs"                TEXT,
    "rolled_back_at"      DATETIME,
    "started_at"          DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
  )
`;

export type PendingMigration = { name: string; sql: string; checksum: string };

@Injectable()
export class MigratorService {
  private readonly logger = new Logger(MigratorService.name);

  /** Applies every unapplied migration. Safe to call concurrently from several processes. */
  migrate(databaseFile: string = ATLAS_PATHS.database): void {
    mkdirSync(dirname(databaseFile), { recursive: true });
    const db = new Database(databaseFile);
    try {
      applyPragmas(db);
      db.exec(MIGRATIONS_TABLE);
      this.applyPending(db);
    } finally {
      db.close();
    }
  }

  /**
   * The dangerous moment is two instances starting together. BEGIN IMMEDIATE takes the write lock
   * up front, so SQLite grants it to exactly one instance; the other blocks on `busy_timeout` and
   * by the time it proceeds the migrations are already recorded as applied and it finds nothing to
   * do. No lock file, no coordination protocol.
   */
  private applyPending(db: Database): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      const applied = new Set(
        db
          .prepare('SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL')
          .all()
          .map((row) => (row as { migration_name: string }).migration_name),
      );

      const pending = this.readMigrations().filter((m) => !applied.has(m.name));
      for (const migration of pending) {
        this.logger.log(`applying migration ${migration.name}`);
        // Greenfield: a failed migration is recoverable by deleting the DB, so fail loudly rather
        // than attempting repair. The rollback below leaves the database exactly as it was.
        db.exec(migration.sql);
        db.prepare(
          `INSERT INTO _prisma_migrations
             (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`,
        ).run(randomUUID(), migration.checksum, Date.now(), migration.name, Date.now());
      }
      db.exec('COMMIT');
      if (pending.length > 0) this.logger.log(`applied ${pending.length} migration(s)`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * The committed migrations, in lexical order — Prisma's timestamp prefix makes that correct.
   *
   * Read from a GENERATED module rather than from disk. `bun build --compile` produces a single
   * executable with no `prisma/` beside it, and `import.meta.url` inside one resolves to a virtual
   * path, so the old `readdirSync` found nothing and every compiled binary died on startup. Baking
   * the SQL in keeps dev and the shipped binary on one code path instead of giving the binary a
   * fallback nobody exercises until release.
   */
  readMigrations(): PendingMigration[] {
    return EMBEDDED_MIGRATIONS.map((m) => ({ ...m }));
  }
}
