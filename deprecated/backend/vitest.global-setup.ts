import { config } from '@dotenvx/dotenvx';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Client } from 'pg';

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

  // `migrate deploy` rather than `dev`: it applies the committed migrations and never prompts or
  // reshapes the schema, which is what a CI/test bootstrap wants. The POSTGRES_* overrides below
  // point prisma.config.ts at the freshly created test database rather than the dev one.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, POSTGRES_DB: db },
  });

  await provisionMcpRoles({ ...conn, database: db });
}

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
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_reader`,
    );
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
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mcp_writer`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mcp_writer`,
    );
    await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO mcp_writer`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO mcp_writer`,
    );
    // `prod_maintenance_write` is an infra-provisioned audit ledger (infra/mcp-writer-role.sql), not a
    // migrated table — a freshly-created *_test DB won't have it. Guard the REVOKE so the harness still
    // provisions cleanly when it's absent; where it does exist (prod), the tamper protection still applies.
    const ledger = await client.query(`SELECT to_regclass('public.prod_maintenance_write') AS t`);
    if (ledger.rows[0].t) {
      await client.query(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON prod_maintenance_write FROM mcp_writer`,
      );
    }
    await client.query(`ALTER ROLE mcp_writer SET statement_timeout = '15s'`);
    console.log(
      '[global-setup] provisioned mcp_reader (SELECT-only) + mcp_writer (DML-only) roles',
    );
  } finally {
    await client.end();
  }
}
