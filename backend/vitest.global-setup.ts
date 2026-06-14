import { config } from '@dotenvx/dotenvx';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Client } from 'pg';

/**
 * Vitest globalSetup (default + e2e modes): provision the dedicated test database.
 * Runs ONCE per test run, before any worker. Creates POSTGRES_DB if missing and brings
 * it to the current migration state (the init migration creates the pgvector extension).
 * setupFiles don't apply here (separate context), so the env loads itself — same
 * layering as vitest.setup.ts, which also re-asserts the *_test guard in every worker.
 */
export default async function globalSetup(): Promise<void> {
  if (existsSync('.env.personal')) {
    config({ path: '.env.personal', logLevel: 'error', overload: true });
  }
  config({ path: '.env.test.enc', strict: true, logLevel: 'error', overload: true });

  const db = process.env.POSTGRES_DB;
  if (!db?.endsWith('_test')) {
    throw new Error(
      `Refusing to provision "${db ?? ''}": tests only run against a *_test database.`,
    );
  }

  const conn = {
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  };

  // CREATE DATABASE can't run inside a transaction or against the target DB — go through
  // the maintenance DB. No IF NOT EXISTS for databases; check pg_database instead.
  const admin = new Client({ ...conn, database: 'postgres' });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${db}"`);
      console.log(`[global-setup] created test database "${db}"`);
    }
  } finally {
    await admin.end();
  }

  // Migrations via the same CLI path as `pnpm db:migrate`, minus env:inject (which would
  // load the DEV env — this child inherits our already-loaded test env instead). The CLI's
  // ts-node hook is what loads the .ts migration files; TypeORM can't require them from
  // this vite-node context. Idempotent: only pending migrations run.
  execFileSync(
    'pnpm',
    ['exec', 'typeorm-ts-node-commonjs', 'migration:run', '-d', 'cli/data-source.ts'],
    {
      cwd: __dirname,
      stdio: 'inherit',
      env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.cli.json' },
    },
  );
}
