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

  // Atlas v2 owns its datasource ('atlas') with its own `app` tables + migration history
  // (`migrations/`, bookkept in `atlas_migrations`). Stand it up so the Atlas boot int test
  // — which boots the full Atlas DI graph and reconciles in-flight jobs on bootstrap — runs against the
  // real schema, not a missing-table error. The migrations run via the same CLI path as
  // `pnpm db:atlas:migrate`, minus env:inject (which would load the DEV env — this child inherits
  // our already-loaded test env instead). The CLI's ts-node hook is what loads the .ts migration
  // files; TypeORM can't require them from this vite-node context. Idempotent: only pending
  // atlas migrations run.
  execFileSync(
    'pnpm',
    ['exec', 'typeorm-ts-node-commonjs', 'migration:run', '-d', 'cli/data-source.ts'],
    {
      cwd: __dirname,
      stdio: 'inherit',
      env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.cli.json' },
    },
  );

  await provisionMcpRoles({ ...conn, database: db });
}

/**
 * Provision the two dedicated diagnostics DB roles on the test database with the SAME least-privilege
 * grants the `infra/mcp-{reader,writer}-role.sql` files apply in prod, so the backend thread's integration
 * tests exercise the REAL role restrictions (a `mcp_reader` that genuinely rejects an UPDATE; a `mcp_writer`
 * that genuinely can't DDL and can't touch its own audit ledger) — not a mock. Runs AFTER migrate so the
 * blanket grants cover every table and the audit-ledger REVOKE finds `prod_maintenance_write`. Idempotent:
 * roles are cluster-global, so re-create only if absent; grants are always re-applied. `MCP_*_PG_*` in
 * `.env.test.enc` point the pools at these roles with the fixed test password.
 */
async function provisionMcpRoles(conn: {
  host?: string;
  port: number;
  user?: string;
  password?: string;
  database: string;
}): Promise<void> {
  const client = new Client(conn);
  await client.connect();
  try {
    // mcp_reader — SELECT-only (mirrors infra/mcp-reader-role.sql).
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
        CREATE ROLE mcp_reader LOGIN PASSWORD 'test';
      END IF;
    END $$;`);
    await client.query(`ALTER ROLE mcp_reader WITH LOGIN PASSWORD 'test'`);
    await client.query(`GRANT CONNECT ON DATABASE "${conn.database}" TO mcp_reader`);
    await client.query(`GRANT USAGE ON SCHEMA public TO mcp_reader`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_reader`);
    await client.query(`ALTER ROLE mcp_reader SET statement_timeout = '10s'`);

    // mcp_writer — DML-only (mirrors infra/mcp-writer-role.sql): no DDL, and REVOKEd on the audit ledger.
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_writer') THEN
        CREATE ROLE mcp_writer LOGIN PASSWORD 'test';
      END IF;
    END $$;`);
    await client.query(`ALTER ROLE mcp_writer WITH LOGIN PASSWORD 'test'`);
    await client.query(`GRANT CONNECT ON DATABASE "${conn.database}" TO mcp_writer`);
    await client.query(`GRANT USAGE ON SCHEMA public TO mcp_writer`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mcp_writer`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mcp_writer`,
    );
    await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO mcp_writer`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO mcp_writer`);
    await client.query(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON prod_maintenance_write FROM mcp_writer`,
    );
    await client.query(`ALTER ROLE mcp_writer SET statement_timeout = '15s'`);
    console.log('[global-setup] provisioned mcp_reader (SELECT-only) + mcp_writer (DML-only) roles');
  } finally {
    await client.end();
  }
}
